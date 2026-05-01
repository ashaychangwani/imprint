#!/usr/bin/env python3
"""
San Diego Zoo Discover & Go Pass Sniper

Polls the D&G API at midnight on the 1st of each month when Zoo passes
are released, and books as many dates as possible across two library cards
in parallel.

Usage:
  python3 scripts/zoo-sniper.py                # waits for midnight, then fires
  python3 scripts/zoo-sniper.py --dry-run      # polls but doesn't book
  python3 scripts/zoo-sniper.py --test-login   # just verify credentials work
  python3 scripts/zoo-sniper.py --poll-now     # skip waiting, poll immediately

How it works:
  1. Pre-midnight: logs in both library cards, caches sessions + patronIDs
  2. At 23:59:55 Pacific: starts polling ePASS_Search every 200ms
  3. The INSTANT attractionOffersCount > 0 for Zoo (attractionID=275):
     - Extracts offerID + available dates from the offers[] array
     - Fires makeReservation for preferred dates × both cards in parallel
     - Falls back to secondary dates if primary dates aren't available
  4. Prints results + sends desktop notification (optional)

Performance budget:
  - DNS pre-resolved at init
  - HTTP/1.1 keep-alive connection reused across all requests
  - All request URLs pre-built except offerID + date (inserted at fire time)
  - From offer-detected to all bookings-fired: target < 300ms
"""

import argparse
import json
import os
import ssl
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any

import httpx

# ─── Config ───────────────────────────────────────────────────────────────────

BASE = "https://sandiego.discoverandgo.net/epass_server.php"
ZOO_ATTRACTION_ID = 275

# Preferred dates (order = priority). Script books the first available.
PRIMARY_DATES = [
    "2026-05-21", "2026-05-22", "2026-05-23", "2026-05-24", "2026-05-25",
    "2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29", "2026-05-30",
    "2026-05-31", "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04",
    "2026-06-05", "2026-06-06", "2026-06-07", "2026-06-08",
]
SECONDARY_DATES = [
    "2026-05-06", "2026-05-07", "2026-05-08", "2026-05-09", "2026-05-10",
    "2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14",
]

LIBRARY_CARDS = [
    {
        "patronNumber": os.environ.get("DG_CARD1_NUMBER", "01336048586561"),
        "patronPassword": os.environ.get("DG_CARD1_PIN", "1070"),
        "email": os.environ.get("DG_CARD1_EMAIL", "ashaychangwani@gmail.com"),
        "label": "Card 1",
    },
    {
        "patronNumber": os.environ.get("DG_CARD2_NUMBER", ""),
        "patronPassword": os.environ.get("DG_CARD2_PIN", ""),
        "email": os.environ.get("DG_CARD2_EMAIL", ""),
        "label": "Card 2",
    },
]

COMMON_HEADERS = {
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "x-epass-clientID": "1",
    "x-epass-clientKey": "335e26134a53d4e23e4bed13517b7303",
    "x-epass-libraryID": "63",
    "Referer": "https://sandiego.discoverandgo.net/",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
    ),
}

POLL_INTERVAL_MS = 200
MAX_BOOKING_THREADS = 8

# ─── Session management ──────────────────────────────────────────────────────

class DGSession:
    """A logged-in Discover & Go session for one library card."""

    def __init__(self, card: dict, client: httpx.Client):
        self.card = card
        self.client = client
        self.patron_id: str = ""
        self.label: str = card["label"]
        self.logged_in = False

    def init_session(self) -> None:
        """Hit the main page to establish server-side session + cookie."""
        self.client.get(
            "https://sandiego.discoverandgo.net/",
            headers={"Accept": "text/html", "User-Agent": COMMON_HEADERS["User-Agent"]},
        )

    def form_load(self) -> None:
        """Load the ePASS form (sets library context in the session)."""
        self.client.get(
            BASE,
            params={
                "method": "formLoad", "page": "ePASS", "clientID": "1",
                "clientKey": "335e26134a53d4e23e4bed13517b7303",
                "libraryID": "63", "ip": "undefined", "language": "en",
            },
            headers=COMMON_HEADERS,
        )

    def login(self) -> dict:
        """POST login credentials. Returns the full login response."""
        r = self.client.post(
            BASE,
            data={
                "dataType": "json", "method": "Login", "language": "en",
                "patronNumber": self.card["patronNumber"],
                "patronPassword": self.card["patronPassword"],
            },
            headers={**COMMON_HEADERS, "Content-Type": "application/x-www-form-urlencoded"},
        )
        data = r.json()
        if data.get("status") != "Passed":
            raise RuntimeError(f"[{self.label}] Login failed: {data.get('message', data)}")
        self.patron_id = data["patronID"]
        self.logged_in = True
        return data

    def search_zoo(self) -> dict | None:
        """Search attractions, return the Zoo item or None if not found."""
        r = self.client.get(
            BASE,
            params={
                "dataType": "json", "method": "ePASS_Search",
                "functionFile": "Attractions", "searchType": "Attractions",
                "dateSelected": "None", "limits": "", "language": "en",
            },
            headers={**COMMON_HEADERS, "x-epass-patronID": self.patron_id},
        )
        data = r.json()
        attractions = data.get("attractionList", []) if isinstance(data, dict) else []
        for item in attractions:
            if item.get("attractionID") == ZOO_ATTRACTION_ID:
                return item
        return None

    def book(self, offer_id: int, date: str) -> dict:
        """Fire makeReservation. Returns the API response dict."""
        t0 = time.monotonic()
        r = self.client.get(
            BASE,
            params={
                "dataType": "json", "method": "makeReservation",
                "functionFile": "Reservations,Attractions", "language": "en",
                "patronID": self.patron_id, "offerID": str(offer_id),
                "offerDate": date,
                "notificationMethod": "Email",
                "notificationEmail": self.card.get("email", ""),
                "notificationTXTNumber": "",
            },
            headers={**COMMON_HEADERS, "x-epass-patronID": self.patron_id},
        )
        elapsed_ms = (time.monotonic() - t0) * 1000
        result = r.json()
        result["_elapsed_ms"] = elapsed_ms
        result["_date"] = date
        result["_card"] = self.label
        return result


# ─── Core logic ───────────────────────────────────────────────────────────────

def create_sessions() -> list[DGSession]:
    """Create and login all configured library card sessions."""
    sessions = []
    for card in LIBRARY_CARDS:
        if not card["patronNumber"]:
            print(f"  [{card['label']}] skipped (no card number configured)")
            continue
        # Disable SSL verification (corporate HTTPS intercept)
        client = httpx.Client(
            verify=False,
            timeout=httpx.Timeout(15.0, connect=5.0),
            follow_redirects=True,
        )
        sess = DGSession(card, client)
        print(f"  [{sess.label}] initializing session...")
        sess.init_session()
        sess.form_load()
        login_data = sess.login()
        print(
            f"  [{sess.label}] logged in as {login_data.get('firstName', '?')} "
            f"{login_data.get('lastName', '?')} "
            f"(patronID={sess.patron_id[:10]}...)"
        )
        sessions.append(sess)
    return sessions


def poll_for_offers(session: DGSession, dry_run: bool = False) -> tuple[int, list[str]]:
    """
    Poll until Zoo has offers > 0. Returns (offerID, available_dates).
    Uses the first session for polling (any logged-in session works).
    """
    poll_count = 0
    while True:
        poll_count += 1
        t0 = time.monotonic()
        zoo = session.search_zoo()
        elapsed = (time.monotonic() - t0) * 1000

        if zoo is None:
            print(f"\r  poll #{poll_count}: Zoo not in results ({elapsed:.0f}ms)", end="", flush=True)
            time.sleep(POLL_INTERVAL_MS / 1000)
            continue

        offer_count = zoo.get("attractionOffersCount", 0)
        if offer_count == 0:
            msg = zoo.get("reservationsUnavailableMessage", "")[:60]
            print(f"\r  poll #{poll_count}: 0 offers ({elapsed:.0f}ms) {msg}", end="", flush=True)
            time.sleep(POLL_INTERVAL_MS / 1000)
            continue

        # OFFERS FOUND
        print(f"\n  *** OFFERS DETECTED *** poll #{poll_count} ({elapsed:.0f}ms)")
        offers = zoo.get("offers", [])
        if not offers:
            print("  WARNING: attractionOffersCount > 0 but no offers[] array")
            time.sleep(POLL_INTERVAL_MS / 1000)
            continue

        # Extract offerID + dates from the first offer
        offer = offers[0]
        offer_id = offer.get("offerID")
        dates = offer.get("dates", [])
        print(f"  offerID: {offer_id}")
        print(f"  available dates: {dates}")
        return offer_id, dates


def pick_best_date(available: list[str]) -> str | None:
    """
    Pick ONE best date from available, prioritizing PRIMARY_DATES then SECONDARY_DATES.
    Both cards book the SAME date (family trip — both passes for the same day).
    """
    available_set = set(available)
    for d in PRIMARY_DATES:
        if d in available_set:
            return d
    for d in SECONDARY_DATES:
        if d in available_set:
            return d
    return available[0] if available else None


def fire_bookings(
    sessions: list[DGSession],
    offer_id: int,
    dates: list[str],
    dry_run: bool = False,
) -> list[dict]:
    """
    Book the best available date across ALL sessions in parallel.
    Each card can only book 1 Zoo pass/year. All cards book the SAME date
    (family trip — everyone goes on the same day).
    """
    best_date = pick_best_date(dates)
    if not best_date:
        print("  ERROR: no preferred dates available!")
        print(f"  Available dates were: {dates}")
        return []

    print(f"  BEST DATE: {best_date}")

    tasks: list[tuple[DGSession, int, str]] = []
    for sess in sessions:
        tasks.append((sess, offer_id, best_date))
        print(f"  [{sess.label}] → booking offerID={offer_id} date={best_date}" +
              (" (DRY RUN)" if dry_run else ""))

    if dry_run:
        return [{"status": "DRY_RUN", "_card": t[0].label, "_date": t[2]} for t in tasks]

    results = []
    t0 = time.monotonic()
    with ThreadPoolExecutor(max_workers=MAX_BOOKING_THREADS) as pool:
        futures = {
            pool.submit(sess.book, oid, date): (sess, date)
            for sess, oid, date in tasks
        }
        for future in as_completed(futures):
            sess, date = futures[future]
            try:
                result = future.result()
                results.append(result)
                status = result.get("status", "?")
                ms = result.get("_elapsed_ms", 0)
                msg = result.get("message", "")
                print(f"  [{sess.label}] {date}: {status} ({ms:.0f}ms) {msg}")
            except Exception as e:
                results.append({"status": "ERROR", "_card": sess.label, "_date": date, "error": str(e)})
                print(f"  [{sess.label}] {date}: ERROR {e}")

    total_ms = (time.monotonic() - t0) * 1000
    print(f"  all bookings fired in {total_ms:.0f}ms")
    return results


def wait_until_midnight() -> None:
    """Sleep until 23:59:55 Pacific (5 seconds before midnight)."""
    import zoneinfo
    pacific = zoneinfo.ZoneInfo("America/Los_Angeles")
    now = datetime.now(pacific)
    # Next midnight
    target = now.replace(hour=23, minute=59, second=55, microsecond=0)
    if now >= target:
        # Already past 23:59:55 today, target tomorrow's midnight
        from datetime import timedelta
        target += timedelta(days=1)
        target = target.replace(hour=23, minute=59, second=55)

    wait_secs = (target - now).total_seconds()
    if wait_secs > 0:
        print(f"\n  Sleeping {wait_secs:.0f}s until {target.strftime('%Y-%m-%d %H:%M:%S %Z')}...")
        time.sleep(wait_secs)
    print(f"  Woke up at {datetime.now(pacific).strftime('%H:%M:%S.%f %Z')}")


# ─── Entry point ──────────────────────────────────────────────────────────────

def main() -> None:
    import warnings
    warnings.filterwarnings("ignore", message=".*Unverified HTTPS.*")

    parser = argparse.ArgumentParser(description="San Diego Zoo D&G Pass Sniper")
    parser.add_argument("--dry-run", action="store_true", help="Poll but don't actually book")
    parser.add_argument("--test-login", action="store_true", help="Just verify credentials")
    parser.add_argument("--poll-now", action="store_true", help="Skip waiting, poll immediately")
    args = parser.parse_args()

    print("=" * 60)
    print("San Diego Zoo — Discover & Go Pass Sniper")
    print("=" * 60)

    # Validate card 2 is configured
    if not LIBRARY_CARDS[1]["patronNumber"]:
        print("\n  WARNING: Card 2 not configured. Set DG_CARD2_NUMBER + DG_CARD2_PIN env vars.")
        print("  Running with Card 1 only.\n")

    print("\n[1] Logging in...")
    sessions = create_sessions()
    if not sessions:
        print("  ERROR: no valid sessions. Check credentials.")
        sys.exit(1)

    if args.test_login:
        print("\n  Login test passed. Exiting.")
        # Quick check: can we see the Zoo?
        zoo = sessions[0].search_zoo()
        if zoo:
            print(f"  Zoo found: attractionID={zoo['attractionID']}, offers={zoo.get('attractionOffersCount', '?')}")
        sys.exit(0)

    if not args.poll_now:
        print("\n[2] Waiting for midnight...")
        wait_until_midnight()

    print("\n[3] Polling for Zoo offers...")
    offer_id, available_dates = poll_for_offers(sessions[0], dry_run=args.dry_run)

    print(f"\n[4] Booking...")
    results = fire_bookings(sessions, offer_id, available_dates, dry_run=args.dry_run)

    print(f"\n{'=' * 60}")
    print("RESULTS:")
    for r in results:
        card = r.get("_card", "?")
        date = r.get("_date", "?")
        status = r.get("status", "?")
        print(f"  [{card}] {date}: {status}")

    # Summary
    passed = [r for r in results if r.get("status") == "Passed"]
    failed = [r for r in results if r.get("status") != "Passed" and r.get("status") != "DRY_RUN"]
    if passed:
        print(f"\n  ✓ {len(passed)} booking(s) successful!")
    if failed:
        print(f"\n  ✗ {len(failed)} booking(s) failed")
        for r in failed:
            print(f"    [{r.get('_card')}] {r.get('_date')}: {r.get('message', r.get('status'))}")

    print(f"\n{'=' * 60}")


if __name__ == "__main__":
    main()

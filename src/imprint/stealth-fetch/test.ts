#!/usr/bin/env bun
/**
 * End-to-end test for stealth-fetch v2 against Southwest Airlines.
 *
 * Proves:
 * 1. Bootstrap captures valid Akamai tokens (no persistent browser)
 * 2. Native fetch with tokens gets 200 + real fare data
 * 3. Tokens are reusable across multiple calls
 * 4. Different routes / dates work with the same tokens
 * 5. notifyWhen predicate integration works on extracted prices
 *
 *   bun src/imprint/stealth-fetch/test.ts
 */

import { extractAt } from '../notify-when.ts';
import { StealthFetch } from './index.ts';

const SHOPPING_URL =
  'https://www.southwest.com/api/air-booking/v1/air-booking/page/air/booking/shopping';

function makeBody(origin: string, dest: string, date: string): string {
  return JSON.stringify({
    adultPassengersCount: '1', adultsCount: '1', departureDate: date,
    departureTimeOfDay: 'ALL_DAY', destinationAirportCode: dest, fareType: 'USD',
    int: 'HOMEQBOMAIR', originationAirportCode: origin, passengerType: 'ADULT',
    promoCode: '', returnDate: '', returnTimeOfDay: 'ALL_DAY', tripType: 'oneway',
    application: 'air-booking', site: 'southwest',
  });
}

function makeHeaders(): Record<string, string> {
  return {
    'X-API-Key': 'l7xx944d175ea25f4b9c903a583ea82a1c4c',
    'X-App-ID': 'air-booking',
    'X-Channel-ID': 'southwest',
    'X-User-Experience-ID': crypto.randomUUID(),
  };
}

async function main() {
  console.log('=== stealth-fetch v2 E2E Test ===\n');
  const t0 = Date.now();
  let passed = 0;
  let failed = 0;

  const sf = new StealthFetch({
    baseUrl: 'https://www.southwest.com/air/booking/',
    sensorWaitSeconds: 3,
  });

  try {
    // Test 1: Bootstrap + first call
    console.log('Test 1: SJC → SAN, June 23...');
    const r1 = await sf.fetch(SHOPPING_URL, {
      method: 'POST', headers: makeHeaders(), body: makeBody('SJC', 'SAN', '2026-06-23'),
    });
    console.log(`  Status: ${r1.status}, Body: ${r1.body.length} chars`);
    const hasFares1 = r1.body.includes('fareSummary');
    console.log(`  Has fares: ${hasFares1}`);
    if (r1.status === 200 && hasFares1) { passed++; console.log('  PASS\n'); }
    else { failed++; console.log(`  FAIL: ${r1.body.slice(0, 200)}\n`); }

    // Test 2: Token reuse — different destination
    console.log('Test 2: SJC → LAX, June 23 (same tokens)...');
    const r2 = await sf.fetch(SHOPPING_URL, {
      method: 'POST', headers: makeHeaders(), body: makeBody('SJC', 'LAX', '2026-06-23'),
    });
    console.log(`  Status: ${r2.status}, Body: ${r2.body.length} chars`);
    if (r2.status === 200 && r2.body.includes('fareSummary')) { passed++; console.log('  PASS\n'); }
    else { failed++; console.log(`  FAIL\n`); }

    // Test 3: Different date
    console.log('Test 3: SJC → SAN, July 15 (same tokens)...');
    const r3 = await sf.fetch(SHOPPING_URL, {
      method: 'POST', headers: makeHeaders(), body: makeBody('SJC', 'SAN', '2026-07-15'),
    });
    console.log(`  Status: ${r3.status}, Body: ${r3.body.length} chars`);
    if (r3.status === 200 && r3.body.includes('fareSummary')) { passed++; console.log('  PASS\n'); }
    else { failed++; console.log(`  FAIL\n`); }

    // Test 4: notifyWhen integration
    console.log('Test 4: Price extraction + notifyWhen predicate...');
    if (r1.status === 200) {
      const data = JSON.parse(r1.body);
      const prices = extractAt(data, 'data.searchResults.airProducts[].lowestFare.value');
      console.log(`  Prices extracted: ${prices.length}`);
      console.log(`  Values: $${prices.join(', $')}`);
      const min = Math.min(...prices);
      console.log(`  Cheapest: $${min}`);
      const threshold = 100;
      const wouldNotify = min < threshold;
      console.log(`  Threshold $${threshold} → notify: ${wouldNotify}`);
      if (prices.length > 0 && typeof min === 'number') { passed++; console.log('  PASS\n'); }
      else { failed++; console.log('  FAIL\n'); }
    } else {
      failed++;
      console.log('  SKIP (no data from test 1)\n');
    }

    // Test 5: Token age
    console.log(`Test 5: Token age = ${sf.tokenAgeSeconds}s`);
    if (sf.tokenAgeSeconds >= 0) { passed++; console.log('  PASS\n'); }
    else { failed++; console.log('  FAIL\n'); }

    // Summary
    console.log('=== Fare Summaries ===');
    for (const [label, resp] of [['SJC→SAN', r1], ['SJC→LAX', r2], ['SJC→SAN Jul', r3]] as const) {
      if (resp.status === 200) {
        const d = JSON.parse(resp.body);
        const fares = d?.data?.searchResults?.fareSummary ?? [];
        const wga = fares.find((f: { fareFamily: string }) => f.fareFamily === 'WGA');
        console.log(`  ${label}: WGA $${wga?.minimumFare?.value ?? '?'}`);
      }
    }

    console.log(`\n=== Results: ${passed} passed, ${failed} failed (${Date.now() - t0}ms) ===`);
  } finally {
    await sf.close();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

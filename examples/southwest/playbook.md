# search_southwest_flights

## Summary
Search Southwest for one-way fares between two airports on a given date. Uses the URL-prefilled search shortcut so a single navigation triggers the shopping XHR — no DOM walk needed. Stealth Chromium (default in the runner) defeats Akamai's bot detection that blocks naive HTTP clients.

## Parameters
- `origin_airport_code` (string, required) — IATA origin airport code, e.g. SJC
- `destination_airport_code` (string, required) — IATA destination airport code, e.g. SAN
- `departure_date` (string, required) — YYYY-MM-DD
- `adult_passengers_count` (number) — default: 1
- `fare_type` (string) — `USD` or `POINTS` default: USD

## Steps

### Step 1: Navigate to the prefilled search URL
- action: navigate
- url: https://www.southwest.com/air/booking/select-depart.html?adultsCount=${adult_passengers_count}&adultPassengersCount=${adult_passengers_count}&originationAirportCode=${origin_airport_code}&destinationAirportCode=${destination_airport_code}&departureDate=${departure_date}&departureTimeOfDay=ALL_DAY&fareType=${fare_type}&int=HOMEQBOMAIR&passengerType=ADULT&promoCode=&returnDate=&returnTimeOfDay=ALL_DAY&tripType=oneway
- wait_for: xhr:/api/air-booking/v1/air-booking/page/air/booking/shopping

## Result
- source: xhr
- url_pattern: /api/air-booking/v1/air-booking/page/air/booking/shopping
- extract: data.searchResults.airProducts[].lowestFare.value
- return_as: prices

## Notes

Param names match `workflow.json` exactly (`origin_airport_code` etc., not the friendlier `origin`) so cron.json's `params` block is shared across the fetch / stealth-fetch / playbook backends and the auto-ladder can hot-swap between them without rewriting params.

The original recording walked through the form (autocompletes, date picker, trip-type dropdown, search submit, Low Fare Calendar drilldown). Six iterations revealed Southwest's date input is non-typeable (zero `input` events captured on `#departureDate` — the user clicked the input + clicked a calendar cell). The URL-param shortcut sidesteps every form-fill quirk in one navigation.

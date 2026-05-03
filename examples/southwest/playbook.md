# search_southwest_flights_low_fare_calendar

## Summary
Search Southwest for one-way fares between two airports on a given date, then drill into the Low Fare Calendar to see prices for the surrounding days. Uses Southwest's URL params to skip the form-fill ceremony entirely.

## Parameters
- `origin` (string, required) — IATA origin airport code, e.g. SJC
- `destination` (string, required) — IATA destination airport code, e.g. SAN
- `depart_date` (string, required) — YYYY-MM-DD departure date

## Steps

### Step 1: Navigate to the search URL
- action: navigate
- url: https://www.southwest.com/air/booking/select-depart.html?adultsCount=1&adultPassengersCount=1&originationAirportCode=${origin}&destinationAirportCode=${destination}&departureDate=${depart_date}&departureTimeOfDay=ALL_DAY&fareType=USD&int=HOMEQBOMAIR&passengerType=ADULT&promoCode=&returnDate=&returnTimeOfDay=ALL_DAY&tripType=oneway
- wait_for: xhr:/api/air-booking/v1/air-booking/page/air/booking/shopping

## Result
- source: xhr
- url_pattern: /api/air-booking/v1/air-booking/page/air/booking/shopping
- extract: data.searchResults.airProducts[].lowestFare.value
- return_as: prices

## Notes

The recorded session showed the user clicking through the form (origin/destination autocompletes, date picker, trip-type dropdown, search submit, then drilling into Low Fare Calendar). The captured DOM events confirmed Southwest's date input is click-only — no keyboard input events were ever fired on `#departureDate`, so the original 12-step playbook's `type` action couldn't bind to React state and the form submitted with today's date instead of the requested one.

URL navigation sidesteps every form-fill quirk in one step. Southwest's `/air/booking/select-depart.html` route accepts the entire search state as query params — `originationAirportCode`, `destinationAirportCode`, `departureDate` (YYYY-MM-DD), `tripType`, etc — and runs the shopping XHR automatically. We confirmed the param shape from the captured Referer header on the shopping POST in the original recording.

The Low Fare Calendar drilldown was useful UX during recording but isn't needed for the price-drop watcher: the shopping XHR returns all flights for the date, and `notifyWhen.price_below` filters across them.

# search_southwest_flights_low_fare_calendar

## Summary
Search Southwest for one-way fares between two airports using the Low Fare Calendar, select a specific date, and return flight prices for that date.

## Parameters
- `origin` (string, required) — IATA airport code, e.g. SJC
- `destination` (string, required) — IATA airport code, e.g. SAN
- `depart_date` (string, required) — Initial search date in YYYY-MM-DD format
- `selected_date` (string, required) — Date selected from the Low Fare Calendar in YYYY-MM-DD format

## Steps

### Step 1: Open the booking page
- action: navigate
- url: https://www.southwest.com/air/booking/
- wait_for: networkidle

### Step 2: Type origin airport code
- action: type
- locators:
  - by: id, value: originationAirportCode
  - by: css, value: input#originationAirportCode
- value: ${origin}
- wait_for: sleep:500

### Step 3: Pick origin from autocomplete
- action: click
- locators:
  - by: text, value_pattern: ${origin}
  - by: aria_label, value_pattern: ${origin}
- wait_for: visible

### Step 4: Type destination airport code
- action: type
- locators:
  - by: id, value: destinationAirportCode
  - by: css, value: input#destinationAirportCode
- value: ${destination}
- wait_for: sleep:500

### Step 5: Pick destination from autocomplete
- action: click
- locators:
  - by: text, value_pattern: ${destination}
  - by: aria_label, value_pattern: ${destination}
- wait_for: visible

### Step 6: Set departure date
- action: type
- locators:
  - by: id, value: departureDate
  - by: aria_label, value: Depart date in M M, D D format
- value: ${depart_date}
- wait_for: sleep:300

### Step 6.5: Dismiss the date picker overlay
- action: press
- key: Escape
- wait_for: sleep:300

### Step 7: Open trip-type dropdown
- action: click
- locators:
  - by: css, value: div.trigger__2lKPu
  - by: text, value: Round-trip
- wait_for: sleep:1000

### Step 8: Select one-way
- action: click
- locators:
  - by: text, value: One-way
  - by: role, value: option, name: One-way
- wait_for: visible

### Step 9: Click Search flights
- action: click
- locators:
  - by: text, value: Search flights
  - by: role, value: button, name: Search flights
- wait_for: networkidle

### Step 10: Click Low Fare Calendar link
- action: click
- locators:
  - by: text, value: Low Fare Calendar
  - by: role, value: link, name: Low Fare Calendar
- wait_for: networkidle

### Step 11: Click the selected date on the calendar
- action: click
- locators:
  - by: text, value_pattern: ${selected_date}
  - by: aria_label, value_pattern: ${selected_date}
- wait_for: sleep:500

### Step 12: Click Continue to flight times
- action: click
- locators:
  - by: text, value: Continue to flight times
  - by: role, value: button, name: Continue to flight times
- wait_for: xhr:/api/air-booking/v1/air-booking/page/air/booking/shopping

## Result
- source: xhr
- url_pattern: /api/air-booking/v1/air-booking/page/air/booking/shopping
- extract: data.searchResults.airProducts[].lowestFare.value
- return_as: prices

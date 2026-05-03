#!/usr/bin/env bun
/**
 * End-to-end test: StealthClient against Southwest's real API.
 *
 * Proves the module works by:
 * 1. Initializing a StealthClient pointed at Southwest
 * 2. Making the shopping API call
 * 3. Parsing the fare data
 * 4. Verifying the notifyWhen predicate would fire
 *
 *   bun src/imprint/stealth-fetch/test.ts
 */

import { extractAt } from '../notify-when.ts';
import { StealthClient } from './index.ts';

async function main() {
  console.log('=== StealthClient E2E Test ===\n');
  const t0 = Date.now();

  const client = new StealthClient({
    baseUrl: 'https://www.southwest.com/air/booking/',
    sensorWaitSeconds: 3,
    headed: false,
  });

  try {
    console.log('1. Initializing (launching browser + loading page)...');
    await client.init();
    console.log(`   Done (${Date.now() - t0}ms)\n`);

    console.log('2. Calling shopping API...');
    const t1 = Date.now();
    const result = await client.fetch(
      'https://www.southwest.com/api/air-booking/v1/air-booking/page/air/booking/shopping',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'X-API-Key': 'l7xx944d175ea25f4b9c903a583ea82a1c4c',
          'X-App-ID': 'air-booking',
          'X-Channel-ID': 'southwest',
          'X-User-Experience-ID': crypto.randomUUID(),
        },
        body: JSON.stringify({
          adultPassengersCount: '1',
          adultsCount: '1',
          departureDate: '2026-06-23',
          departureTimeOfDay: 'ALL_DAY',
          destinationAirportCode: 'SAN',
          fareType: 'USD',
          int: 'HOMEQBOMAIR',
          originationAirportCode: 'SJC',
          passengerType: 'ADULT',
          promoCode: '',
          returnDate: '',
          returnTimeOfDay: 'ALL_DAY',
          tripType: 'oneway',
          application: 'air-booking',
          site: 'southwest',
        }),
      },
    );
    console.log(`   Status: ${result.status} (${Date.now() - t1}ms)`);
    console.log(`   Body length: ${result.body.length}\n`);

    if (result.status !== 200) {
      console.log('   FAILED — not 200');
      console.log(`   Body: ${result.body.slice(0, 500)}`);
      process.exit(1);
    }

    // 3. Parse the fare data
    console.log('3. Parsing fare data...');
    const data = JSON.parse(result.body);

    // Extract prices using the same path walker the cron's notifyWhen uses
    const prices = extractAt(data, 'data.searchResults.airProducts[].lowestFare.value');
    console.log(`   Lowest fares found: ${prices.length}`);
    console.log(`   Prices: $${prices.join(', $')}`);
    console.log(`   Cheapest: $${Math.min(...prices)}\n`);

    // 4. Verify notifyWhen would work
    console.log('4. Verifying notifyWhen predicate...');
    const threshold = 100;
    const min = Math.min(...prices);
    const wouldNotify = min < threshold;
    console.log(`   Threshold: $${threshold}`);
    console.log(`   Min price: $${min}`);
    console.log(`   Would notify: ${wouldNotify}\n`);

    // Summary
    const fareClasses = data.data?.searchResults?.fareSummary ?? [];
    console.log('=== FARE SUMMARY ===');
    for (const fc of fareClasses) {
      console.log(`  ${fc.fareFamily}: $${fc.minimumFare.value}`);
    }

    console.log(`\n=== SUCCESS (${Date.now() - t0}ms total) ===`);
    console.log('StealthClient bypassed Akamai and retrieved real Southwest fares.');

  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

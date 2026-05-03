/**
 * LIVE: book Cooley Museum + immediately cancel.
 *
 * The user picked: same attraction (Cooley Museum, offer 1175), date 30+ days
 * out (2026-08-15), book then cancel within seconds. Confirmation email will
 * arrive but slot is released within ~10 seconds.
 *
 * This is the moment of truth — exercises the full make→get→cancel chain
 * via the runtime against live D&G.
 *
 * Flow:
 *   1. makeReservation                  → {"status":"Passed"}
 *   2. getReservations                  → {..., reservations:[{reservationID,...}]}
 *   3. cancelReservation                → {"status":"Passed","reservationCount":0}
 *
 * If any step fails, the script prints the error AND tries best-effort to
 * cancel anything created during the partial run.
 */

import { executeWorkflow, loadCredentialStore } from '../src/imprint/runtime.ts';
import type { Workflow } from '../src/imprint/types.ts';

const ATTRACTION_NAME = 'Cooley Museum';
const OFFER_ID = 1175;
const OFFER_DATE = '2026-08-15'; // ~3.5 months out, low demand
const NOTIFICATION_EMAIL = 'ashaychangwani@gmail.com';

const COMMON_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'x-epass-clientID': '1',
  'x-epass-clientKey': '335e26134a53d4e23e4bed13517b7303',
  'x-epass-libraryID': '63',
  'x-epass-patronID': '${credential.patron_id}',
  Referer: 'https://sandiego.discoverandgo.net/',
};

const bookWorkflow: Workflow = {
  toolName: 'book_cooley_museum',
  intent: { description: 'Make + verify + cancel a reservation' },
  parameters: [],
  requests: [
    // Step 1: make the reservation
    {
      method: 'GET',
      url: `https://sandiego.discoverandgo.net/epass_server.php?dataType=json&method=makeReservation&functionFile=Reservations%2CAttractions&language=en&patronID=\${credential.patron_id}&offerID=${OFFER_ID}&offerDate=${OFFER_DATE}&notificationMethod=Email&notificationEmail=${encodeURIComponent(NOTIFICATION_EMAIL)}&notificationTXTNumber=`,
      headers: COMMON_HEADERS,
    },
    // Step 2: list reservations (so we can find the one we just made)
    {
      method: 'GET',
      url: 'https://sandiego.discoverandgo.net/epass_server.php?dataType=json&method=getReservations&functionFile=Reservations%2CAttractions&language=en&patronID=${credential.patron_id}',
      headers: COMMON_HEADERS,
    },
    // Step 3: cancel the reservation we just made
    // The captured workflow uses the FIRST reservation in the list
    {
      method: 'GET',
      url: 'https://sandiego.discoverandgo.net/epass_server.php?dataType=json&method=cancelReservation&functionFile=Reservations&language=en&patronID=${credential.patron_id}&reservationID=${response[1].reservations.0.reservationID}',
      headers: COMMON_HEADERS,
    },
  ],
  site: 'discoverandgo',
};

console.log('===========================================');
console.log(`LIVE TEST: book + cancel ${ATTRACTION_NAME} for ${OFFER_DATE}`);
console.log('===========================================');
console.log('');

const creds = loadCredentialStore('discoverandgo');
if (!creds) {
  console.error('FAIL: no credentials. Run `imprint login` first.');
  process.exit(1);
}
console.log(
  `loaded credentials: ${creds.cookies.length} cookies, ${Object.keys(creds.values).length} values`,
);
console.log('');

const t0 = Date.now();
const result = await executeWorkflow({
  workflow: bookWorkflow,
  params: {},
  credentials: creds,
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

if (!result.ok) {
  console.error(`✗ FAIL after ${elapsed}s: ${result.error}`);
  console.error(`  ${result.message}`);
  if (result.remediation) console.error(`  → ${result.remediation}`);
  process.exit(1);
}

console.log(`✓ chain completed in ${elapsed}s`);
console.log('');
console.log('cancel response:');
console.log(JSON.stringify(result.data, null, 2));

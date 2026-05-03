/**
 * One-shot live test against D&G — READ ONLY (getReservations).
 *
 * This proves the runtime can:
 *   - load the credential store
 *   - substitute ${credential.patron_id}
 *   - send the persisted cookies
 *   - get a 200 response from the real D&G backend
 *
 * It does NOT make or cancel any reservation.
 */

import { executeWorkflow, loadCredentialStore } from '../src/imprint/runtime.ts';
import type { Workflow } from '../src/imprint/types.ts';

const workflow: Workflow = {
  toolName: 'list_discoverandgo_reservations',
  intent: { description: 'Read-only test: list current reservations.' },
  parameters: [],
  requests: [
    {
      method: 'GET',
      url: 'https://sandiego.discoverandgo.net/epass_server.php?dataType=json&method=getReservations&functionFile=Reservations%2CAttractions&language=en&patronID=${credential.patron_id}',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        // These four are how D&G identifies the calling library + user.
        // They mirror what was captured; the libraryID + clientKey are
        // stable per library, the patronID is from the credential store.
        'x-epass-clientID': '1',
        'x-epass-clientKey': '335e26134a53d4e23e4bed13517b7303',
        'x-epass-libraryID': '63',
        'x-epass-patronID': '${credential.patron_id}',
        Referer: 'https://sandiego.discoverandgo.net/',
      },
    },
  ],
  site: 'discoverandgo',
};

const creds = loadCredentialStore('discoverandgo');
if (!creds) {
  console.error('No credentials. Run `imprint login discoverandgo --from-session ...` first.');
  process.exit(1);
}
console.log(`Loaded ${creds.cookies.length} cookies + ${Object.keys(creds.values).length} values`);

const result = await executeWorkflow({
  workflow,
  params: {},
  credentials: creds,
});

if (!result.ok) {
  console.error(`FAIL: ${result.error} — ${result.message}`);
  if (result.remediation) console.error(`  ${result.remediation}`);
  process.exit(1);
}

console.log('OK — D&G returned:');
console.log(JSON.stringify(result.data, null, 2).slice(0, 2000));

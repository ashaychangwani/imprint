/**
 * Per-step diagnostic for the make/get/cancel chain.
 * Calls each request individually so we can see what came back at each step.
 */

import { executeWorkflow, loadCredentialStore } from '../src/imprint/runtime.ts';
import type { Workflow } from '../src/imprint/types.ts';

const COMMON_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'x-epass-clientID': '1',
  'x-epass-clientKey': '335e26134a53d4e23e4bed13517b7303',
  'x-epass-libraryID': '63',
  'x-epass-patronID': '${credential.patron_id}',
  Referer: 'https://sandiego.discoverandgo.net/',
};

const creds = loadCredentialStore('discoverandgo');
if (!creds) throw new Error('no credentials');

async function call(label: string, w: Workflow): Promise<unknown> {
  const r = await executeWorkflow({ workflow: w, params: {}, credentials: creds! });
  if (!r.ok) {
    console.log(`${label}: ${r.error} — ${r.message}`);
    return null;
  }
  console.log(`${label}: ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data)}`);
  return r.data;
}

// Step 1: get current state (verify clean start)
await call('GET (before)', {
  toolName: 'list',
  intent: { description: '' },
  parameters: [],
  requests: [
    {
      method: 'GET',
      url: 'https://sandiego.discoverandgo.net/epass_server.php?dataType=json&method=getReservations&functionFile=Reservations%2CAttractions&language=en&patronID=${credential.patron_id}',
      headers: COMMON_HEADERS,
    },
  ],
  site: 'discoverandgo',
});

// Step 2: make — pick a date Cooley actually offers (queried live, available 30+ days out)
const date = '2026-06-23';
await call('MAKE', {
  toolName: 'make',
  intent: { description: '' },
  parameters: [],
  requests: [
    {
      method: 'GET',
      url: `https://sandiego.discoverandgo.net/epass_server.php?dataType=json&method=makeReservation&functionFile=Reservations%2CAttractions&language=en&patronID=\${credential.patron_id}&offerID=1175&offerDate=${date}&notificationMethod=Email&notificationEmail=ashaychangwani%40gmail.com&notificationTXTNumber=`,
      headers: COMMON_HEADERS,
    },
  ],
  site: 'discoverandgo',
});

// Step 3: get current state (find new reservation)
const list = await call('GET (after make)', {
  toolName: 'list',
  intent: { description: '' },
  parameters: [],
  requests: [
    {
      method: 'GET',
      url: 'https://sandiego.discoverandgo.net/epass_server.php?dataType=json&method=getReservations&functionFile=Reservations%2CAttractions&language=en&patronID=${credential.patron_id}',
      headers: COMMON_HEADERS,
    },
  ],
  site: 'discoverandgo',
});

// Inspect the list to find a reservation ID we can cancel.
let rid: number | null = null;
if (list && typeof list === 'string') {
  try {
    const parsed = JSON.parse(list);
    rid = parsed?.reservations?.[0]?.reservationID ?? null;
  } catch {}
} else if (list && typeof list === 'object') {
  const o = list as { reservations?: Array<{ reservationID?: number }> };
  rid = o.reservations?.[0]?.reservationID ?? null;
}
console.log(`extracted reservationID: ${rid}`);

if (rid) {
  // Step 4: cancel that specific reservation
  await call(`CANCEL ${rid}`, {
    toolName: 'cancel',
    intent: { description: '' },
    parameters: [],
    requests: [
      {
        method: 'GET',
        url: `https://sandiego.discoverandgo.net/epass_server.php?dataType=json&method=cancelReservation&functionFile=Reservations&language=en&patronID=\${credential.patron_id}&reservationID=${rid}`,
        headers: COMMON_HEADERS,
      },
    ],
    site: 'discoverandgo',
  });
} else {
  console.log('no reservation to cancel — make may have failed or list parse failed');
}

// Step 5: final state check
await call('GET (final)', {
  toolName: 'list',
  intent: { description: '' },
  parameters: [],
  requests: [
    {
      method: 'GET',
      url: 'https://sandiego.discoverandgo.net/epass_server.php?dataType=json&method=getReservations&functionFile=Reservations%2CAttractions&language=en&patronID=${credential.patron_id}',
      headers: COMMON_HEADERS,
    },
  ],
  site: 'discoverandgo',
});

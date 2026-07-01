import { transform as googleFlightsTransform } from '../_shared/google_flights_transport.ts';

const RPC_ID = 'H028ib';
const DEFAULT_TYPE_CODES = [1, 2, 3, 5];
const ALL_TYPE_CODES = [1, 2, 3, 5, 4];
const STATE_F_SID = '${state.f_sid}';
const STATE_BL = '${state.bl}';
const ENCODED_STATE_F_SID = encodeURIComponent(STATE_F_SID);
const ENCODED_STATE_BL = encodeURIComponent(STATE_BL);

type RuntimeParams = Record<string, string | number | boolean | undefined>;

function normalizeQuery(params?: RuntimeParams): string {
  const query = params?.query;
  return typeof query === 'string' && query.trim() ? query : 'san di';
}

function typeCodesFor(params?: RuntimeParams): number[] {
  const raw = String(params?.location_types ?? 'default').toLowerCase();
  const requested = raw.split(',').map((part) => part.trim()).filter(Boolean);
  return requested.includes('all') ? ALL_TYPE_CODES : DEFAULT_TYPE_CODES;
}

export function transform(
  method: string,
  url: string,
  responses: unknown[],
  params?: RuntimeParams,
): { url: string; body: string; headers: Record<string, string> } {
  const innerPayload = [normalizeQuery(params), typeCodesFor(params), null, [1, 1, 1], 1];
  const fReq = [[[RPC_ID, JSON.stringify(innerPayload), null, 'generic']]];

  const built = googleFlightsTransform(method, url, responses, {
    fReq,
    rpcid: RPC_ID,
    sourcePath: '/travel/flights',
    referer: 'https://www.google.com/travel/flights',
    state: {
      'f.sid': STATE_F_SID,
      bl: STATE_BL,
    },
    headers: {
      'x-goog-ext-259736195-jspb': '["en-US","US","USD",2,null,[420],null,null,7,[]]',
    },
  });

  return {
    ...built,
    url: built.url
      .replaceAll(ENCODED_STATE_F_SID, STATE_F_SID)
      .replaceAll(ENCODED_STATE_BL, STATE_BL),
  };
}

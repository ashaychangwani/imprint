type Params = Record<string, string | number | boolean>;

function rpcBody(rpcId: string, payload: unknown, slot: string): string {
  const request = [[[rpcId, JSON.stringify(payload), null, slot]]];
  return new URLSearchParams({ 'f.req': JSON.stringify(request) }).toString() + '&';
}

export function transform(
  method: string,
  url: string,
  responses: unknown[],
  params: Params = {},
): { url: string; body: string } {
  void method;
  void responses;
  const hotelId = typeof params.hotel_id === 'string' ? params.hotel_id.trim() : '';
  const hotelName = typeof params.hotel_name === 'string' ? params.hotel_name.trim() : '';
  if (!hotelId) throw new Error('hotel_id is required');
  if (!hotelName) throw new Error('hotel_name is required');

  const rpcId = new URL(url).searchParams.get('rpcids');
  if (rpcId === 'AtySUc') {
    const payload = [
      hotelName,
      [
        1,
        [[[3], [3]], 0],
        [
          [null, [[null, null, null, null, null, null, hotelName]], []],
          [null, null, null, null, null, [1]],
        ],
        null,
        [[null, null, null, null, null, null, 'USD'], null, []],
      ],
      [1, null, null, 0, 0, hotelId, 13, null, 0],
      null,
      1,
    ];
    return { url, body: rpcBody(rpcId, payload, '1') };
  }
  if (rpcId === 'zM1L7d') {
    return { url, body: rpcBody(rpcId, [null, null, null, [152, 152], hotelId], '1') };
  }
  if (rpcId === 'ocp93e') {
    return {
      url,
      body: rpcBody(
        rpcId,
        [null, null, null, null, null, null, null, null, hotelId, null, null, [[]]],
        '1',
      ),
    };
  }
  if (rpcId === 'bdmBfe') {
    return { url, body: rpcBody(rpcId, [hotelName, 3], 'generic') };
  }
  throw new Error(`unsupported hotel detail RPC: ${rpcId ?? 'missing'}`);
}

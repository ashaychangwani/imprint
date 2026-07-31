const SCALE_PRESETS: Record<string, Array<[number, number]>> = {
  all: [[1, 15], [1, 30], [2, 15], [2, 30], [2, 60], [2, 120]],
  local: [[1, 15], [1, 30]],
  detailed: [[2, 15], [2, 30]],
  regional: [[2, 60], [2, 120]],
};

export function transform(
  _method: string,
  url: string,
  _responses: unknown[],
  params: Record<string, string | number | boolean> = {},
): { url: string; body: string } {
  const destinationId = String(params.destination_id || params.place_id || '').trim();
  const detailLevel = String(params.detail_level ?? 'all');
  const scales = SCALE_PRESETS[detailLevel];

  if (!destinationId) throw new Error('destination_id or place_id is required');
  if (!scales) {
    throw new Error(`detail_level must be one of: ${Object.keys(SCALE_PRESETS).join(', ')}`);
  }

  // Live differential verification established that FCE32b resolves its own
  // canonical center from destination_id; this positional center is only a hint.
  const rpcPayload = [null, scales, null, [[[destinationId], [0, 0]]]];
  const envelope = [[['FCE32b', JSON.stringify(rpcPayload), null, 'generic']]];
  return { url, body: `f.req=${encodeURIComponent(JSON.stringify(envelope))}&` };
}

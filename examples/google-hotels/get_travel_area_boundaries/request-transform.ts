type Params = Record<string, string | number | boolean>;

const RADIUS_ZOOM_PAIRS = [
  [1, 15],
  [1, 30],
  [2, 15],
  [2, 30],
  [2, 60],
  [2, 120],
];

function requiredString(params: Params | undefined, name: string): string {
  const value = params?.[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredNumber(params: Params | undefined, name: string): number {
  const value = params?.[name];
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new Error(`${name} must be a finite number`);
  }
  return numberValue;
}

export function transform(
  method: string,
  url: string,
  responses: unknown[],
  params?: Params,
): { url: string; body?: string } {
  void method;
  void responses;
  const placeId = requiredString(params, 'place_id');
  const latitude = requiredNumber(params, 'latitude');
  const longitude = requiredNumber(params, 'longitude');

  const inner = [
    null,
    RADIUS_ZOOM_PAIRS,
    null,
    [[[placeId], [latitude, longitude]]],
  ];
  const outer = [[['FCE32b', JSON.stringify(inner), null, 'generic']]];
  return {
    url,
    body: `f.req=${encodeURIComponent(JSON.stringify(outer))}&`,
  };
}

type Params = Record<string, string | number | boolean>;

function dateParts(value: unknown, name: string): number[] {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(name + ' must use YYYY-MM-DD');
  const parts = value.split('-').map(Number);
  const normalized = new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!))
    .toISOString()
    .slice(0, 10);
  if (normalized !== value) throw new Error(name + ' must be a real calendar date');
  return parts;
}

export function transform(method: string, url: string, ...args: unknown[]): { url: string; body?: string } {
  const params = (args.find((value): value is Params => !!value && !Array.isArray(value) && typeof value === 'object' && ('check_in_date' in value || 'hotel_id' in value)) ?? {}) as Params;
  const responses = (args.find(Array.isArray) ?? []) as unknown[];
  void method;
  const checkIn = dateParts(params.check_in_date, 'check_in_date');
  const checkOut = dateParts(params.check_out_date, 'check_out_date');
  const start = Date.UTC(checkIn[0]!, checkIn[1]! - 1, checkIn[2]!);
  const end = Date.UTC(checkOut[0]!, checkOut[1]! - 1, checkOut[2]!);
  const nights = (end - start) / 86400000;
  if (!Number.isInteger(nights) || nights < 1) throw new Error('check_out_date must be later than check_in_date');
  if (typeof params.hotel_id !== 'string' || !params.hotel_id) throw new Error('hotel_id is required');
  const adults = Number(params.adults);
  if (!Number.isInteger(adults) || adults < 1) throw new Error('adults must be a positive integer');
  const currency = typeof params.currency === 'string' && params.currency ? params.currency : 'USD';
  const expanded = responses.length > 0;
  const marker = expanded ? '${state.expansion_token}' : null;
  const context = [null, null, null, currency, [checkIn, checkOut, nights, adults], null, null, null, null, null, null, null, null, [2, null, 0], null, null, null, null, null];
  const propertyContext = [null, null, null, null, null, null, 1, null, 2, null, null, null, null, null];
  const inner = [null, context, expanded ? [1, marker, 2] : [1, null, 1], params.hotel_id, propertyContext, 1, 2];
  const fReq = [[['M0CRd', JSON.stringify(inner), null, 'generic']]];
  return { url, body: new URLSearchParams({ 'f.req': JSON.stringify(fReq) }).toString() + '&' };
}

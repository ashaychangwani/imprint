/** Akamai Bot Manager sensor-cookie helpers. The `_abck` cookie value has the
 *  shape `<token>~<status>~…`; status `0` = validated, `-1` = unvalidated. No-op
 *  on sites that don't use Akamai (the cookie is simply absent). */
export const AKAMAI_SENSOR_COOKIE = '_abck';
/** The status flag of an `_abck` value (`<token>~<flag>~…`), or '?' if absent/malformed. */
export function abckFlag(value: string | undefined): string {
  return value?.split('~')[1] ?? '?';
}
/** `_abck` is validated when its status flag is `0`. */
export function isAbckValidated(value: string | undefined): boolean {
  return value?.split('~')[1] === '0';
}

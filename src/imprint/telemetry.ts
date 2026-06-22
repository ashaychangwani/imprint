const TELEMETRY_PATH_PATTERN =
  /\/(log|events?|gen_204|jserror|ping|beacon|csi|batchlog|metrics|stats|collect|analytics|adsct|pagead|ccm)(?=$|[/?])/i;

export function isTelemetryPath(pathname: string): boolean {
  return TELEMETRY_PATH_PATTERN.test(pathname);
}

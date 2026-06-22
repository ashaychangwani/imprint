interface TelemetryRequestLike {
  method: string;
  url: string;
  body?: string;
  response?: {
    body?: string;
  };
}

const HARD_TELEMETRY_PATH_PATTERN =
  /\/(log|gen_204|jserror|ping|beacon|csi|batchlog|metrics|stats|collect|analytics|adsct|pagead|ccm)(?=$|[/?])/i;
const TERMINAL_EVENT_PATH_PATTERN = /\/events?\/?$/i;
const EVENT_COLLECTOR_BODY_PATTERNS = [
  /"app_(?:version|build)"/i,
  /"browser_(?:name|version)"/i,
  /"device_(?:environment|locale|make|model)"/i,
  /"event_(?:id|name|type)"/i,
  /"os(?:_version)?"/i,
  /"screen_(?:height|scale_factor|width)"/i,
];

function isTelemetryPath(pathname: string): boolean {
  return HARD_TELEMETRY_PATH_PATTERN.test(pathname);
}

export function isTelemetryRequest(request: TelemetryRequestLike): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }

  if (isTelemetryPath(url.pathname)) return true;
  if (!TERMINAL_EVENT_PATH_PATTERN.test(url.pathname)) return false;
  if (request.method.toUpperCase() !== 'POST') return false;
  if (!hasEmptyResponse(request)) return false;

  const body = request.body ?? '';
  return EVENT_COLLECTOR_BODY_PATTERNS.filter((pattern) => pattern.test(body)).length >= 2;
}

function hasEmptyResponse(request: TelemetryRequestLike): boolean {
  const body = request.response?.body;
  return body === undefined || body.trim().length === 0;
}

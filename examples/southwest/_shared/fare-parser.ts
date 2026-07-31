export interface Money {
  value: string;
  currencyCode: string;
}

const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;
const CURRENCY_RE = /^[A-Za-z]{3}$/;

export function parseMoney(input: unknown): Money | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const valueCandidate = record.value !== undefined ? record.value : record.amount;
  const currencyCandidate =
    record.currencyCode !== undefined ? record.currencyCode : record.currency;

  if (typeof valueCandidate !== "string" || typeof currencyCandidate !== "string") {
    return null;
  }

  const value = valueCandidate.trim();
  const currencyCode = currencyCandidate.trim();

  if (!DECIMAL_RE.test(value) || !CURRENCY_RE.test(currencyCode)) {
    return null;
  }

  return {
    value,
    currencyCode: currencyCode.toUpperCase(),
  };
}

export interface Money {
  currencyCode: string;
  value: string;
}

type FareFamily = {
  baseFare: Money | null;
  totalFare: Money | null;
  totalTaxesAndFees: Money | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeMoney(value: unknown): Money | null {
  if (!isRecord(value)) return null;

  const currencyCode = value.currencyCode;
  const amount = value.value;
  if (typeof currencyCode !== "string" || typeof amount !== "string") {
    return null;
  }

  return { currencyCode, value: amount };
}

export function normalizeFareFamilies(
  value: unknown,
): Record<string, FareFamily> {
  const result: Record<string, FareFamily> = {};
  if (!isRecord(value)) return result;

  for (const [family, familyValue] of Object.entries(value)) {
    if (!isRecord(familyValue)) {
      result[family] = {
        baseFare: null,
        totalFare: null,
        totalTaxesAndFees: null,
      };
      continue;
    }

    result[family] = {
      baseFare: normalizeMoney(familyValue.baseFare),
      totalFare: normalizeMoney(familyValue.totalFare),
      totalTaxesAndFees: normalizeMoney(familyValue.totalTaxesAndFees),
    };
  }

  return result;
}

export function normalizeRoute(value: unknown): {
  originationAirportCode: string | null;
  destinationAirportCode: string | null;
} {
  if (!isRecord(value)) {
    return {
      originationAirportCode: null,
      destinationAirportCode: null,
    };
  }

  return {
    originationAirportCode:
      typeof value.originationAirportCode === "string"
        ? value.originationAirportCode
        : null,
    destinationAirportCode:
      typeof value.destinationAirportCode === "string"
        ? value.destinationAirportCode
        : null,
  };
}

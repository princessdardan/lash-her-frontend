const CAD_FORMATTER = new Intl.NumberFormat("en-CA", {
  currency: "CAD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  style: "currency",
});

const CAD_AMOUNT_ERROR = "Enter a valid CAD amount";

export function parseCad(value: number | string): number {
  return centsToCad(parseCadToCents(value));
}

export function addCad(values: ReadonlyArray<number | string>): number {
  const cents = values.reduce<number>((total, value) => total + parseCadToCents(value), 0);

  return centsToCad(cents);
}

export function multiplyCad(value: number | string, multiplier: number): number {
  if (!Number.isInteger(multiplier) || multiplier < 0) {
    throw new Error(CAD_AMOUNT_ERROR);
  }

  return centsToCad(parseCadToCents(value) * multiplier);
}

export function formatCad(value: number | string): string {
  return `${CAD_FORMATTER.format(parseCad(value))} CAD`;
}

function parseCadToCents(value: number | string): number {
  const normalized = normalizeCadValue(value);
  const [dollarsPart, centsPart = ""] = normalized.split(".");
  const cents = Number.parseInt(`${dollarsPart}${centsPart.padEnd(2, "0")}`, 10);

  if (!Number.isSafeInteger(cents)) {
    throw new Error(CAD_AMOUNT_ERROR);
  }

  return cents;
}

function normalizeCadValue(value: number | string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(CAD_AMOUNT_ERROR);
    }

    return validateCadString(String(value));
  }

  return validateCadString(value.trim());
}

function validateCadString(value: string): string {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error(CAD_AMOUNT_ERROR);
  }

  return value;
}

function centsToCad(cents: number): number {
  return cents / 100;
}

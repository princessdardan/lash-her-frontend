export interface CustomsAllocationLine {
  key: string;
  quantity: number;
  merchandiseTotalCents: number;
}

export function allocateDiscountedCustomsValues(
  lines: readonly CustomsAllocationLine[],
  discountedMerchandiseTotalCents: number,
): Map<string, number> {
  const subtotal = lines.reduce(
    (sum, line) => sum + line.merchandiseTotalCents,
    0,
  );
  if (
    subtotal <= 0 ||
    discountedMerchandiseTotalCents <= 0 ||
    discountedMerchandiseTotalCents > subtotal
  ) {
    throw new Error("Invalid customs declaration total");
  }

  const allocations = lines.map((line) => {
    if (
      !Number.isInteger(line.quantity) ||
      line.quantity <= 0 ||
      line.merchandiseTotalCents <= 0
    ) {
      throw new Error("Invalid customs declaration line");
    }
    const exact =
      (line.merchandiseTotalCents * discountedMerchandiseTotalCents) / subtotal;
    const cents = Math.floor(exact);
    return { ...line, cents, remainder: exact - cents };
  });
  let remaining =
    discountedMerchandiseTotalCents -
    allocations.reduce((sum, line) => sum + line.cents, 0);
  allocations.sort(
    (left, right) =>
      right.remainder - left.remainder || left.key.localeCompare(right.key),
  );
  for (let index = 0; remaining > 0; index = (index + 1) % allocations.length) {
    allocations[index].cents += 1;
    remaining -= 1;
  }

  return new Map(allocations.map((line) => [line.key, line.cents]));
}

export function splitCustomsLineValue(
  totalCents: number,
  quantity: number,
): number[] {
  if (
    !Number.isInteger(totalCents) ||
    totalCents < quantity ||
    !Number.isInteger(quantity) ||
    quantity <= 0
  ) {
    throw new Error("Customs item value must be at least one cent per unit");
  }
  const base = Math.floor(totalCents / quantity);
  const remainder = totalCents % quantity;
  return Array.from(
    { length: quantity },
    (_, index) => base + (index < remainder ? 1 : 0),
  );
}

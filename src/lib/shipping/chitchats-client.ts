import "server-only";

import { getChitChatsConfig, type ChitChatsConfig } from "./config";
import type { ChitChatsCreateShipmentInput, ChitChatsShipment } from "./types";

export class ChitChatsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null,
    readonly responseBody: unknown,
  ) {
    super(message);
    this.name = "ChitChatsApiError";
  }
}

export interface ChitChatsClient {
  createShipment(
    input: ChitChatsCreateShipmentInput,
  ): Promise<ChitChatsShipment>;
  getShipment(id: string): Promise<ChitChatsShipment>;
  findShipments(query: string): Promise<ChitChatsShipment[]>;
  refreshShipment(
    id: string,
    input: {
      packageType: string;
      weightGrams: number;
      lengthCm: number;
      widthCm: number;
      heightCm: number;
      shipDate: string;
    },
  ): Promise<ChitChatsShipment>;
  buyShipment(
    id: string,
    input: { postageType: string },
  ): Promise<ChitChatsShipment>;
  deleteShipment(id: string): Promise<void>;
  refundShipment(id: string): Promise<ChitChatsShipment>;
}

export function createChitChatsClient(
  config: ChitChatsConfig = getChitChatsConfig(),
  fetchImpl: typeof fetch = fetch,
): ChitChatsClient {
  const request = async <T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> => {
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: config.accessToken,
        ...(init.body
          ? { "Content-Type": "application/json; charset=utf-8" }
          : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      const responseBody = await readBody(response);
      const retryAfter = response.headers.get("retry-after");
      throw new ChitChatsApiError(
        `Chit Chats request failed with ${response.status}`,
        response.status,
        retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null,
        responseBody,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };

  return {
    async createShipment(input) {
      const result = await request<{ shipment: ChitChatsShipment }>(
        "/shipments",
        {
          method: "POST",
          body: JSON.stringify(toShipmentPayload(input)),
        },
      );
      return assertShipment(result.shipment);
    },
    async getShipment(id) {
      const result = await request<{ shipment: ChitChatsShipment }>(
        `/shipments/${encodeURIComponent(id)}`,
      );
      return assertShipment(result.shipment);
    },
    async findShipments(query) {
      return request<ChitChatsShipment[]>(
        `/shipments?limit=100&page=1&q=${encodeURIComponent(query)}`,
      );
    },
    async refreshShipment(id, input) {
      const result = await request<{ shipment: ChitChatsShipment }>(
        `/shipments/${encodeURIComponent(id)}/refresh`,
        {
          method: "PATCH",
          body: JSON.stringify({
            package_type: input.packageType,
            weight_unit: "g",
            weight: input.weightGrams,
            size_unit: "cm",
            size_x: input.lengthCm,
            size_y: input.widthCm,
            size_z: input.heightCm,
            insurance_requested: true,
            signature_requested: false,
            ship_date: input.shipDate,
          }),
        },
      );
      return assertShipment(result.shipment);
    },
    async buyShipment(id, input) {
      const result = await request<{ shipment: ChitChatsShipment }>(
        `/shipments/${encodeURIComponent(id)}/buy`,
        {
          method: "PATCH",
          body: JSON.stringify({ postage_type: input.postageType }),
        },
      );
      return assertShipment(result.shipment);
    },
    async deleteShipment(id) {
      await request<void>(`/shipments/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
    async refundShipment(id) {
      const result = await request<{ shipment: ChitChatsShipment }>(
        `/shipments/${encodeURIComponent(id)}/refund`,
        { method: "PATCH" },
      );
      return assertShipment(result.shipment);
    },
  };
}

function toShipmentPayload(
  input: ChitChatsCreateShipmentInput,
): Record<string, unknown> {
  return {
    name: input.recipient.name,
    address_1: input.recipient.line1,
    ...(input.recipient.line2 ? { address_2: input.recipient.line2 } : {}),
    city: input.recipient.city,
    province_code: input.recipient.province,
    postal_code: input.recipient.postalCode,
    country_code: input.recipient.countryCode,
    phone: input.recipient.phone,
    email: input.recipient.email,
    package_contents: "merchandise",
    description: input.customsLines
      .map((line) => line.description)
      .join(", ")
      .slice(0, 255),
    value: cents(input.merchandiseValueCents),
    value_currency: "cad",
    order_id: input.orderReference,
    order_store: "other",
    package_type: input.packageSnapshot.packageType,
    weight_unit: "g",
    weight: input.packageSnapshot.totalWeightGrams,
    size_unit: "cm",
    size_x: input.packageSnapshot.lengthCm,
    size_y: input.packageSnapshot.widthCm,
    size_z: input.packageSnapshot.heightCm,
    insurance_requested: true,
    signature_requested: false,
    duties_paid_requested: input.recipient.countryCode === "US",
    postage_type: input.postageType ?? "unknown",
    ship_date: input.shipDate ?? "today",
    line_items: input.customsLines.map((line) => ({
      quantity: line.quantity,
      description: line.description,
      value_amount: cents(line.unitValueCents),
      currency_code: "cad",
      hs_tariff_code: line.hsTariffCode,
      sku_code: line.sku,
      origin_country: line.countryOfOrigin,
      weight_unit: "g",
      weight: line.unitWeightGrams,
      manufacturer_contact: line.manufacturerName,
      manufacturer_street: line.manufacturerAddress,
      manufacturer_city: line.manufacturerCity,
      manufacturer_province_code: line.manufacturerProvinceCode,
      manufacturer_postal_code: line.manufacturerPostalCode,
      manufacturer_country_code: line.manufacturerCountryCode,
    })),
  };
}

function cents(value: number): string {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error("Invalid Chit Chats monetary amount");
  return (value / 100).toFixed(2);
}

function assertShipment(value: unknown): ChitChatsShipment {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { id?: unknown }).id !== "string"
  ) {
    throw new Error("Chit Chats response did not contain a shipment");
  }
  return value as ChitChatsShipment;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 2_000);
  }
}

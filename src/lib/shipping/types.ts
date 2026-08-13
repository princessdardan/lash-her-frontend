import type {
  CheckoutOrderShippingAddressSnapshot,
  ProductShipmentCustomsLineSnapshot,
  ProductShipmentPackageSnapshot,
  ProductShipmentRateSnapshot,
} from "@/lib/private-db/schema";

export type ShippingCountryCode = "CA" | "US";

export interface ShippingRecipient extends CheckoutOrderShippingAddressSnapshot {
  countryCode: ShippingCountryCode;
  name: string;
  email: string;
  phone: string;
}

export interface ShippingPackageProfile {
  id: string;
  slug: string;
  name: string;
  rank: number;
  packageType: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  tareWeightGrams: number;
  maxWeightGrams: number;
  capacityUnits: number;
  enabled: boolean;
}

export interface PreparedShippingQuote {
  fingerprint: string;
  packageSnapshot: ProductShipmentPackageSnapshot;
  customsLines: ProductShipmentCustomsLineSnapshot[];
  merchandiseValueCents: number;
  recipient: ShippingRecipient;
  publicReference: string;
}

export interface ShippingQuoteResult {
  quoteToken: string;
  expiresAt: string;
  rates: ProductShipmentRateSnapshot[];
}

export interface ChitChatsShipment {
  id: string;
  status: string;
  postage_type?: string | null;
  carrier?: string | null;
  carrier_tracking_code?: string | null;
  tracking_url?: string | null;
  purchase_amount?: string | number | null;
  postage_fee?: string | number | null;
  insurance_fee?: string | number | null;
  is_insured?: boolean | null;
  postage_label_pdf_url?: string | null;
  rates?: ChitChatsRate[];
  tracking_events?: ChitChatsTrackingEvent[];
  [key: string]: unknown;
}

export interface ChitChatsRate {
  postage_type: string;
  postage_carrier_type?: string | null;
  postage_description?: string | null;
  delivery_time_description?: string | null;
  tracking_type_description?: string | null;
  is_insured?: boolean | null;
  payment_amount: string | number;
  insurance_fee?: string | number | null;
  [key: string]: unknown;
}

export interface ChitChatsTrackingEvent {
  type?: string | null;
  title?: string | null;
  subtitle?: string | null;
  status?: string | null;
  created_at?: string | null;
  [key: string]: unknown;
}

export interface ChitChatsCreateShipmentInput {
  recipient: ShippingRecipient;
  packageSnapshot: ProductShipmentPackageSnapshot;
  customsLines: ProductShipmentCustomsLineSnapshot[];
  merchandiseValueCents: number;
  orderReference: string;
  postageType?: string;
  shipDate?: string;
}

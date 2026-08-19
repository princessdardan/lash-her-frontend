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
  delivery_fee?: string | number | null;
  tariff_fee?: string | number | null;
  fda_prior_notification_fee?: string | number | null;
  federal_tax?: string | number | null;
  provincial_tax?: string | number | null;
  is_insured?: boolean | null;
  estimated_delivery_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  ship_date?: string | null;
  postage_purchase_date?: string | null;
  order_id?: string | null;
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
  signature_confirmation_description?: string | null;
  is_insured?: boolean | null;
  payment_amount: string | number;
  purchase_amount?: string | number | null;
  postage_fee?: string | number | null;
  insurance_fee?: string | number | null;
  delivery_fee?: string | number | null;
  tariff_fee?: string | number | null;
  fda_prior_notification_fee?: string | number | null;
  federal_tax?: string | number | null;
  provincial_tax?: string | number | null;
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

export interface ChitChatsReturn {
  id: string;
  original_shipment?: { id?: string | null } | null;
  status?: string | null;
  return_reason?: string | null;
  return_reason_note?: string | null;
  resolution?: string | null;
  resolved_at?: string | null;
  updated_at?: string | null;
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
  signatureRequested: boolean;
}

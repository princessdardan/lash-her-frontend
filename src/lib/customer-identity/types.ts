export const CUSTOMER_IDENTITY_PROVIDER = "google" as const;

export interface CustomerIdentityResolutionInput {
  displayName: string | null;
  email: string;
  emailVerified: boolean;
  provider: string;
  providerAccountId: string;
}

export interface CustomerIdentityLink {
  customerUserId: string;
}

export type CustomerUserStatus = "active" | "disabled";

export interface CreateCustomerInput {
  createdAt: Date;
  displayName: string | null;
  id: string;
}

export interface CreateProviderAccountInput {
  createdAt: Date;
  customerUserId: string;
  email: string;
  emailNormalized: string;
  id: string;
  provider: typeof CUSTOMER_IDENTITY_PROVIDER;
  providerAccountId: string;
  verifiedAt: Date;
}

export interface CreateVerifiedEmailInput {
  createdAt: Date;
  customerUserId: string;
  email: string;
  emailNormalized: string;
  id: string;
  verificationProvider: typeof CUSTOMER_IDENTITY_PROVIDER;
  verifiedAt: Date;
}

export interface RecordCustomerSignInInput {
  customerUserId: string;
  displayName: string | null;
  email: string;
  emailNormalized: string;
  provider: typeof CUSTOMER_IDENTITY_PROVIDER;
  providerAccountId: string;
  signedInAt: Date;
}

export interface CustomerIdentityTransaction {
  createCustomer(input: CreateCustomerInput): Promise<void>;
  createProviderAccount(input: CreateProviderAccountInput): Promise<boolean>;
  createVerifiedEmail(input: CreateVerifiedEmailInput): Promise<boolean>;
  findProviderAccount(
    provider: typeof CUSTOMER_IDENTITY_PROVIDER,
    providerAccountId: string,
  ): Promise<CustomerIdentityLink | null>;
  findCustomerStatus(
    customerUserId: string,
  ): Promise<CustomerUserStatus | null>;
  findVerifiedEmail(
    emailNormalized: string,
  ): Promise<CustomerIdentityLink | null>;
  recordSignIn(input: RecordCustomerSignInInput): Promise<void>;
}

export interface CustomerIdentityStore {
  transaction<T>(
    operation: (transaction: CustomerIdentityTransaction) => Promise<T>,
  ): Promise<T>;
}

export type CustomerIdentityResolutionErrorCode =
  | "disabled_customer"
  | "invalid_identity"
  | "untrusted_provider"
  | "unverified_email";

export class CustomerIdentityResolutionError extends Error {
  constructor(public readonly code: CustomerIdentityResolutionErrorCode) {
    super("Customer identity could not be resolved");
    this.name = "CustomerIdentityResolutionError";
  }
}

export class CustomerIdentityConflictError extends Error {
  constructor() {
    super("Customer identity ownership conflict");
    this.name = "CustomerIdentityConflictError";
  }
}

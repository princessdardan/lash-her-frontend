import {
  CUSTOMER_IDENTITY_PROVIDER,
  CustomerIdentityConflictError,
  CustomerIdentityResolutionError,
  type CustomerIdentityResolutionInput,
  type CustomerIdentityStore,
  type CustomerIdentityTransaction,
} from "./types";

export interface CustomerIdentityResolverDependencies {
  generateId: () => string;
  now: () => Date;
  store: CustomerIdentityStore;
}

export interface CustomerIdentityResolver {
  resolve(input: CustomerIdentityResolutionInput): Promise<string>;
}

class CustomerIdentityUniquenessRaceError extends Error {}

const MAX_RESOLUTION_ATTEMPTS = 3;

export function normalizeVerifiedEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createCustomerIdentityResolver(
  dependencies: CustomerIdentityResolverDependencies,
): CustomerIdentityResolver {
  return {
    async resolve(input) {
      const identity = validateIdentity(input);

      for (let attempt = 0; attempt < MAX_RESOLUTION_ATTEMPTS; attempt += 1) {
        try {
          return await dependencies.store.transaction((transaction) =>
            resolveInTransaction(transaction, identity, dependencies),
          );
        } catch (error) {
          if (!(error instanceof CustomerIdentityUniquenessRaceError)) {
            throw error;
          }
        }
      }

      throw new CustomerIdentityConflictError();
    },
  };
}

interface ValidatedIdentity {
  displayName: string | null;
  email: string;
  emailNormalized: string;
  provider: typeof CUSTOMER_IDENTITY_PROVIDER;
  providerAccountId: string;
}

function validateIdentity(
  input: CustomerIdentityResolutionInput,
): ValidatedIdentity {
  if (input.provider !== CUSTOMER_IDENTITY_PROVIDER) {
    throw new CustomerIdentityResolutionError("untrusted_provider");
  }

  if (!input.emailVerified) {
    throw new CustomerIdentityResolutionError("unverified_email");
  }

  const email = input.email.trim();
  const emailNormalized = normalizeVerifiedEmail(input.email);
  const providerAccountId = input.providerAccountId.trim();

  if (!email || !emailNormalized || !providerAccountId) {
    throw new CustomerIdentityResolutionError("invalid_identity");
  }

  return {
    displayName: input.displayName?.trim() || null,
    email,
    emailNormalized,
    provider: CUSTOMER_IDENTITY_PROVIDER,
    providerAccountId,
  };
}

async function resolveInTransaction(
  transaction: CustomerIdentityTransaction,
  identity: ValidatedIdentity,
  dependencies: CustomerIdentityResolverDependencies,
): Promise<string> {
  const [providerAccount, verifiedEmail] = await Promise.all([
    transaction.findProviderAccount(
      identity.provider,
      identity.providerAccountId,
    ),
    transaction.findVerifiedEmail(identity.emailNormalized),
  ]);

  if (
    providerAccount !== null &&
    verifiedEmail !== null &&
    providerAccount.customerUserId !== verifiedEmail.customerUserId
  ) {
    throw new CustomerIdentityConflictError();
  }

  if (providerAccount === null && verifiedEmail !== null) {
    throw new CustomerIdentityConflictError();
  }

  const existingCustomerUserId =
    providerAccount?.customerUserId ?? verifiedEmail?.customerUserId;
  const signedInAt = dependencies.now();

  if (existingCustomerUserId !== undefined) {
    const customerStatus = await transaction.findCustomerStatus(
      existingCustomerUserId,
    );

    if (customerStatus === "disabled") {
      throw new CustomerIdentityResolutionError("disabled_customer");
    }

    if (customerStatus !== "active") {
      throw new CustomerIdentityResolutionError("invalid_identity");
    }

    if (
      verifiedEmail === null &&
      !(await transaction.createVerifiedEmail({
        createdAt: signedInAt,
        customerUserId: existingCustomerUserId,
        email: identity.email,
        emailNormalized: identity.emailNormalized,
        id: dependencies.generateId(),
        verificationProvider: identity.provider,
        verifiedAt: signedInAt,
      }))
    ) {
      throw new CustomerIdentityUniquenessRaceError();
    }

    if (
      providerAccount === null &&
      !(await transaction.createProviderAccount({
        createdAt: signedInAt,
        customerUserId: existingCustomerUserId,
        email: identity.email,
        emailNormalized: identity.emailNormalized,
        id: dependencies.generateId(),
        provider: identity.provider,
        providerAccountId: identity.providerAccountId,
        verifiedAt: signedInAt,
      }))
    ) {
      throw new CustomerIdentityUniquenessRaceError();
    }

    await recordSignIn(
      transaction,
      existingCustomerUserId,
      identity,
      signedInAt,
    );
    return existingCustomerUserId;
  }

  const customerUserId = dependencies.generateId();
  await transaction.createCustomer({
    createdAt: signedInAt,
    displayName: identity.displayName,
    id: customerUserId,
  });

  const verifiedEmailCreated = await transaction.createVerifiedEmail({
    createdAt: signedInAt,
    customerUserId,
    email: identity.email,
    emailNormalized: identity.emailNormalized,
    id: dependencies.generateId(),
    verificationProvider: identity.provider,
    verifiedAt: signedInAt,
  });

  if (!verifiedEmailCreated) {
    throw new CustomerIdentityUniquenessRaceError();
  }

  const providerAccountCreated = await transaction.createProviderAccount({
    createdAt: signedInAt,
    customerUserId,
    email: identity.email,
    emailNormalized: identity.emailNormalized,
    id: dependencies.generateId(),
    provider: identity.provider,
    providerAccountId: identity.providerAccountId,
    verifiedAt: signedInAt,
  });

  if (!providerAccountCreated) {
    throw new CustomerIdentityUniquenessRaceError();
  }

  return customerUserId;
}

async function recordSignIn(
  transaction: CustomerIdentityTransaction,
  customerUserId: string,
  identity: ValidatedIdentity,
  signedInAt: Date,
): Promise<void> {
  await transaction.recordSignIn({
    customerUserId,
    displayName: identity.displayName,
    email: identity.email,
    emailNormalized: identity.emailNormalized,
    provider: identity.provider,
    providerAccountId: identity.providerAccountId,
    signedInAt,
  });
}

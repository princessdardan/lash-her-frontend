import assert from "node:assert/strict";
import test from "node:test";

import { createCustomerIdentityResolver } from "./resolver";
import {
  CUSTOMER_IDENTITY_PROVIDER,
  CustomerIdentityConflictError,
  CustomerIdentityResolutionError,
  type CreateCustomerInput,
  type CreateProviderAccountInput,
  type CreateVerifiedEmailInput,
  type CustomerIdentityStore,
  type CustomerIdentityTransaction,
  type RecordCustomerSignInInput,
} from "./types";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const GOOGLE_IDENTITY = {
  displayName: "Customer",
  email: " Customer@Example.com ",
  emailVerified: true,
  provider: CUSTOMER_IDENTITY_PROVIDER,
  providerAccountId: "google-customer",
};

test("creates one customer identity and reuses its stable ID", async () => {
  const store = new InMemoryCustomerIdentityStore();
  const ids = ["customer-1", "email-1", "provider-1"];
  const resolver = createCustomerIdentityResolver({
    generateId: () => requiredShift(ids),
    now: () => NOW,
    store,
  });

  assert.equal(await resolver.resolve(GOOGLE_IDENTITY), "customer-1");
  assert.equal(await resolver.resolve(GOOGLE_IDENTITY), "customer-1");
  assert.deepEqual([...store.users], ["customer-1"]);
  assert.equal(store.verifiedEmails.get("customer@example.com"), "customer-1");
  assert.equal(
    store.providerAccounts.get("google:google-customer"),
    "customer-1",
  );
  assert.equal(ids.length, 0);
  assert.equal(store.signIns.length, 1);
});

test("rejects an unseen Google subject when only the verified email matches", async () => {
  const store = new InMemoryCustomerIdentityStore();
  store.users.add("existing-customer");
  store.verifiedEmails.set("customer@example.com", "existing-customer");
  const resolver = createCustomerIdentityResolver({
    generateId: () => "provider-link-id",
    now: () => NOW,
    store,
  });

  await assert.rejects(
    resolver.resolve(GOOGLE_IDENTITY),
    CustomerIdentityConflictError,
  );
  assert.equal(store.providerAccounts.size, 0);
  assert.equal(store.users.size, 1);
});

test("keeps an existing Google subject authoritative for a newly verified email", async () => {
  const store = new InMemoryCustomerIdentityStore();
  store.users.add("existing-customer");
  store.providerAccounts.set(
    "google:google-customer",
    "existing-customer",
  );
  const resolver = createCustomerIdentityResolver({
    generateId: () => "verified-email-id",
    now: () => NOW,
    store,
  });

  assert.equal(await resolver.resolve(GOOGLE_IDENTITY), "existing-customer");
  assert.equal(
    store.verifiedEmails.get("customer@example.com"),
    "existing-customer",
  );
  assert.equal(store.providerAccounts.size, 1);
});

test("fails closed when provider account and verified email have split ownership", async () => {
  const store = new InMemoryCustomerIdentityStore();
  store.users.add("provider-owner");
  store.users.add("email-owner");
  store.providerAccounts.set("google:google-customer", "provider-owner");
  store.verifiedEmails.set("customer@example.com", "email-owner");
  const resolver = createCustomerIdentityResolver({
    generateId: () => "unused",
    now: () => NOW,
    store,
  });

  await assert.rejects(resolver.resolve(GOOGLE_IDENTITY), (error: unknown) => {
    assert.ok(error instanceof CustomerIdentityConflictError);
    assert.equal(error.message, "Customer identity ownership conflict");
    assert.equal(error.message.includes("customer@example.com"), false);
    assert.equal(error.message.includes("google-customer"), false);
    return true;
  });
});

test("fails closed when a linked customer is disabled", async () => {
  const store = new InMemoryCustomerIdentityStore();
  store.users.add("disabled-customer");
  store.disabledUsers.add("disabled-customer");
  store.providerAccounts.set(
    "google:google-customer",
    "disabled-customer",
  );
  const resolver = createCustomerIdentityResolver({
    generateId: () => "unused",
    now: () => NOW,
    store,
  });

  await assert.rejects(
    resolver.resolve(GOOGLE_IDENTITY),
    (error: unknown) => {
      assert.ok(error instanceof CustomerIdentityResolutionError);
      assert.equal(error.code, "disabled_customer");
      assert.equal(error.message.includes("disabled-customer"), false);
      return true;
    },
  );
  assert.equal(store.providerAccounts.size, 1);
  assert.equal(store.verifiedEmails.size, 0);
});

test("rejects providers that are not allowlisted for verified-email linking", async () => {
  const store = new InMemoryCustomerIdentityStore();
  const resolver = createCustomerIdentityResolver({
    generateId: () => "unused",
    now: () => NOW,
    store,
  });

  await assert.rejects(
    resolver.resolve({ ...GOOGLE_IDENTITY, provider: "github" }),
    (error: unknown) => {
      assert.ok(error instanceof CustomerIdentityResolutionError);
      assert.equal(error.code, "untrusted_provider");
      return true;
    },
  );
  assert.equal(store.transactionCount, 0);
});

test("rereads and validates the winning identity after a uniqueness race", async () => {
  const store = new InMemoryCustomerIdentityStore();
  store.raceWinner = "winning-customer";
  const ids = ["losing-customer", "losing-email"];
  const resolver = createCustomerIdentityResolver({
    generateId: () => requiredShift(ids),
    now: () => NOW,
    store,
  });

  assert.equal(await resolver.resolve(GOOGLE_IDENTITY), "winning-customer");
  assert.deepEqual([...store.users], ["winning-customer"]);
  assert.equal(store.transactionCount, 2);
});

class InMemoryCustomerIdentityStore implements CustomerIdentityStore {
  disabledUsers = new Set<string>();
  providerAccounts = new Map<string, string>();
  raceWinner: string | null = null;
  signIns: RecordCustomerSignInInput[] = [];
  transactionCount = 0;
  users = new Set<string>();
  verifiedEmails = new Map<string, string>();

  async transaction<T>(
    operation: (transaction: CustomerIdentityTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    const users = new Set(this.users);
    const providerAccounts = new Map(this.providerAccounts);
    const verifiedEmails = new Map(this.verifiedEmails);
    const signIns = [...this.signIns];
    const transaction: CustomerIdentityTransaction = {
      createCustomer: async (input: CreateCustomerInput) => {
        users.add(input.id);
      },
      createProviderAccount: async (input: CreateProviderAccountInput) => {
        const key = `${input.provider}:${input.providerAccountId}`;

        if (providerAccounts.has(key)) {
          return false;
        }

        providerAccounts.set(key, input.customerUserId);
        return true;
      },
      createVerifiedEmail: async (input: CreateVerifiedEmailInput) => {
        if (this.raceWinner !== null) {
          const winner = this.raceWinner;
          this.raceWinner = null;
          this.users.add(winner);
          this.verifiedEmails.set(input.emailNormalized, winner);
          this.providerAccounts.set("google:google-customer", winner);
          return false;
        }

        if (verifiedEmails.has(input.emailNormalized)) {
          return false;
        }

        verifiedEmails.set(input.emailNormalized, input.customerUserId);
        return true;
      },
      findProviderAccount: async (provider, providerAccountId) => {
        const customerUserId = providerAccounts.get(
          `${provider}:${providerAccountId}`,
        );
        return customerUserId === undefined ? null : { customerUserId };
      },
      findCustomerStatus: async (customerUserId) => {
        if (!users.has(customerUserId)) {
          return null;
        }

        return this.disabledUsers.has(customerUserId) ? "disabled" : "active";
      },
      findVerifiedEmail: async (emailNormalized) => {
        const customerUserId = verifiedEmails.get(emailNormalized);
        return customerUserId === undefined ? null : { customerUserId };
      },
      recordSignIn: async (input: RecordCustomerSignInInput) => {
        signIns.push(input);
      },
    };

    const result = await operation(transaction);
    this.users = users;
    this.providerAccounts = providerAccounts;
    this.verifiedEmails = verifiedEmails;
    this.signIns = signIns;
    return result;
  }
}

function requiredShift(values: string[]): string {
  const value = values.shift();
  assert.ok(value);
  return value;
}

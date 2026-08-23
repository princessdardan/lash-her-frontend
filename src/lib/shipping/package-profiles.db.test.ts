import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run package profile approval tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, inArray } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { adminUsers, shippingPackageProfiles } from "./src/lib/private-db/schema.ts";
  import {
    approvePackageProfile,
    createPackageProfileDraft,
    disablePackageProfile,
    editPackageProfileDraft,
    listAllPackageProfiles,
  } from "./src/lib/shipping/package-profiles.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  const db = getPrivateDb();
  const fixture = crypto.randomUUID();
  const createdIds = [];
  let ownerId;

  const fields = (slug, overrides = {}) => ({
    slug,
    name: "Test box " + slug,
    rank: 10,
    packageType: "parcel",
    lengthCm: 30,
    widthCm: 22,
    heightCm: 5,
    tareWeightGrams: 90,
    maxWeightGrams: 2000,
    acceptsRigid: true,
    ...overrides,
  });

  try {
    const email = "package-profiles-" + fixture + "@example.invalid";
    const [owner] = await db.insert(adminUsers).values({
      providerUserId: "package-profiles-owner-" + fixture,
      email,
      emailNormalized: email,
      role: "owner",
      status: "active",
    }).returning({ id: adminUsers.id });
    ownerId = owner.id;
    process.env.ADMIN_OWNER_EMAILS = email;

    // create draft
    const slugA = "pkg-" + fixture + "-a";
    const created = await createPackageProfileDraft({ actorAdminUserId: ownerId, fields: fields(slugA) });
    createdIds.push(created.id);
    assert.equal(created.updatedAt instanceof Date, true);
    const [draftRow] = await db.select().from(shippingPackageProfiles).where(eq(shippingPackageProfiles.id, created.id));
    assert.equal(draftRow.enabled, false);
    assert.equal(draftRow.reviewedAt, null);
    assert.equal(draftRow.reviewAction, null);
    assert.equal(draftRow.reviewEvidenceHash, null);

    // duplicate slug conflicts
    await assert.rejects(() => createPackageProfileDraft({ actorAdminUserId: ownerId, fields: fields(slugA) }));

    // edit while draft
    const edited = await editPackageProfileDraft({
      actorAdminUserId: ownerId,
      id: created.id,
      expectedUpdatedAt: created.updatedAt,
      fields: fields(slugA, { maxWeightGrams: 2500 }),
    });
    const [editedRow] = await db.select().from(shippingPackageProfiles).where(eq(shippingPackageProfiles.id, created.id));
    assert.equal(editedRow.maxWeightGrams, 2500);

    // approve -> enable: the enabled_evidence_check CHECK must be satisfied (no throw)
    const submitted = fields(slugA, { maxWeightGrams: 2500 });
    const approved = await approvePackageProfile({
      actorAdminUserId: ownerId,
      id: created.id,
      expectedUpdatedAt: edited.updatedAt,
      evidenceReference: "measured-physical-box",
      stepUpAuthenticatedAt: new Date(),
      submitted,
    });
    assert.match(approved.reviewEvidenceHash, /^[0-9a-f]{64}$/);
    const [enabledRow] = await db.select().from(shippingPackageProfiles).where(eq(shippingPackageProfiles.id, created.id));
    assert.equal(enabledRow.enabled, true);
    assert.equal(enabledRow.reviewAction, "approve_shipping_package_profile");
    assert.equal(enabledRow.reviewEvidenceVersion, "owner-package-approval-v1");
    assert.equal(enabledRow.reviewedByAdminUserId, ownerId);
    assert.match(enabledRow.reviewEvidenceHash, /^[0-9a-f]{64}$/);
    assert.ok(enabledRow.reviewStepUpAuthenticatedAt.getTime() <= enabledRow.reviewedAt.getTime());
    assert.ok(enabledRow.reviewedAt.getTime() - enabledRow.reviewStepUpAuthenticatedAt.getTime() <= 5 * 60000);

    // editing an enabled profile conflicts (edit only while draft)
    await assert.rejects(() => editPackageProfileDraft({
      actorAdminUserId: ownerId,
      id: created.id,
      expectedUpdatedAt: approved.updatedAt,
      fields: submitted,
    }));

    // disable
    const disabled = await disablePackageProfile({
      actorAdminUserId: ownerId,
      id: created.id,
      expectedUpdatedAt: approved.updatedAt,
    });
    const [disabledRow] = await db.select().from(shippingPackageProfiles).where(eq(shippingPackageProfiles.id, created.id));
    assert.equal(disabledRow.enabled, false);
    assert.equal(disabled.updatedAt instanceof Date, true);

    // second draft for negative-path checks
    const slugB = "pkg-" + fixture + "-b";
    const draftB = await createPackageProfileDraft({ actorAdminUserId: ownerId, fields: fields(slugB) });
    createdIds.push(draftB.id);

    // stale step-up (older than 5 minutes) is rejected before any DB write
    await assert.rejects(() => approvePackageProfile({
      actorAdminUserId: ownerId,
      id: draftB.id,
      expectedUpdatedAt: draftB.updatedAt,
      evidenceReference: "measured-physical-box",
      stepUpAuthenticatedAt: new Date(Date.now() - 6 * 60000),
      submitted: fields(slugB),
    }));
    const [stillDraftB] = await db.select().from(shippingPackageProfiles).where(eq(shippingPackageProfiles.id, draftB.id));
    assert.equal(stillDraftB.enabled, false);

    // submitted fields that differ from the stored row are rejected
    await assert.rejects(() => approvePackageProfile({
      actorAdminUserId: ownerId,
      id: draftB.id,
      expectedUpdatedAt: draftB.updatedAt,
      evidenceReference: "measured-physical-box",
      stepUpAuthenticatedAt: new Date(),
      submitted: fields(slugB, { lengthCm: 99 }),
    }));

    // stale optimistic token is rejected
    await assert.rejects(() => disablePackageProfile({
      actorAdminUserId: ownerId,
      id: draftB.id,
      expectedUpdatedAt: new Date(0),
    }));

    // listAllPackageProfiles returns drafts and enabled rows
    const all = await listAllPackageProfiles();
    const ours = all.filter((row) => row.id === created.id || row.id === draftB.id);
    assert.equal(ours.length, 2);
  } finally {
    if (createdIds.length) {
      await db.delete(shippingPackageProfiles).where(inArray(shippingPackageProfiles.id, createdIds));
    }
    if (ownerId) {
      await db.delete(adminUsers).where(eq(adminUsers.id, ownerId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "package profile approval satisfies the enabled evidence constraint and lifecycle guards",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        scenario,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
      },
    );
  },
);

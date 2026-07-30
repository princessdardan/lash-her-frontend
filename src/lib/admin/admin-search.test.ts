import assert from "node:assert/strict";
import test from "node:test";

import { searchAdminItems, type AdminSearchItem } from "./admin-search";

function item(
  label: string,
  overrides: Partial<AdminSearchItem> = {},
): AdminSearchItem {
  return {
    description: "",
    group: "General",
    href: `/admin/${label.toLowerCase().replace(/\s+/g, "-")}`,
    keywords: [],
    label,
    navigation: true,
    ...overrides,
  };
}

test("blank queries return only navigation items in source order", () => {
  const items = [
    item("Dashboard"),
    item("Hidden action", { navigation: false }),
    item("Appointments"),
  ];

  assert.deepEqual(searchAdminItems(items, " \t "), [items[0], items[2]]);
});

test("finds settings through keywords", () => {
  const settings = item("Calendar connections", {
    keywords: ["configuration", "settings", "integration"],
  });

  assert.deepEqual(
    searchAdminItems([item("Dashboard"), settings], "settings"),
    [settings],
  );
});

test("requires every query token to match an item", () => {
  const calendar = item("Calendar connections", {
    description: "Manage provider integrations",
    keywords: ["staff assignments"],
  });
  const staff = item("Staff", {
    description: "Manage team members",
  });

  assert.deepEqual(searchAdminItems([staff, calendar], "staff calendar"), [
    calendar,
  ]);
});

test("normalizes case, diacritics, punctuation, and ampersands", () => {
  const notifications = item("Résumé & e-mail notifications");

  assert.deepEqual(searchAdminItems([notifications], "RESUME and E MAIL"), [
    notifications,
  ]);
});

test("ranks label matches ahead of other fields with stable ties", () => {
  const descriptionMatch = item("Team directory", {
    description: "Manage staff records",
  });
  const keywordMatch = item("Configuration", { keywords: ["staff"] });
  const phraseMatch = item("Manage staff schedules");
  const exactMatch = item("Staff");
  const firstPrefixMatch = item("Staff members");
  const secondPrefixMatch = item("Staff permissions");

  assert.deepEqual(
    searchAdminItems(
      [
        descriptionMatch,
        keywordMatch,
        phraseMatch,
        exactMatch,
        firstPrefixMatch,
        secondPrefixMatch,
      ],
      "staff",
    ),
    [
      exactMatch,
      firstPrefixMatch,
      secondPrefixMatch,
      phraseMatch,
      descriptionMatch,
      keywordMatch,
    ],
  );
});

test("returns an empty array when no item matches", () => {
  assert.deepEqual(searchAdminItems([item("Dashboard")], "payments"), []);
});

test("enforces explicit, default, and nonpositive limits", () => {
  const items = Array.from({ length: 12 }, (_, index) =>
    item(`Page ${index + 1}`),
  );

  assert.equal(searchAdminItems(items, "").length, 10);
  assert.deepEqual(searchAdminItems(items, "", 2), items.slice(0, 2));
  assert.deepEqual(searchAdminItems(items, "page", 0), []);
  assert.deepEqual(searchAdminItems(items, "page", -1), []);
});

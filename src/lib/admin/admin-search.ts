const DEFAULT_SEARCH_LIMIT = 10;

export type AdminSearchItem = {
  description: string;
  group: string;
  href: string;
  keywords: readonly string[];
  label: string;
  navigation: boolean;
};

type NormalizedAdminSearchItem = {
  description: string;
  group: string;
  keywords: string[];
  label: string;
};

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeItem(item: AdminSearchItem): NormalizedAdminSearchItem {
  return {
    description: normalizeSearchText(item.description),
    group: normalizeSearchText(item.group),
    keywords: item.keywords.map(normalizeSearchText),
    label: normalizeSearchText(item.label),
  };
}

function getMatchRank(item: NormalizedAdminSearchItem, query: string): number {
  if (item.label === query) {
    return 0;
  }

  if (item.label.startsWith(query)) {
    return 1;
  }

  if (item.label.includes(query)) {
    return 2;
  }

  return 3;
}

export function searchAdminItems(
  items: readonly AdminSearchItem[],
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
): AdminSearchItem[] {
  if (limit <= 0) {
    return [];
  }

  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return items.filter((item) => item.navigation).slice(0, limit);
  }

  const tokens = normalizedQuery.split(" ");

  return items
    .map((item, index) => {
      const normalizedItem = normalizeItem(item);
      const searchableFields = [
        normalizedItem.label,
        normalizedItem.group,
        normalizedItem.description,
        ...normalizedItem.keywords,
      ];

      if (
        !tokens.every((token) =>
          searchableFields.some((field) => field.includes(token)),
        )
      ) {
        return null;
      }

      return {
        index,
        item,
        rank: getMatchRank(normalizedItem, normalizedQuery),
      };
    })
    .filter(
      (
        match,
      ): match is {
        index: number;
        item: AdminSearchItem;
        rank: number;
      } => match !== null,
    )
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

import {
  AdminWorkspaceHeader,
  AdminWorkspaceResults,
  AdminWorkspaceSearch,
} from "@/components/admin/admin-workspace-list";
import { StatusPill } from "@/components/admin/status-pill";
import {
  listAdminProductStock,
  type AdminProductStockRow,
  type AdminStockStatus,
} from "@/lib/admin/inventory-workspace";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface AdminInventoryPageProps {
  searchParams: Promise<{
    page?: string | string[];
    q?: string | string[];
  }>;
}

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsePositivePage(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const STATUS_PRESENTATION: Record<
  AdminStockStatus,
  { label: string; tone: "attention" | "neutral" | "success" }
> = {
  sold_out: { label: "Sold out", tone: "attention" },
  low_stock: { label: "Low stock", tone: "attention" },
  in_stock: { label: "In stock", tone: "success" },
};

export default async function AdminInventoryPage({
  searchParams,
}: AdminInventoryPageProps) {
  await requireAdminPagePermission("inventory:view");
  const params = await searchParams;
  const result = await listAdminProductStock({
    page: parsePositivePage(firstString(params.page)),
    search: firstString(params.q),
  });

  return (
    <div className="space-y-6">
      <AdminWorkspaceHeader
        description={
          <p>
            Live units on hand and reserved for every tracked product and
            variant. Counts come from checkout in real time; set or restock
            quantities in Sanity Studio&mdash;a change there resets the on-hand
            count here. Items with no stock set in Sanity sell without limit and
            do not appear.
          </p>
        }
        eyebrow="Daily work"
        title="Inventory"
      />

      <AdminWorkspaceSearch
        action="/admin/inventory"
        label="Search product stock"
        placeholder="Search product or variant"
        search={result.search}
      />

      <p className="text-sm text-lh-muted">
        Low stock is {result.lowStockThreshold} or fewer available. Available =
        on hand &minus; reserved.
      </p>

      <AdminWorkspaceResults
        emptyMessage={
          result.search
            ? "No tracked products match this search."
            : "No products have stock tracking enabled yet. Set a stock quantity on a product in Sanity Studio to start tracking it."
        }
        page={result.page}
        pageCount={result.pageCount}
        pageSize={result.pageSize}
        path="/admin/inventory"
        rows={
          <>
            <div className="space-y-3 md:hidden">
              {result.rows.map((row) => (
                <InventoryCard key={rowKey(row)} row={row} />
              ))}
            </div>
            <InventoryTable rows={result.rows} />
          </>
        }
        search={result.search}
        total={result.total}
      />
    </div>
  );
}

function rowKey(row: AdminProductStockRow): string {
  return `${row.productId}:${row.variantKey ?? ""}`;
}

function InventoryTable({ rows }: { rows: AdminProductStockRow[] }) {
  return (
    <div className="hidden overflow-x-auto rounded-2xl border border-lh-line bg-white md:block">
      <table className="w-full min-w-[44rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-lh-line text-left text-xs uppercase tracking-[0.14em] text-lh-muted">
            <th className="px-4 py-3 font-semibold">Product</th>
            <th className="px-4 py-3 font-semibold">Variant</th>
            <th className="px-4 py-3 text-right font-semibold">Available</th>
            <th className="px-4 py-3 text-right font-semibold">On hand</th>
            <th className="px-4 py-3 text-right font-semibold">Reserved</th>
            <th className="px-4 py-3 text-right font-semibold">Last restock</th>
            <th className="px-4 py-3 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status = STATUS_PRESENTATION[row.status];
            return (
              <tr
                key={rowKey(row)}
                className="border-b border-lh-line/60 last:border-b-0"
              >
                <td className="px-4 py-3 font-medium text-lh-shadow">
                  {row.productTitle}
                </td>
                <td className="px-4 py-3 text-lh-muted">
                  {row.variantLabel ?? "—"}
                </td>
                <td className="px-4 py-3 text-right tabular-nums font-semibold text-lh-shadow">
                  {row.available}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-lh-muted">
                  {row.onHand}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-lh-muted">
                  {row.reserved}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-lh-muted">
                  {row.restockSetPoint ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <StatusPill tone={status.tone}>{status.label}</StatusPill>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function InventoryCard({ row }: { row: AdminProductStockRow }) {
  const status = STATUS_PRESENTATION[row.status];
  return (
    <div className="rounded-2xl border border-lh-line bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-lh-shadow">{row.productTitle}</p>
          {row.variantLabel ? (
            <p className="text-sm text-lh-muted">{row.variantLabel}</p>
          ) : null}
        </div>
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
      </div>
      <dl className="mt-3 grid grid-cols-4 gap-2 text-center text-sm">
        <div>
          <dt className="text-xs uppercase tracking-[0.12em] text-lh-muted">
            Available
          </dt>
          <dd className="mt-1 font-semibold tabular-nums text-lh-shadow">
            {row.available}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.12em] text-lh-muted">
            On hand
          </dt>
          <dd className="mt-1 tabular-nums text-lh-muted">{row.onHand}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.12em] text-lh-muted">
            Reserved
          </dt>
          <dd className="mt-1 tabular-nums text-lh-muted">{row.reserved}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.12em] text-lh-muted">
            Restock
          </dt>
          <dd className="mt-1 tabular-nums text-lh-muted">
            {row.restockSetPoint ?? "—"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

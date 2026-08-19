import { sql, type SQL } from "drizzle-orm";

export const ADMIN_FULFILLMENT_QUEUE_LIMIT = 500;

export function boundedFulfillmentQueueSelectionSql(
  limit = ADMIN_FULFILLMENT_QUEUE_LIMIT,
): SQL {
  return sql`
    , ranked_queue_items as (
      select
        queue_items.*,
        count(*) over (partition by queue)::int as queue_total,
        row_number() over (
          partition by queue
          order by deadline_at asc nulls last, id asc
        )::int as queue_position
      from queue_items
    )
    select
      queue,
      id,
      kind,
      title,
      detail,
      order_reference,
      deadline_at,
      state_version,
      conflict_token,
      evidence,
      queue_total,
      queue_position
    from ranked_queue_items
    where queue_position <= ${limit}
    order by deadline_at asc nulls last, queue asc, id asc
  `;
}

-- 003: Schema for the AI features (see docs/ai-features-plan.md).
-- Additive only: new nullable columns / tables, or columns with defaults, so every
-- existing row stays valid. 001 and 002 are not touched. Safe to run once on a
-- database that already holds orders, invoices and payments.

-- ---------------------------------------------------------------------------
-- Feature 1 (same as last time) + 2 (source trail) + 3 (substitutions): order items
-- ---------------------------------------------------------------------------
-- Which order a "same as last time" order was based on.
alter table orders add column if not exists based_on_order_id uuid references orders(id) on delete set null;

-- The exact text/phrase/photo line an item came from (null for old and manual items).
alter table order_items add column if not exists source_text text;
-- Where the line came from (null for orders created before 003).
alter table order_items add column if not exists origin text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_origin_check') then
    alter table order_items add constraint order_items_origin_check
      check (origin in ('parsed', 'previous_order', 'manual', 'substitution'));
  end if;
end $$;
-- A substitute line points at the original line it replaces (same order).
alter table order_items add column if not exists substitutes_item_id uuid references order_items(id) on delete set null;
create index if not exists order_items_substitutes_idx on order_items(substitutes_item_id) where substitutes_item_id is not null;

-- ---------------------------------------------------------------------------
-- Feature 3: smart substitutions
-- ---------------------------------------------------------------------------
-- Products are only suggested for each other when they share a group (e.g. 'sugar').
-- Null = never suggested (category alone is too broad: sugar and salt are both Staples/kg).
alter table products add column if not exists substitute_group text;
create index if not exists products_substitute_group_idx on products(substitute_group) where substitute_group is not null;

create table if not exists substitution_suggestions (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders(id) on delete cascade,
  original_item_id  uuid not null references order_items(id) on delete cascade,
  product_id        uuid not null references products(id) on delete restrict,
  quantity          numeric(12,3) not null check (quantity > 0),
  rank              smallint not null check (rank between 1 and 2),
  reason            text,
  status            text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'expired')),
  decided_by        uuid references users(id) on delete set null,
  decided_at        timestamptz,
  created_item_id   uuid references order_items(id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (original_item_id, product_id)
);
create index if not exists substitution_suggestions_order_idx on substitution_suggestions(order_id, status);
-- At most one accepted substitute per original line.
create unique index if not exists substitution_suggestions_one_accepted
  on substitution_suggestions(original_item_id) where status = 'accepted';

-- ---------------------------------------------------------------------------
-- Feature 4: supplier bill scan
-- ---------------------------------------------------------------------------
create table if not exists supplier_bills (
  id             uuid primary key default gen_random_uuid(),
  supplier_name  text,
  bill_number    text,
  bill_date      date,
  file_path      text not null,
  file_sha256    text not null,
  status         text not null default 'draft' check (status in ('draft', 'applied', 'discarded')),
  extracted      jsonb not null,           -- model output as validated
  applied_lines  jsonb,                    -- what the owner confirmed
  total          numeric(12,2),
  created_by     uuid references users(id) on delete set null,
  applied_by     uuid references users(id) on delete set null,
  applied_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists supplier_bills_created_idx on supplier_bills(created_at desc);
-- The same bill cannot be applied twice: by supplier + number + date ...
create unique index if not exists supplier_bills_applied_once
  on supplier_bills (lower(btrim(supplier_name)), lower(btrim(bill_number)), bill_date)
  where status = 'applied' and bill_number is not null and supplier_name is not null and bill_date is not null;
-- ... or by the identical image.
create unique index if not exists supplier_bills_applied_file_once
  on supplier_bills (file_sha256) where status = 'applied';
-- One inward movement per product per bill.
create unique index if not exists stock_movements_bill_once
  on stock_movements (ref_type, ref_id, product_id) where ref_type = 'supplier_bill';

-- ---------------------------------------------------------------------------
-- Feature 5: ready-time estimate (null for old orders = nothing shown)
-- ---------------------------------------------------------------------------
alter table orders add column if not exists ready_estimate_minutes int;
alter table orders add column if not exists ready_estimate_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_ready_estimate_minutes_check') then
    alter table orders add constraint orders_ready_estimate_minutes_check check (ready_estimate_minutes >= 0);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Feature 7: reorder nudges
-- ---------------------------------------------------------------------------
-- Orders created from a nudge. Old values are kept, so existing rows stay valid.
alter table orders drop constraint if exists orders_channel_check;
alter table orders add constraint orders_channel_check
  check (channel in ('text', 'photo', 'voice', 'counter', 'nudge'));

create table if not exists reorder_nudge_dismissals (
  customer_id   uuid not null references customers(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  dismissed_at  timestamptz not null default now(),
  primary key (customer_id, product_id)
);

-- ---------------------------------------------------------------------------
-- Same lock-down as 001/002 for the new tables.
-- ---------------------------------------------------------------------------
alter table substitution_suggestions  enable row level security;
alter table supplier_bills            enable row level security;
alter table reorder_nudge_dismissals  enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on substitution_suggestions, supplier_bills, reorder_nudge_dismissals from %I', r);
    end if;
  end loop;
end $$;

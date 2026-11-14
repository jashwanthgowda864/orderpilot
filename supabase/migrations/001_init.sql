-- OrderPilot core schema (001)
-- Compatible with Postgres 15+ (Supabase hosted) and plain Postgres for local dev.
-- Never edit this file after it has been applied; add a new numbered migration instead.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Shop settings (single row)
-- ---------------------------------------------------------------------------
create table if not exists shop_settings (
  id            smallint primary key default 1 check (id = 1),
  name          text not null,
  phone         text,
  address       text,
  tax_rate      numeric(5,2) not null default 0 check (tax_rate >= 0 and tax_rate <= 100),
  currency      text not null default 'INR',
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Customers and users
-- balance > 0 means the customer owes the shop.
-- ---------------------------------------------------------------------------
create table if not exists customers (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  phone               text not null unique,
  preferred_language  text check (preferred_language in ('en','kn','hi')),   -- nullable
  address             text,                                                  -- nullable
  credit_limit        numeric(12,2) not null default 0 check (credit_limit >= 0),
  balance             numeric(12,2) not null default 0,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists users (
  id             uuid primary key default gen_random_uuid(),
  phone          text not null unique,
  name           text not null,
  password_hash  text not null,
  role           text not null check (role in ('customer','staff','owner')),
  customer_id    uuid references customers(id) on delete restrict,         -- required for role=customer
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  constraint users_customer_link check (
    (role = 'customer' and customer_id is not null) or (role <> 'customer' and customer_id is null)
  )
);
create unique index if not exists users_customer_id_uniq on users(customer_id) where customer_id is not null;

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
create table if not exists products (
  id             uuid primary key default gen_random_uuid(),
  sku            text not null unique,
  name           text not null,
  name_kn        text,                              -- nullable
  name_hi        text,                              -- nullable
  aliases        text[] not null default '{}',
  category       text not null,
  unit           text not null check (unit in ('kg','g','l','ml','pcs','pack')),
  pack_size      numeric(10,3) not null default 1 check (pack_size > 0),
  price          numeric(12,2) not null check (price >= 0),   -- price per sellable unit (one pack)
  stock_qty      numeric(12,3) not null default 0 check (stock_qty >= 0),  -- in sellable units
  reorder_level  numeric(12,3) not null default 0 check (reorder_level >= 0),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists products_category_idx on products(category);

-- ---------------------------------------------------------------------------
-- Orders
-- Status flow (enforced in server/src/services/rules.js):
--   needs_clarification -> draft -> submitted -> approved -> picking -> ready -> collected
--   cancel: needs_clarification|draft|submitted -> cancelled ; reject: submitted -> rejected
-- ---------------------------------------------------------------------------
create table if not exists orders (
  id                  uuid primary key default gen_random_uuid(),
  order_no            bigint generated always as identity unique,
  customer_id         uuid not null references customers(id) on delete restrict,
  created_by          uuid references users(id) on delete set null,
  channel             text not null check (channel in ('text','photo','voice','counter')),
  status              text not null default 'draft' check (status in
                        ('needs_clarification','draft','submitted','approved','picking','ready','collected','rejected','cancelled')),
  raw_text            text,                -- nullable: typed text
  transcript          text,                -- nullable: model transcript of voice/photo
  input_file_path     text,                -- nullable: path in private storage bucket
  language            text,                -- nullable: detected language (en/kn/hi/other)
  notes               text,
  subtotal            numeric(12,2) not null default 0,
  idempotency_key     text unique,         -- nullable
  approved_by         uuid references users(id) on delete set null,
  approved_at         timestamptz,
  picking_started_at  timestamptz,
  ready_at            timestamptz,
  collected_at        timestamptz,
  rejected_reason     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists orders_customer_idx on orders(customer_id, created_at desc);
create index if not exists orders_status_idx on orders(status, created_at);

create table if not exists order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  position     int not null default 0,
  product_id   uuid references products(id) on delete restrict,   -- nullable while unmatched
  sku          text,                                               -- nullable while unmatched
  name         text not null,                                      -- product name or raw name
  quantity     numeric(12,3) not null check (quantity > 0),
  unit         text,
  unit_price   numeric(12,2),                                      -- nullable while unmatched
  confidence   text check (confidence in ('high','medium','low')), -- nullable (manual items)
  pick_status  text not null default 'pending' check (pick_status in ('pending','packed','short','unavailable')),
  packed_qty   numeric(12,3) check (packed_qty >= 0),              -- nullable until picked
  created_at   timestamptz not null default now()
);
create index if not exists order_items_order_idx on order_items(order_id, position);
create index if not exists order_items_product_idx on order_items(product_id);

create table if not exists order_clarifications (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  item_id      uuid references order_items(id) on delete cascade,  -- nullable: general question
  kind         text not null check (kind in ('choose_product','quantity','free_text')),
  question     text not null,
  options      jsonb not null default '[]'::jsonb,                 -- [{sku,name,price,unit}]
  answer       jsonb,                                              -- nullable until answered
  answered_by  uuid references users(id) on delete set null,
  answered_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists order_clarifications_order_idx on order_clarifications(order_id);

create table if not exists order_status_history (
  id           bigint generated always as identity primary key,
  order_id     uuid not null references orders(id) on delete cascade,
  from_status  text,
  to_status    text not null,
  changed_by   uuid references users(id) on delete set null,
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists order_status_history_order_idx on order_status_history(order_id, created_at);

-- ---------------------------------------------------------------------------
-- Stock movements: the ONLY way products.stock_qty changes (services/stock.js).
-- quantity is signed: inward > 0, sale < 0, adjustment/return either sign.
-- ---------------------------------------------------------------------------
create table if not exists stock_movements (
  id          bigint generated always as identity primary key,
  product_id  uuid not null references products(id) on delete restrict,
  type        text not null check (type in ('inward','sale','adjustment','return')),
  quantity    numeric(12,3) not null check (quantity <> 0),
  unit_cost   numeric(12,2),            -- nullable
  ref_type    text,                     -- e.g. 'order_item', 'manual'
  ref_id      text,                     -- nullable
  note        text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists stock_movements_product_idx on stock_movements(product_id, created_at desc);
-- A sale for a given order item can only be recorded once.
create unique index if not exists stock_movements_sale_once
  on stock_movements(ref_type, ref_id) where type = 'sale';

-- ---------------------------------------------------------------------------
-- Invoices, payments, ledger
-- ---------------------------------------------------------------------------
create table if not exists invoices (
  id           uuid primary key default gen_random_uuid(),
  invoice_no   bigint generated always as identity unique,
  order_id     uuid not null unique references orders(id) on delete restrict,  -- one invoice per order
  customer_id  uuid not null references customers(id) on delete restrict,
  lines        jsonb not null,           -- snapshot: [{sku,name,quantity,unit,unit_price,line_total}]
  subtotal     numeric(12,2) not null,
  tax          numeric(12,2) not null default 0,
  total        numeric(12,2) not null,
  created_at   timestamptz not null default now()
);
create index if not exists invoices_customer_idx on invoices(customer_id, created_at desc);

create table if not exists payments (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references customers(id) on delete restrict,
  amount           numeric(12,2) not null check (amount > 0),
  method           text not null check (method in ('cash','upi','card','other')),
  reference        text,
  note             text,
  idempotency_key  text unique,          -- nullable
  received_by      uuid references users(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists payments_customer_idx on payments(customer_id, created_at desc);

-- Every change to customers.balance has exactly one ledger row.
create table if not exists customer_ledger (
  id           bigint generated always as identity primary key,
  customer_id  uuid not null references customers(id) on delete restrict,
  entry_type   text not null check (entry_type in ('invoice','payment','adjustment')),
  amount       numeric(12,2) not null,   -- +owed (invoice), -paid (payment)
  ref_id       uuid,
  balance_after numeric(12,2) not null,
  created_at   timestamptz not null default now()
);
create unique index if not exists customer_ledger_ref_once
  on customer_ledger(entry_type, ref_id) where ref_id is not null;
create index if not exists customer_ledger_customer_idx on customer_ledger(customer_id, created_at desc);

-- ---------------------------------------------------------------------------
-- AI event log (every model call)
-- ---------------------------------------------------------------------------
create table if not exists ai_events (
  id            bigint generated always as identity primary key,
  kind          text not null,           -- e.g. 'parse_order'
  status        text not null check (status in ('ok','error')),
  model         text,
  mock          boolean not null default false,
  user_id       uuid references users(id) on delete set null,
  order_id      uuid references orders(id) on delete set null,
  input_summary text,
  output        jsonb,
  error         text,
  latency_ms    int,
  created_at    timestamptz not null default now()
);
create index if not exists ai_events_kind_idx on ai_events(kind, created_at desc);

-- ---------------------------------------------------------------------------
-- Migration bookkeeping is handled by server/src/scripts/migrate.js (schema_migrations).
-- Lock down tables from Supabase's public REST API: the browser never talks to
-- the database directly; only the server (table owner) does.
-- ---------------------------------------------------------------------------
alter table shop_settings         enable row level security;
alter table customers             enable row level security;
alter table users                 enable row level security;
alter table products              enable row level security;
alter table orders                enable row level security;
alter table order_items           enable row level security;
alter table order_clarifications  enable row level security;
alter table order_status_history  enable row level security;
alter table stock_movements       enable row level security;
alter table invoices              enable row level security;
alter table payments              enable row level security;
alter table customer_ledger       enable row level security;
alter table ai_events             enable row level security;

-- Private storage bucket for order photos / voice notes (Supabase only).
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public)
    values ('order-files', 'order-files', false)
    on conflict (id) do nothing;
  end if;
end $$;

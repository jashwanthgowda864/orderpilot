# OrderPilot — AI features: Step 1 analysis and Step 2 plan

Status (2026-11-14): plan approved. **Feature 1 (same as last time) is built and tested. Features 2–8 are PAUSED** — this document is kept as the plan for later.
Migration `003_ai_features.sql` already contains the (additive, unused-until-built) schema for all 8 features and is applied to local and Mumbai.
Verified against the code in this repo and the live Mumbai database on 2026-11-14.

---

## Step 1 — What exists today

### Database (`supabase/migrations/`)

| Migration | What it does |
|---|---|
| `001_init.sql` | All tables below, checks, indexes, RLS on every table, private bucket `order-files` |
| `002_lock_down_api_roles.sql` | Revokes all table/sequence/function privileges from Supabase `anon` / `authenticated` (and default privileges for future tables) |

Tables (nullable columns marked *null*):

| Table | Columns |
|---|---|
| `shop_settings` (single row, `id = 1`) | name, phone *null*, address *null*, tax_rate 0–100, currency, updated_at |
| `customers` | id, name, phone **unique**, preferred_language *null* ∈ en/kn/hi, address *null*, credit_limit ≥ 0, balance (> 0 = owes), active, created_at, updated_at |
| `users` | id, phone **unique**, name, password_hash, role ∈ customer/staff/owner, customer_id *null* (required iff role = customer, unique), active, created_at |
| `products` | id, sku **unique**, name, name_kn *null*, name_hi *null*, aliases text[], category (free text), unit ∈ kg/g/l/ml/pcs/pack, pack_size > 0, price ≥ 0 (per pack), stock_qty ≥ 0 (packs), reorder_level ≥ 0, active, created_at, updated_at |
| `orders` | id, order_no (identity, unique), customer_id, created_by *null*, channel ∈ text/photo/voice/counter, status (see lifecycle), raw_text *null*, transcript *null*, input_file_path *null*, language *null* (en/kn/hi/other — not constrained), notes *null*, subtotal, idempotency_key *null* **unique**, approved_by *null*, approved_at *null*, picking_started_at *null*, ready_at *null*, collected_at *null*, rejected_reason *null*, created_at, updated_at |
| `order_items` | id, order_id (cascade), position, product_id *null* (null while unmatched), sku *null*, name, quantity > 0, unit *null*, unit_price *null*, confidence *null* ∈ high/medium/low, pick_status ∈ pending/packed/short/unavailable, packed_qty *null* ≥ 0, created_at |
| `order_clarifications` | id, order_id, item_id *null* (cascade), kind ∈ choose_product/quantity/free_text, question, options jsonb, answer jsonb *null*, answered_by *null*, answered_at *null*, created_at |
| `order_status_history` | id, order_id, from_status *null*, to_status, changed_by *null*, note *null*, created_at |
| `stock_movements` | id, product_id, type ∈ inward/sale/adjustment/return, quantity ≠ 0 (signed), unit_cost *null*, ref_type *null*, ref_id *null* (text), note *null*, created_by *null*, created_at. **Unique (ref_type, ref_id) where type = 'sale'** |
| `invoices` | id, invoice_no (identity), order_id **unique**, customer_id, lines jsonb (snapshot), subtotal, tax, total, created_at |
| `payments` | id, customer_id, amount > 0, method ∈ cash/upi/card/other, reference *null*, note *null*, idempotency_key *null* **unique**, received_by *null*, created_at |
| `customer_ledger` | id, customer_id, entry_type ∈ invoice/payment/adjustment, amount (signed), ref_id *null*, balance_after, created_at. **Unique (entry_type, ref_id)** |
| `ai_events` | id, kind, status ∈ ok/error, model *null*, mock, user_id *null*, order_id *null*, input_summary *null*, output jsonb *null*, error *null*, latency_ms *null*, created_at |
| `schema_migrations` | filename, checksum, applied_at (created by `server/src/scripts/migrate.js`) |

Not present: suppliers, purchase bills, product cost price, product "family"/substitute grouping, notifications, a scheduler, a shop time zone.

### Backend (`server/src/`)

- **Middleware.** `middleware/auth.js` checks the JWT (HS256, 12 h) and reloads the user, rejecting inactive accounts. `middleware/roles.js` provides `requireRole(...)` and `assertCustomerAccess`. `middleware/validate.js` applies strict Zod schemas from `validators/*` and puts the result in `req.valid`. `middleware/error.js` defines `HttpError(status, message, details, code)` and maps Postgres codes to 4xx.
- **Routes** (all under `/api`; JWT required except `/auth/login`):
  - `routes/orders.js`: `GET /orders`, `GET /orders/pick-queue`, `POST /orders/parse` (multipart), `POST /orders` (staff counter, SKUs), `GET /orders/:id`, `GET /orders/:id/file`, `PUT /orders/:id/items`, `POST /orders/:id/clarifications/:clarId/answer`, `POST /orders/:id/{submit,cancel,approve,reject,start-picking,finish-packing,collect}`, `PATCH /orders/:id/items/:itemId/pick`.
  - `routes/products.js`: `GET/POST/PATCH /products`, `GET/POST /stock/movements` (owner).
  - `routes/customers.js`: `GET/POST/PATCH /customers`, `GET /customers/me`, `GET/POST /payments`.
  - `routes/misc.js`: `GET /invoices/:id`, `GET/PATCH /settings/shop`, `GET /dashboard`, `GET /ai-events` (owner).
- **Services:**
  - `rules.js`: the status machine and a compare-and-set `transition()` that also writes history.
  - `orders.js`: parse → `buildDraft` → clarifications → review → submit/approve/reject/cancel.
  - `fulfilment.js`: start picking, pick item, finish packing, collect.
  - `invoice.js`: one invoice per order, built from packed lines.
  - `stock.js`: `applyMovement`, the **only** path that changes stock; a conditional update keeps stock ≥ 0.
  - `ledger.js`: `applyLedger`. `payments.js`: `recordPayment`, idempotent.
  - `storage.js`: Supabase private bucket, 5-minute signed URLs, one retry, 503 when unreachable.
  - `catalogMatch.js` and `mockParser.js`: deterministic matching. `aiEvents.js`: `logAiEvent`, which never throws.
- **Transactions and idempotency.** Every write runs inside `withTransaction`, with `SELECT … FOR UPDATE` on the order. The following are unique: order and payment idempotency keys; invoice per order; sale movement per order item; ledger row per invoice and per payment. Finish-packing and collect are safe to repeat.

### Gemini (`server/src/services/gemini.js`)

- **Calls:** REST `generateContent` with `responseMimeType: application/json`, a response schema and temperature 0.1. Main model `gemini-3.5-flash`, fallback `gemini-3.1-flash-lite`.
- **Files:** sent inline as base64, up to 10 MB. Images are checked by magic bytes; audio types are webm/ogg/mp4/mp3/wav/aac.
- **Failure policy:** 25 s per attempt → one retry on 503/429/5xx, timeout or network error (about 1.5 s backoff) → fallback model → `503 ai_busy` ("AI is busy, please try again."). Nothing is written unless an attempt succeeds, and every attempt is logged to `ai_events`.
- **Output validation:** checked with Zod. Item fields: sku, name, quantity, unit (enum), confidence, candidates; plus language, transcript and questions. SKUs are always re-checked against the catalog. Mock mode is used when there is no key.

### Frontend (`client/src/`)

- **Auth and routing:** `auth.jsx` provides `AuthProvider` (JWT in localStorage, `/auth/me`). `App.jsx` handles `RequireRole` routing: customer `/`, `/account`; staff `/staff`, `/counter`, `/pick`, `/customers`; owner adds `/owner` and `/products`. `api.js` is the fetch wrapper, with `ApiError.code`.
- **Order input:** `OrderInput.jsx` has text/photo/voice tabs, an idempotency key, a staged loading message, and keeps the input on failure.
- **Clarification:** `Clarifications.jsx` offers product options, catalog search, quantity, free text, or remove/skip.
- **Review:** `ReviewItems.jsx` edits draft items. Low confidence is highlighted, but the source text is not shown.
- **Pick list:** `PickList.jsx` and `PickOrder.jsx` mark items packed/short/unavailable, show stock, and offer "Finish packing" with "mark remaining packed".
- **Approvals and order detail:** `OrderPage.jsx` covers approve/reject/start picking/cancel/collect with payment, and refreshes every 15 s while the order is active.

### Order lifecycle, as implemented (`rules.js`)

`needs_clarification → draft → submitted → approved → picking → ready → collected`

- **Cancel:** customer, staff or owner from needs_clarification, draft or submitted; staff or owner only from approved or picking.
- **Reject:** staff or owner from submitted.
- **When stock and balance change:** only at `picking → ready` (finish packing), in one transaction.

### Seed data

- **Accounts and catalog:** 1 owner, 1 staff, 3 customers with logins, 1 walk-in customer (no login), 32 products in 8 categories.
- **Past orders:** 11 (10 collected, 1 ready), with invoices, sale movements and 7 payments.
- **History useful for the new features:**
  - Ramesh: sugar and toor dal weekly (6×), oil and tea fortnightly (3×), milk 3×; last order 7 days ago.
  - Fatima: atta and moong dal every 10 days (3×); last order 10 days ago.
  - Anita: last order is still `ready`.
- **Balances:** Ramesh owes ₹998 (prefers Kannada, last paid 7 Nov); Anita owes ₹1,142 (no language preference; last order language `en`); Fatima ₹0.
- **Order language:** every seeded order has `language = 'en'`.

### Your brief vs what exists

| Brief assumes | Reality | Consequence |
|---|---|---|
| New migration `002_ai_features.sql` | `002` is taken (API lock-down) | Use **`003_ai_features.sql`** |
| Customer "gets a notification" | No notification channel (no SMS/WhatsApp/push) | In-app only: banner on the customer's order page and home, picked up by the existing 15 s refresh |
| Substitutions "same category" | Category is too broad (sugar/salt/rice share *Staples, kg*) | Add a nullable `products.substitute_group`; **no group = no suggestions** |
| Background scheduler | None exists | Nudges are on request (as you specified) |
| Store bill image in existing private bucket | Exists (`order-files`) | Use path prefix `supplier-bills/` |
| Supplier data | No supplier table | Store supplier name on the bill record; no supplier master |
| "This week" questions | No shop time zone | Config `SHOP_TIMEZONE`, default `Asia/Kolkata` |
| Answer in Kannada/Hindi | No translation layer | Fixed templates per language (numbers never come from the model); wording needs a native check |

---

## Step 2 — Plan per feature

The new tables and columns go into **one new migration, `003_ai_features.sql`**. It uses only `ALTER … ADD COLUMN IF NOT EXISTS` and `CREATE … IF NOT EXISTS`, all new columns are nullable or have defaults, and RLS is enabled on new tables. 001 and 002 are untouched, and existing rows stay valid. Every new route uses `requireAuth` plus `requireRole`, takes strict Zod input, and logs AI calls to `ai_events`.

### 1. "Same as last time" orders

- **Data needed:** the customer's latest order with `status IN ('collected','ready')` and its items (sku, name, quantity). This exists.
- **Schema changes:**
  - `orders.based_on_order_id uuid null` (FK `orders`, `on delete set null`).
  - `order_items.origin text null`, checked against parsed/previous_order/manual/substitution. This is shared with features 2 and 3.
- **Backend (`services/orders.js`):** `createOrderFromInput` loads the previous order (if any) for the resolved customer, including in counter mode.
- **Backend (`services/gemini.js`):** `parseOrder` gains an optional `previousOrder`. The prompt gets a `PREVIOUS ORDER` block only when one exists. The output schema gains `from_previous: boolean` per item and `refers_to_previous: boolean` overall; existing fields are unchanged.
- **Server-side check:** an item counts as `previous_order` only if its SKU really is in that order.
- **No history:** if `refers_to_previous` is true but there's no previous order, a `free_text` clarification is added: "We don't have an earlier order for you yet — what would you like?"
- **Frontend:** a "from your last order (#N)" tag on those items in the review and order pages.
- **Conflicts:** none. Prices come from the current catalog at submit, not the old order. Inactive products from the old order become `choose_product` clarifications.
- **Edge cases:**
  - "last order plus 2 sugar" where sugar was already in it: the model must return one line with the *total*. The prompt says so, and the server merges duplicate SKUs.
  - "same as last week" while the last order is still `ready`: that order is used, as specified.
- **Open point:** answering the free-text clarification currently only adds a note; it doesn't add items. Proposal: when an order has **zero items**, the free-text answer is parsed like a new order (same failure policy, no partial writes). Otherwise the customer adds items on the review screen.

### 2. Source trail and confidence

- **Data needed:** `confidence` already exists per item. The source text doesn't exist.
- **Schema change:** `order_items.source_text text null`. I chose a column over JSON because there's no per-item JSON field, and `ai_events.output` isn't reliably tied to items.
- **Backend (`gemini.js`):** the output schema gains `source_text` (string, max 300) per item. Zod is tolerant: an odd or missing value becomes null and never fails the order.
- **Backend (`orders.js`):** `insertItems` stores the source text. Items edited or added in review are `origin = manual` with no source text. Changing an item's SKU keeps its source text but clears its confidence (current behaviour).
- **Frontend:** the review, order and pick pages show "from: '…'" under each item. **Low** confidence gets an amber row plus a "check" label; medium shows a subtle label. Old orders with `source_text` null show nothing extra.
- **Conflicts:** none.

### 3. Smart substitutions

- **Data needed:** `products.category`, `unit`, `pack_size`, `stock_qty`, `active` all exist. **Missing:** a safe notion of "same kind of product".
- **Schema changes:**
  - `products.substitute_group text null`, e.g. `sugar`, `rice-sona`, `cooking-oil`, `tea`. The seed sets groups; the owner can edit them on the Products page.
  - New table `substitution_suggestions`: id, order_id, original_item_id, product_id, quantity, rank (1–2), reason, status ∈ pending/accepted/declined/expired, decided_by, decided_at, created_item_id, created_at.
    - Unique (original_item_id, product_id).
    - Partial unique index: at most one accepted suggestion per original item.
  - `order_items.substitutes_item_id uuid null` (FK `order_items`).
- **Deterministic rules** (`services/substitutions.js`):
  - Candidates are active, in stock, share the same `substitute_group` and the same unit family, and aren't the original SKU.
  - Quantity = the shortfall converted to the candidate's pack size (e.g. 1 × 10 kg → 2 × 5 kg). Exact multiples rank first, then by closest price per base unit. Only candidates with enough stock count.
  - At most 2. Gemini is only used to reorder when more than 2 qualify. A Gemini failure doesn't block anything; the deterministic order is kept.
  - No group, or no candidate: "No alternative available" is shown to staff.
- **Flow (stays in `picking`, no new status):**
  1. Staff marks an item short or unavailable. The suggestions are created in the same transaction as the pick update.
  2. The customer sees them on their order page and accepts or declines each one. Staff can do the same at the counter.
  3. **Accept** (transaction, re-checks stock): adds an order item with `origin = substitution` and `substitutes_item_id`, `pick_status = pending`, at the current price. Any other pending suggestion for that original item becomes `expired`.
  4. **Decline:** status changes only; nothing else.
  5. **Finish packing:** if any suggestion is still pending, it returns 409 with the list, unless staff send `proceed_without_substitutes: true`. That marks them `expired` (the timeout/fallback). The pick screen shows how long the customer has been waiting; a soft limit of `SUBSTITUTION_WAIT_MINUTES` (default 10) highlights "Proceed without".
- **Stock and invoice:** unchanged code paths. Finish packing already deducts stock and invoices only `packed_qty`. The original line keeps its real packed quantity (0 or partial); the substitute is its own line, so nothing is counted twice. Invoice lines gain an optional `substitutes_sku` key, which is backward compatible.
- **Guards:**
  - An original item with an accepted substitute can't be switched back to fully `packed`.
  - Accept/decline only works while the order is `picking`.
  - Customers can only act on their own orders.
- **Edge cases:**
  - Stock taken by another order before accept: 409 "no longer available".
  - Order cancelled: suggestions remain inert.
  - Two staff marking at once: the order row lock serialises it.

### 4. Supplier bill scan to add stock (owner)

- **Data needed:** products by SKU, name and aliases (exists); `stock_movements.unit_cost` (exists). No supplier or bill data exists.
- **Schema change:** new table `supplier_bills`:
  - Columns: id, supplier_name *null*, bill_number *null*, bill_date *null*, file_path, file_sha256, status ∈ draft/applied/discarded, extracted jsonb, applied_lines jsonb *null*, total *null*, created_by, applied_by *null*, applied_at *null*, created_at.
  - Duplicate guards: unique on (lower(trim(supplier_name)), lower(trim(bill_number)), bill_date) where status = 'applied' and bill_number is not null; unique `file_sha256` where status = 'applied'.
  - Partial unique index on `stock_movements (ref_type, ref_id, product_id)` where ref_type = 'supplier_bill', so one movement per product per bill.
- **Backend (new `routes/supplierBills.js`, owner only):**
  - `POST /supplier-bills/scan` (image): Gemini extracts the bill; the image goes to `supplier-bills/…`; a `draft` row is created. The failure policy is the same, and nothing is saved on failure.
  - `GET /supplier-bills/:id`.
  - `POST /supplier-bills/:id/apply` with `{supplier_name, bill_number, bill_date, lines:[{product_id|null(skip), packs, unit_cost}]}`. In one transaction: lock the bill, check it's still a draft, run the duplicate check, then one `applyMovement(type 'inward', ref_type 'supplier_bill', ref_id bill.id)` per product (duplicate lines are merged), then mark it `applied`.
  - `POST /supplier-bills/:id/discard`.
- **Matching:** exact SKU first, then `catalogMatch.rankProducts`; the top match is pre-selected only when unambiguous. **Products are never created.** Unmatched lines must be mapped or skipped before Apply is enabled.
- **Frontend:** an owner "Stock in from bill" page with photo upload and a review table: bill line, matched product, **packs to add** (editable), unit cost, skip. Bills say "50 kg sugar" while stock is counted in packs, so the screen converts using pack size and the owner confirms.
- **Edge cases:**
  - No bill number: dedupe falls back to the image hash, with an "Are you sure?" if the same supplier and date was applied before.
  - Totals that don't add up: shown as a warning, not blocking.
  - Selling price is **not** changed.

### 5. Ready-time estimate

- **Data needed:** line counts and the pick queue (orders with status approved/picking and their `approved_at`). This exists.
- **Schema change:** `orders.ready_estimate_minutes int null` and `orders.ready_estimate_at timestamptz null`.
- **Formula (no AI)** in `services/readyTime.js`, with settings in config:
  - `minutes = SETUP (3) + PER_LINE (1.0) × own unpicked lines + PER_LINE × unpicked lines of orders ahead + SETUP × orders ahead not yet picking`, divided by `PICKERS` (default 1).
  - Rounded up to 5 minutes, minimum 5. Above 120 it shows "more than 2 hours". An empty queue gives the setup time plus own lines only.
- **When computed:** at approve, recomputed at start picking (own remaining lines only), cleared at finish packing (shows "Ready now"). Also recomputed when an order ahead finishes or is cancelled; that's cheap, inside the same transaction.
- **Frontend:** "Ready in about N minutes (by 4:35 pm)" on the customer's order page; staff see it in the queue.
- **Conflicts:** none, because it's informational only. Old orders have null estimates and show nothing.

### 6. Ask your business (owner only)

- **Routes:** `POST /insights/ask` takes `{question}` or a multipart voice note. The owner-only page has a text box and a microphone.
- **Gemini's job:** only classify. Output `{intent, params, language, transcript}` is validated with Zod against a **fixed list**:

| Intent | Params | Query (pre-written, parameterised) |
|---|---|---|
| `sales_by_period` | period | invoice totals and count |
| `sales_by_product` | product (resolved by catalog match, never trusted raw), period | sum of quantity and value from `invoices.lines` |
| `top_products` | period, limit ≤ 10 | top products by value |
| `top_outstanding_customers` | limit ≤ 10 | customers with balance > 0, highest first, with last payment date |
| `customer_balance` | customer name (resolved by fuzzy match; ambiguous → list) | balance, last payment |
| `low_stock` | — | stock ≤ reorder level |
| `orders_by_status` | period (optional) | counts by status |

- **Periods:** an enum (today, yesterday, this_week, last_7_days, this_month, last_30_days, last_month), resolved server-side in `SHOP_TIMEZONE`.
- **Unknown or unsafe question:** "I can answer questions about: sales by period, sales of a product, top products, who owes the most, a customer's balance, low stock, orders by status."
- **Answer:** built from **templates in en/kn/hi**, filled with the query results, plus a small table of the exact numbers. The model never writes SQL and never writes the numbers.
- **Risk:** my Kannada and Hindi template wording should be checked by a native speaker.
- **Logging:** one `ai_events` row per question (kind `ask_business`), holding the intent and params; result rows aren't stored.

### 7. Proactive reorder nudges

- **Data:** orders with status collected or ready and their items, per customer and SKU. This exists. Seed history makes Ramesh's sugar, toor dal, oil and tea and Fatima's atta and moong due.
- **Schema changes:**
  - `reorder_nudge_dismissals (customer_id, product_id, dismissed_at)`, primary key (customer_id, product_id). A dismissal hides that product until the customer orders it again.
  - Widen the `orders.channel` check to add `'nudge'`: drop the constraint, then add it back with all old values plus `nudge`. Existing rows stay valid.
- **Rule (no AI)** in `services/reorder.js`:
  - Per SKU: at least 3 orders containing it → gaps between order dates → **median** gap.
  - Due when days since the last order ≥ 0.9 × median.
  - Suggested quantity = median quantity.
  - Skip if the product is inactive, if an open order (needs_clarification…picking) already contains it, or if it was dismissed since the last purchase.
  - Out-of-stock products are shown but flagged.
  - Fewer than 3 orders: no nudge, no guess.
- **Routes:**
  - Customer: `GET /reorder/suggestions` (button on home), `POST /reorder/draft` with chosen SKU/qty (creates a `draft` order, `channel = 'nudge'`, `origin = previous_order`, then the normal review), `POST /reorder/dismiss`.
  - Owner: `GET /reorder/due` lists due customers on the dashboard, read-only.
- **Idempotency:** the draft request takes an idempotency key, like orders.

### 8. Payment reminder drafts (owner)

- **Data:**
  - `customers.balance` > 0 and `payments.created_at` (last payment date) exist.
  - Language order: `customers.preferred_language`, else `orders.language` of the latest order **if** it's en/kn/hi (it can be `other`/null), else English.
  - Shop name comes from `shop_settings`.
- **Route:** `POST /reminders/draft {customer_id}`, owner only. It returns `{text, language, amount, last_payment_date, source: 'ai'|'template'}`. A "Draft reminder" button on the customer list and detail opens the text with **Copy**. Nothing is sent.
- **Gemini input is only:** shop name, amount, last payment date (or "none"), language. No customer name, phone or items.
- **Output guard:** Zod (≤ 400 chars). The text is then rejected if it contains any digit run, URL, email, @ or phone number other than the exact amount and dates passed in. A rejected or failed AI draft falls back to a fixed template in that language, so the owner always gets a safe draft.
- **Edge cases:**
  - Balance ≤ 0: 409 "Nothing outstanding".
  - Never paid: "no payment received yet" wording.
  - Credit balance: excluded.

---

## Cross-cutting risks

1. **Migration number.** It must be `003`, not `002`. `003` runs once via `npm run migrate`. It'll be tested on the local database, then applied to Mumbai, with row counts and checksums compared before and after.
2. **Substitution groups.** Without `substitute_group`, suggestions would be unsafe (salt for sugar). With it, products start with no group except those the seed sets, so other products get no suggestions until the owner sets one. That's safe, but it needs a little setup.
3. **Feature 3 touches the most sensitive flow (finish packing).** The guard is that stock and invoice code stays untouched: substitutes are ordinary items. The regression test for the core flow plus new tests run after each feature.
4. **Gemini output drift.** New fields (`source_text`, `from_previous`, intents) are parsed tolerantly; anything odd degrades to null or "unknown", never to a failed order or a wrong number.
5. **Languages.** Kannada/Hindi templates (features 6 and 8) and model-written reminders need a native-speaker check before real use.
6. **Prompt injection.** Order text, bills and questions are user content. The model can only return schema-shaped JSON; SKUs, products, customers and intents are all re-resolved server-side; it can't trigger writes or SQL.
7. **Latency.** Each AI feature inherits the 25 s / retry / fallback policy. Ask-your-business and reminders show the same loading pattern as orders.
8. **No real notifications.** Substitution offers are only seen if the customer opens the app. Staff can always decide at the counter, or proceed without.

## Build order and checks

The features are built in your order, 1 → 8. After each one:

- **Tests:** feature tests (mock Gemini plus a simulated-failure test).
- **Regression:** the core flow (text, photo and voice → clarification → submit → approve → pick → finish packing → invoice → collect), with stock and balance asserted to change exactly once.
- **Real check:** one manual run with the real Gemini on Mumbai.

## Decisions I need from you

1. Use `003_ai_features.sql` (since `002` is taken)?
2. Notifications in-app only for now?
3. For feature 3: add `products.substitute_group`, with no group meaning no suggestions?
4. For feature 1: should answering "what would you like?" on an empty order parse the answer into items?
5. For features 6 and 8: are fixed Kannada/Hindi templates (to be checked by a native speaker) acceptable, with the model never writing the numbers?

# OrderPilot

Order management for a small provision store. Customers order by **typing, photographing a list, or sending a voice note** (English, Kannada, Hindi). Gemini turns that into catalog items, the customer answers any questions and reviews, staff approve, pick and pack, and the shop gets an invoice, stock movements and customer balances that stay consistent.

## Stack

| Part | Tech | Where |
|---|---|---|
| Database | Postgres (Supabase hosted, or local embedded Postgres for dev) | `supabase/migrations/` |
| API | Node 22.9+ · Express 5 · Zod 4 · `pg` · JWT | `server/` |
| Web app | React 19 · React Router 7 · Vite | `client/` |
| AI | Gemini REST API (server-side only), mock mode without a key | `server/src/services/gemini.js` |
| Files | Supabase Storage private bucket `order-files` (local folder fallback) | `server/src/services/storage.js` |

## Quick start (local, no accounts needed)

```bash
npm install
cp .env.example .env              # then set JWT_SECRET (openssl rand -hex 32)
npm run db:local                  # terminal 1: local Postgres on :54329 (leave running)
npm run migrate                   # terminal 2
npm run seed
npm run dev                       # API :4000 + web :5173
```

Open http://localhost:5173. Demo logins (password is `SEED_PASSWORD` in `.env`):

| Role | Phone |
|---|---|
| Owner | 9000000001 |
| Staff | 9000000002 |
| Customer – Ramesh (Kannada, 6 past orders, owes ₹998) | 9000000101 |
| Customer – Fatima (Hindi, 3 past orders, settled) | 9000000102 |
| Customer – Anita (no language set, owes ₹1,142, one order ready) | 9000000103 |

Without `GEMINI_API_KEY` the app runs in **demo mode** (banner at the top): typed orders are parsed by a deterministic matcher; photos and voice notes are stored and the customer is asked to type the items.

Tests (API end to end): `npm test` — always runs against the local database (`npm run db:local` must be running), local file storage and mock Gemini, so it never touches Supabase or spends Gemini calls. Run `npm run seed` against the local DB first. Reset demo data: `npm run seed -- --reset` (refused when `NODE_ENV=production`).

## Using hosted Supabase

1. Create a project at supabase.com.
2. **Project Settings → Database → Connection string → Session pooler (URI)** → put it in `.env` as `DATABASE_URL`.
3. **Project Settings → API** → copy the Project URL to `SUPABASE_URL` and the `service_role` key to `SUPABASE_SERVICE_ROLE_KEY` (server only — never in the client).
4. `npm run migrate && npm run seed`, then `npm run dev`.

The migration enables RLS on every table with no policies, so Supabase's public REST API exposes nothing; only the server (table owner) reads and writes. The `order-files` bucket is created private.

## Order lifecycle (as implemented in `server/src/services/rules.js`)

```
needs_clarification ──answer all──▶ draft ──submit──▶ submitted ──approve──▶ approved ──start picking──▶ picking ──finish packing──▶ ready ──collect──▶ collected
        │                            │                    │  └─reject──▶ rejected        │                       │
        └──────────cancel────────────┴────────cancel──────┴──────────cancel (staff/owner)┴───────cancel (staff/owner)
```

| Transition | Who |
|---|---|
| answer questions, edit items (draft), submit, cancel before approval | customer (own orders), staff, owner |
| approve, reject, start picking, mark items, finish packing, collect, cancel approved/picking | staff, owner |

**Finish packing** is the only step that changes stock and balances. In one transaction it: deducts stock for the packed quantities (`stock_movements` type `sale`, unique per order item), creates the invoice from packed lines (unique per order), adds it to the customer's balance (`customer_ledger`, unique per invoice), and moves the order to `ready`. Calling it twice, or concurrently, returns the same invoice without changing anything. If stock is insufficient, nothing is written.

## Data model (`supabase/migrations/001_init.sql`)

`shop_settings` · `customers` (balance > 0 = owes) · `users` (role customer/staff/owner; customer users link to one customer) · `products` (price per pack, `stock_qty` ≥ 0) · `orders` · `order_items` (`confidence`, `pick_status`, `packed_qty`) · `order_clarifications` · `order_status_history` · `stock_movements` (only path that changes stock) · `invoices` (line snapshot) · `payments` · `customer_ledger` · `ai_events` (every model call). `schema_migrations` is created by the migration runner, which applies each file once and warns if an applied file was edited.

## API (all under `/api`, JWT `Authorization: Bearer` except login)

| Method & path | Role | Purpose |
|---|---|---|
| `POST /auth/login`, `GET /auth/me` | any | sign in |
| `POST /orders/parse` (multipart: `text`, `file`, `customer_id`, `idempotency_key`) | customer; staff/owner with `customer_id` (counter mode) | text/photo/voice order |
| `POST /orders` | staff, owner | counter order from SKUs (no AI) |
| `GET /orders`, `GET /orders/:id`, `GET /orders/:id/file` | customer (own), staff, owner | list/detail/attachment |
| `PUT /orders/:id/items` | own customer, staff, owner | review edits (draft only) |
| `POST /orders/:id/clarifications/:clarId/answer` | own customer, staff, owner | answer `{sku}`, `{quantity}`, `{text}` or `{skip:true}` |
| `POST /orders/:id/{submit,cancel}` | own customer, staff, owner | |
| `POST /orders/:id/{approve,reject,start-picking,finish-packing,collect}`, `PATCH /orders/:id/items/:itemId/pick`, `GET /orders/pick-queue` | staff, owner | fulfilment |
| `GET/POST /payments` | customer sees own; staff/owner record | |
| `GET /customers`, `GET /customers/:id` | staff, owner (customer: own via `/customers/me`) | |
| `POST/PATCH /customers` | owner | create (optionally with app login) / edit |
| `GET /products` | any (customers see only active + in-stock flag) | |
| `POST/PATCH /products`, `GET/POST /stock/movements` | owner | catalog and stock in/adjust |
| `GET /dashboard`, `GET /ai-events`, `PATCH /settings/shop` | owner | |

All inputs are validated with strict Zod schemas (unknown fields → 400). Customers asking for another customer's order/invoice get 404.

## Gemini

- Model `GEMINI_MODEL` (default `gemini-3.5-flash`; check which models your key can use if Google retires it), REST `generateContent` with `responseMimeType: application/json` and a response schema.
- Photos (JPG/PNG/WEBP/HEIC, magic bytes checked) and voice notes (webm/ogg/mp4/mp3/wav/aac) are sent inline as base64; max upload 10 MB.
- Output validated with Zod; SKUs not in the catalog are never trusted — the customer is asked to choose.
- **When Google is busy** (`server/src/services/gemini.js`), each order tries, in order:
  1. the main model (`GEMINI_MODEL`), 25 s limit (`GEMINI_TIMEOUT_MS`);
  2. on HTTP 503/429/5xx, a timeout or a network error: wait ~1.5 s (`GEMINI_BACKOFF_MS`) and retry the main model once;
  3. if the main model still failed, for any reason including an invalid answer: one try on the lighter `GEMINI_FALLBACK_MODEL` (default `gemini-3.1-flash-lite`; empty disables it);
  4. otherwise HTTP 503 `{ "code": "ai_busy", "error": "AI is busy, please try again." }`.

  Worst case is about 80 s. Nothing is saved (order, items or file) unless an attempt succeeds, so retrying is safe: the form keeps the customer's text, photo or voice note and shows **Try again**. While waiting, the form shows a spinner and a message that changes with time (reading → matching → slower than usual → trying a faster backup).
- Every attempt is logged to `ai_events` with the model used; a success after a retry or on the fallback is noted there. Owners see recent activity on the dashboard.
- Demo tip: to see the fallback live, set `GEMINI_MODEL` to a name that does not exist and restart; every order is then read by the fallback model.

## Security notes

- Secrets live only in `.env` on the server. The client bundle contains no keys (checked with a grep of `client/dist`).
- Passwords hashed with bcrypt; JWT HS256, 12 h expiry, user re-checked as active on every request.
- Uploaded files are stored privately and only served after an access check (signed 5-minute URL on Supabase).

## AI feature: "Same as last time" orders

A customer (or staff at the counter) can say **"usual order"**, **"same as last week"** or **"last order plus 2 sugar"**, in English, Kannada or Hindi.

- The customer's most recent **collected or ready** order is sent to Gemini as context, and only when one exists.
- Lines copied from it are tagged **"from last order #N"** on the review, order and pick screens, and the order links back to that earlier order. The server only accepts the tag if the item really was in that order. "plus 2 sugar" gives one sugar line with the combined quantity, and "without milk" removes a line.
- With **no previous order** the app asks "We don't have an earlier order for you yet. What would you like to order?". The typed answer is then read as items.
- A product from the last order that is no longer sold becomes a question instead of being copied silently.
- Schema: `orders.based_on_order_id` and `order_items.origin`, both nullable, in `supabase/migrations/003_ai_features.sql`.

Demo: sign in as Ramesh (9000000101) and type `same as last time plus 2 sugar`. For the no-history case, sign in as staff, open **Counter**, pick *Walk-in Customer* and type `usual order`.

## Not built yet (paused)

Features 2–8 are planned in [docs/ai-features-plan.md](docs/ai-features-plan.md) and paused. Migration 003 already holds their schema, so they need no further migration.

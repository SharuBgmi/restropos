# RestroPOS

A full-stack restaurant billing POS modeled on Petpooja's core workflow: menu →
table/order → KOT to kitchen → GST bill → inventory deduction → sales reports.

## Stack
- **Backend**: Node.js + Express + SQLite (via `better-sqlite3`, zero external DB server to manage)
- **Frontend**: Vanilla HTML/CSS/JS single-page dashboard (no build step)
- **Auth**: Staff PIN login, roles `owner` / `staff`

## Setup

```bash
npm install
npm start
```

Open `http://localhost:4000`. Default owner PIN is **1234** — change it by editing
the `users` table (or add a settings screen later).

The database file lives at `db/restropos.db` (SQLite) and is created automatically
on first run, along with 4 starter tables (T1–T4).

## What's implemented (matches your Petpooja feature list)

| Module | What it does |
|---|---|
| **Billing** | Tap items into a cart, live GST + discount calc, generates a bill |
| **Tables** | Visual table grid, free/occupied status, tap a table to open its order |
| **Menu** | Add/edit/delete items, categories, GST rate per item, kitchen/bar/dessert station |
| **Inventory** | Optional stock tracking per item, auto-deducts on KOT, low-stock banner |
| **KOT** | Splits pending order items by station (kitchen/bar/dessert) into separate tickets |
| **Reports** | Daily sales by payment mode, item-wise sales, date range filter |

## Where things live

- `server.js` — all REST API routes + SQLite schema (auto-migrates on boot)
- `public/index.html` — app shell, all views
- `public/app.js` — all frontend logic (login, cart, tables, menu, inventory, reports)
- `public/styles.css` — design system (ink-navy + saffron, receipt-style bill card)

## New: WhatsApp auto-send + OTP-protected bill deletion

- **Every bill auto-sends to the owner** — no tap needed. The moment "Generate Bill"
  succeeds, the server posts a formatted text message (items, GST breakdown, total)
  straight to `OWNER_WHATSAPP_NUMBER` via the WhatsApp Cloud API. This runs
  fire-and-forget: if WhatsApp isn't configured yet, billing still works and the
  server just logs a warning instead of sending.
- **Deleting a bill requires OTP**: on the new **Bills** tab (owner login only), tap
  Delete → a 6-digit OTP is generated server-side and sent to the owner's WhatsApp →
  entering the correct code within 5 minutes deletes the bill and reopens its order
  for re-billing. Wrong or expired codes are rejected.

Set this up by copying `.env.example` to `.env` and filling in:
```
WHATSAPP_TOKEN=...
PHONE_NUMBER_ID=...
OWNER_WHATSAPP_NUMBER=919999999999
```
See the earlier `whatsapp-bill-sender` project's README for how to get these from
Meta's developer console. Same 24-hour session-window rule applies: for delivery to
never depend on the owner texting first, set up an approved WhatsApp template later —
until then, plain text messages work as long as the owner has messaged the business
number at least once in the last 24h.

## New: Persistent data (Turso) + phone/OTP login

**Why bills were resetting**: Render's free tier disk is wiped on every redeploy
and can be wiped on restarts too — that's not a bug in the app, it's how their free
tier works. The fix is to store data in a small free cloud database instead of a
local file.

### Set up Turso (~5 minutes, free)
1. Go to **turso.tech** → sign up with GitHub
2. Install their CLI, or just use the web dashboard → **Create Database**
3. From the database page, copy the **Database URL** (starts with `libsql://`)
4. Generate a **Auth Token** from the same page
5. Add both to Render's Environment Variables:
   ```
   TURSO_DATABASE_URL=libsql://your-db-name.turso.io
   TURSO_AUTH_TOKEN=your_token_here
   ```
6. Redeploy — from now on, bills, menu, tables, everything survives redeploys and restarts.

Without these two variables set, the app still runs (using a local file) but data
will reset on Render's free tier — fine only for local testing on your own machine.

### Login is now phone number + WhatsApp OTP, not PIN
- Enter your WhatsApp number on the login screen → get a 6-digit code on WhatsApp → enter it
- The number set as `OWNER_WHATSAPP_NUMBER` automatically becomes the **owner** account
  the first time it logs in; any other number that logs in becomes **staff**
- Sessions are stored in the database (not memory), so once a device logs in it
  **stays logged in** — no reset on server restart, redeploy, or reopening the site.
  Logging in with the same number on a second device logs that device in too,
  independently, without affecting the first device's session.
- Tap **Log out** to end a session on that specific device only.

### Login and delete-bill OTP now use SMS (Fast2SMS), not WhatsApp
Since registering a number on WhatsApp Business API requires it to not already be
on regular WhatsApp, OTPs now go out as plain SMS instead — same provider you used
for your hotel billing app before.

1. Sign up at **fast2sms.com** → get your API key from the dashboard
2. Add to Render's Environment Variables:
   ```
   FAST2SMS_API_KEY=your_key_here
   ```
3. Done — no DLT template registration needed, Fast2SMS's OTP route handles that.

Bills still auto-send to the owner on **WhatsApp** (separate from login) — set that
up later with a spare number when you're ready; login and bill-deletion don't depend on it.

## Extending it

- **WhatsApp bill send**: I built `whatsapp-bill-sender` earlier — call it from
  `showReceipt()` in `app.js` by POSTing the rendered bill as an image, same as the
  React Native snippet.
- **Multi-branch**: add a `branch_id` column across `tables`, `orders`, `bills` and
  filter by it; the schema is small enough this is a clean add.
- Ready for whatever extra feature you want to bolt on next — just say the word.

## Known simplifications (fine for MVP, flag if you want these hardened)
- Sessions are in-memory (`Map`) — restarting the server logs everyone out. Swap for
  a `sessions` table or JWT if you deploy long-running.
- No HTTPS/production hardening — put it behind a reverse proxy (Caddy/nginx) or
  Render/Railway's built-in TLS when you deploy.
- Single restaurant only (no multi-tenant separation yet).

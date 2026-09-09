# FinBud · Dry-cleaning workspace

An initial full-stack application for Nigerian dry cleaners, owned by **FinBud Technologies Limited**. The frontend uses the requested **rgb(64, 0, 57)** and **rgb(255, 255, 255)** theme.

## Deployment

Deploy **Express separately on Render** and **Next.js separately on Vercel**. They share a repository for convenience and do not require a shared server. See [DEPLOYMENT.md](DEPLOYMENT.md) for the exact commands, environment variables, and how the API proxy preserves cookie-based authentication. A backend-only Render Blueprint is included in [render.yaml](render.yaml).

## Try the disposable demo

Requires Node.js **22.10+** and npm. On Windows PowerShell, use `npm.cmd` if script execution policy blocks `npm`.

```powershell
npm.cmd install
npm.cmd run demo
```

Open **http://localhost:3000/login**:

- Email: `demo@finbud.example`
- Password: `FreshStart2026!`

The demo starts a private, temporary MongoDB replica set and seeds a fictional business, customers, orders, and financial records. **All demo data disappears when it stops.** It does not load `.env`, disables payment credentials, and must not be exposed publicly. The first run may download MongoDB. Ports 3000 and 4000 must be available.

## Use a persistent database

```powershell
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env.local
```

Set `MONGODB_URI` in `backend/.env` to your MongoDB connection string, then:

```powershell
npm.cmd run dev
```

Use a **MongoDB replica set or Atlas** for atomic payment settlement and grouped pricing edits/imports. Never use the temporary demo database for real business data.

The Next.js server proxies `/api/*` to Express. Browser requests use the same origin, and sessions use HTTP-only cookies. `APP_URL` must exactly match the frontend URL, including the port in development. In production, use HTTPS and set `NODE_ENV=production` on the backend. Keep the API behind the frontend/reverse proxy; configure trusted proxy IP handling deliberately if changing this topology.

## Included

- Public landing page, searchable Nigerian business directory, metadata, robots rules, and sitemap.
- Listed businesses have a shareable `/businesses/:businessId` page showing their introduction, notices, location, contact details, and active service prices. Unlisted and archived businesses return 404; owner, bank, customer, and transaction details are excluded.
- Registration, login, logout, profile name updates, password changes, Mailjet password-reset integration, and account deletion.
- Owner accounts with multiple isolated businesses and a combined overview. Customers belong to individual businesses; matching phone numbers across businesses do not silently merge records.
- Business details, public-listing opt-in, customer notices, and bank details on private tracking pages.
- Returning-customer records with normalised Nigerian mobile numbers and duplicate detection within each business.
- Editable garment/service prices stored in integer kobo. Orders snapshot their prices and are calculated on the server.
- One pricing card per clothing type, with independently editable washing, ironing, and wash-and-iron amounts. Blank means not offered; at least one price is required. Group changes are atomic and preserve existing order snapshots.
- Drop-off records with quantities, service, pickup date, condition notes, customer-review acknowledgement, and up to five private photographs per line item.
- Image decoding/re-encoding, metadata removal, size limits, and authenticated image access. Photos are stored separately in MongoDB for this initial implementation.
- Service-aware order progression and append-only status histories. Mixed-service orders progress at the order level.
- High-entropy private tracking links showing limited order information, collection instructions, and payment status.
- Full-payment recording for cash and bank transfers, clearly labelled as manual. Expense recording and CSV export.
- Cash income, recorded expenses, and cash surplus/deficit. These are not accrual accounting profit/loss statements.
- Paystack subscription checkout, server verification, signed webhooks, amount/currency checks, and idempotent settlement.
- Draft terms, privacy, refund, and account-deletion pages with explicit development limitations.

## Initial product decisions

### Business QR posters

Open **Business settings → Business QR code** for a publicly listed business. The preview includes the business name, scanning instructions, and a QR code. Download a high-resolution PNG, download an SVG for scalable printing, copy the link, or print only the poster on white paper. Generation happens locally in the browser; no QR service or database write is involved.

QR codes always encode `https://drycleaning.finbudtechnologies.com/{business-id}`, including during local development. The root `/{business-id}` route serves the profile, and existing `/businesses/{business-id}` links remain valid with the permanent URL as their canonical address. Directory and workspace links use the new short path. Existing policy routes still work.

Deployment is not needed to generate the files. The final domain must serve this frontend (with its configured backend) before customers can open the scanned link. Keep the business publicly listed, preserve the white margin, and test a printed sample before displaying it. Price and notice updates do not require a new QR code; changing the URL would.

Browser tests independently decode the PNG and SVG to verify the destination, check escaping of business names, exercise the print layout, and confirm both profile URL formats.

- **Owner role only.** Staff permissions, branches, and customer account logins are not yet implemented.
- **14-day trial per business**, then **₦1,000 for 30 days**, manually renewed. Expired subscriptions block new customer, photo, price, order, and expense records; existing records remain accessible and orders can still be completed.
- **No wallet and no supplier transfer execution.** An expense records an external payment already made.
- **Full order payments only.** Deposits, partial collections, partial refunds, cancellations, and payment corrections need additional workflows.
- **Business deletion is archival.** Orders must be collected first. Archiving removes workspace access and public discovery while retaining historical records. Account deletion removes the login record and sessions, not all historical business data.
- Condition acknowledgement is an owner-recorded checkbox, not a customer digital signature. Photographs provide supporting evidence and are not a guarantee that every defect was captured.
- Directory discovery uses city/state/address search, not GPS distance ranking or verified reviews.
- FinBud is a working platform name; it can be changed once the final product branding is chosen.

## Payment configuration

Start with a Paystack **test key** in `PAYSTACK_SECRET_KEY`. Live keys are rejected unless `ALLOW_LIVE_PAYMENTS=true`.

Register the webhook URL with Paystack:

```text
https://your-api-host/api/payments/webhook
```

The webhook verifies the raw-body HMAC signature and independently verifies the transaction with Paystack. Subscription settlement and the 30-day access extension run in one MongoDB transaction. Repeated webhook events do not extend access again.

Customer online collections remain off by default. **Confirm the merchant onboarding/settlement arrangement with Paystack before enabling them.** Configure `ORDER_PAYMENTS_ENABLED=true` and a server-managed mapping:

```dotenv
PAYSTACK_SUBACCOUNTS={"BUSINESS_MONGODB_ID":"ACCT_APPROVED_SUBACCOUNT"}
```

Order checkout uses the approved business subaccount with zero platform transaction charge and fees assigned to the subaccount. Do not interpret this technical configuration as regulatory approval. FinBud's own subscription revenue uses its platform Paystack account.

An order has one payment reference. Manual records and provider checkouts cannot both create independent payment records for the same order. A pending checkout blocks manual recording and another checkout. Failed/interrupted pending checkouts currently require operator reconciliation through Paystack and the database; a retry/reconciliation UI is still needed before live collections. Refund execution is not implemented; approved refunds must be handled by an authorised operator through Paystack, with a future in-app reconciliation workflow.

The app never credits payment from a browser-supplied amount or callback status. Provider calls use timeouts, and missing integration credentials produce visible errors.

References used for the integration: [Paystack verification](https://paystack.com/docs/payments/verify-payments/), [webhooks](https://paystack.com/docs/payments/webhooks/), [split payments](https://paystack.com/docs/payments/split-payments/), [merchant terms](https://paystack.com/terms).

## Email configuration

Set `MAILJET_API_KEY`, `MAILJET_SECRET_KEY`, and a verified `MAIL_FROM` sender. Password reset tokens are random, stored as hashes, expire after 30 minutes, and are consumed once. Password changes and resets revoke existing sessions. No password-reset links are printed to logs.

Order confirmation/status emails and email-address verification are not yet included. Tracking links can be copied from order details and shared by staff outside the application.

## Tests and build

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run build:e2e
npm.cmd run test:e2e
```

Integration tests start an isolated MongoDB replica set and cover tenant boundaries, private photographs, server-calculated prices, customer deduplication, order transitions, duplicate payments, subscription expiry, webhook verification/idempotency, and session revocation.

Browser tests start their own demo backend and production frontend on ports 4100/3100, exercise photographed drop-offs, public tracking, business profiles, and grouped pricing, and capture desktop/mobile screenshots in `.cache/screenshots/`. On Windows they use installed Microsoft Edge; elsewhere install Playwright Chromium with `npx playwright install chromium`. Run `npm run build:e2e` first: it uses `.next-e2e` and overrides the API URL so browser tests do not touch the database or build output used by your local development app.

## Import the requested business prices

`backend/scripts/import-service-prices.js` imports the supplied 23 clothing types/variants for one explicitly identified business. It defaults to a dry run, checks the exact business name, backs up current pricing to `.cache/pricing-backups/` before applying, and applies all changes in one transaction. It preserves unrelated categories and order history, handles the existing singular `Shirt` as `SHIRTS`, and can be rerun without adding duplicate types.

From `backend`, preview with:

```powershell
node --env-file=.env scripts/import-service-prices.js --business=BUSINESS_ID '--expected-name=EXACT BUSINESS NAME' --combined=sum
```

Add `--apply` to save. `--combined=sum` uses washing plus ironing as the initial combined price; `--combined=unset` leaves combined service unavailable. Footwear and bag variants are imported as wash-only. These defaults do not constrain later manual edits.

For a persistent production setup:

```powershell
npm.cmd run build
npm.cmd run start -w backend
# In a second terminal:
npm.cmd run start -w frontend
```

## Layout

```text
backend/
  src/app.js          Express routes, validation, authorisation, payment settlement
  src/models.js       Tenant-scoped MongoDB/Mongoose schemas
  src/domain.js       Pricing, status progression, tokens, webhook signatures
  src/services.js     Paystack and Mailjet adapters
  src/server.js       Persistent application startup
  scripts/demo.js     Disposable, fictional local preview
  test/               Integration and domain tests
frontend/
  app/                Next.js routes, metadata, and responsive styling
  components/         Workspace, forms, public tracking, directory, and shared UI
e2e/                  Browser workflow checks
```

## Before public launch

This is a working initial implementation, **not a claim of production or regulatory readiness**. Resolve the payment arrangement, final policies and support contacts, customer data-request handling, retention schedules and deletion jobs, backup/restore, monitoring, and operational access controls. Add email verification and stronger login protections for real customer records. Review data-processing roles, processors, international transfers, and any applicable Nigerian registration/filing obligations with qualified advisers.

List routes are intended for the initial dataset: orders have a 500-record cap, customers a 1,000-record cap, and public listings a 200-record cap. The owner overview currently loads all owned records. Server-side pagination, search, aggregates, and date-range reporting are needed for larger businesses. Uploaded but unused photographs currently remain stored; orphan cleanup and durable object storage should accompany the retention work. Financial-entry corrections and refunds also require an auditable workflow before relying on this as the sole financial record.

Google Fonts is used for typography and disclosed in the draft privacy policy; self-host those fonts before launch if avoiding third-party font requests. The public demo must never contain real customer information.

© FinBud Technologies Limited. All rights reserved.

# QR-SASMS — Next.js + Prisma + PostgreSQL backend

Real, database-backed backend for the PUP San Pedro SSO document/service
portal. The original frontend's visual design and markup are untouched
(`src/content/body.html` is a byte-for-byte copy of the original `<body>`,
`src/app/globals.css` is a byte-for-byte copy of the original `<style>`
block) — only the JavaScript behind it was rewired from
localStorage-mocked data to real API calls (`public/app.js`).

 

- **PostgreSQL via Prisma** — every entity (users, document requests,
  appointments/queue, referrals, ID applications, bulletins, help desk
  tickets, FAQs, event requests, complaints, downloadable forms, email
  blasts, audit log, email outbox, in-app notifications, SSO masterlist)
  is a real table. See `prisma/schema.prisma`.
- **Real authentication** — bcrypt-hashed passwords, httpOnly signed JWT
  session cookie (`src/lib/auth.ts`). Sessions now survive a page refresh,
  which the original prototype never did.
- **Real email** — `src/lib/mailer.ts` sends via SMTP (Nodemailer) when
  configured; otherwise it runs in a clearly-labeled SIMULATED mode and
  still logs every attempt to the Email Outbox, exactly like the original.
- **Real file uploads** — ID application receipts, event request
  attachments, complaint attachments, and downloadable forms are written
  to `public/uploads/` and served from a real URL (`src/lib/upload.ts`),
  replacing the original's base64-in-localStorage approach.
- **Server-side authorization** — every mutating action is re-validated
  server-side by role (student/admin/scanner), and confidential data
  (complaints, referrals, tickets, ID applications, event requests) is
  scoped to the owning student or admin at the database query level, not
  just hidden in the UI.

## Prerequisites

- Node.js 18.18+ and npm
- Docker (for the bundled Postgres), or your own PostgreSQL instance

This project was authored in a sandboxed environment with no package
registry or Docker access, so it has **not** been `npm install`'d or
run/built here — follow the steps below on your own machine.

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Start Postgres** (skip if you already have one — just point
   `DATABASE_URL` at it in step 3)

   ```bash
   docker compose up -d
   ```

3. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Edit `.env`:
   - `AUTH_SECRET` — set to any long random string (`openssl rand -base64 48`).
   - `DATABASE_URL` — already points at the docker-compose Postgres by default.
   - `SMTP_*` — optional. Leave blank to run in SIMULATED email mode (safe
     default, no external setup needed). Fill in real SMTP credentials
     (Gmail app password, SendGrid, etc.) to send real email.

4. **Create the database schema and seed demo data**

   ```bash
   npx prisma migrate dev --name init
   npx prisma db seed
   ```

5. **Run it**

   ```bash
   npm run dev
   ```

   Open http://localhost:3000.

## Deploy to Render

This repository includes `render.yaml`. In Render, choose **New** → **Blueprint**
and select this GitHub repository. Render will create both the web service and a
PostgreSQL database automatically.

Before the first deploy, set these service environment variables in Render:

- `NEXT_PUBLIC_APP_URL` — the final Render URL, for example
  `https://qr-sasms.onrender.com`. This is required for password-reset links.
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` — only if real email
  delivery is needed. Leave them blank to use the built-in simulated email mode.

The Render build command syncs the current Prisma schema and runs the idempotent
demo seed once safely. The default first-login accounts are listed below; change
their passwords immediately after deployment.

> Render's free disk is ephemeral. Files uploaded to the application can be lost
> after a redeploy or restart. Use an external object-storage service before using
> the system in production for real student files.

## Demo logins (created by the seed script)

| Role    | Username                  | Password      |
|---------|---------------------------|---------------|
| Student | `2024-00123-SP-0` (or `student@pup.edu.ph`) | `student123` |
| Admin   | `admin@pup.edu.ph`        | `Admin@2026!` |
| Scanner | `scanner@pup.edu.ph`      | `scan2026`    |

The seed also imports a small masterlist (including one **unregistered**
student, `2024-00200-SP-0` / Carla Dizon) so you can test the full
"Create Account" → "Awaiting admin approval" → admin approves →
sign in" flow end to end.

## Project layout

```
prisma/schema.prisma      All database models
prisma/seed.ts            Demo data (users, requests, queue, FAQs, masterlist)
src/lib/                  auth, prisma client, mailer, notifications, uploads, formatting
src/app/api/**            Every REST endpoint the frontend calls
src/app/layout.tsx         Original <head> (fonts, CDN scripts, stylesheet)
src/app/globals.css        Original <style> block, copied verbatim
src/content/body.html      Original <body> markup, copied verbatim
src/app/page.tsx           Renders body.html + loads public/app.js
public/app.js              Rewired client logic (real fetch calls, same UI)
public/uploads/            Uploaded files land here at runtime
```

## Notes / deliberate deviations from the prototype

- **DOC_LABELS bug fix**: the original client mapping was missing an
  `ev` → "Enrollment Verification" entry, so submitting that document type
  would have displayed the raw key `ev` as the document name. Fixed on
  both the server (`src/lib/requests.ts`) and client (`public/app.js`).
- **Session persistence**: the original never restored a session on
  reload. This build restores it from the signed cookie via `/api/auth/me`.
- **QR Scanner page**: the "Simulate valid/invalid scan" buttons are a
  cosmetic demo affordance in the original (no camera-decoding library was
  ever wired in) and are left as-is. The real, backend-verified flow is
  "Verify by Reference" on the same page, which now does a genuine
  database lookup.
- **Removed** the unused EmailJS CDN `<script>` tag reference from the
  `<head>` — email is sent from the server now, so the client-side EmailJS
  SDK is no longer loaded. This is the only non-visual line removed from
  the original file.

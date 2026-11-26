<div align="center">

<img src="./public/pup-seal-icon.png" alt="PUP San Pedro Campus Seal" width="110" />

# STARS — Student Transaction & Appointment Request System

**Student Services Office (SSO) portal for the Polytechnic University of the Philippines — San Pedro Campus**

[![Next.js](https://img.shields.io/badge/Next.js-14-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16_%2B_pgvector-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Prisma](https://img.shields.io/badge/Prisma-5.20-2D3748?style=for-the-badge&logo=prisma&logoColor=white)](https://www.prisma.io/)

*Scheduled visits · Request tracking with pickup status · Signed offline QR passes · Bilingual AI Support Assistant · 4-role access control*

</div>

---

## Contents

[Features](#features) · [Roles](#roles-and-access) · [Navigation](#navigation-and-naming) · [Tech stack](#tech-stack) · [Quick start](#quick-start) · [Demo data](#demo-data) · [Configuration](#configuration) · [Registration and verification](#registration-and-verification) · [Archiving and backups](#archiving-and-backups) · [AI assistant](#ai-assistant) · [Production](#running-in-production) · [Deploying](#deploying-to-render) · [Scripts](#scripts) · [Project structure](#project-structure)

---

## Features

### For students
| Area | What it does |
|---|---|
| **Schedule a Visit** | Book a date and time for a *General Visit*, *Event Request* or *Psychological Intervention*. Slot capacity is set per service, weekends and holidays are blocked, bookings can be rescheduled or cancelled up to 24 hours ahead (max. 2 reschedules), and slots are protected against double booking with Postgres advisory locks. |
| **New Request** | File *Authentication*, *Excuse Slip* and *ID Application* requests without picking a time. SSO staff schedule the pickup, and the student is notified. Number of copies accepts whole numbers 1–10 only (checked in the browser and on the server). |
| **My Requests / My Appointments** | Matching list pages with the same tabs (*View all*, *Upcoming*, *Pending*, *Completed*, *Cancelled / No Show*, *Archived*), search and detail dialogs. Every request shows a progress tracker, including pickup status. |
| **Dashboard** | Upcoming visits, items ready for action, active requests, support tickets, a **personal calendar** (appointments, pickups, events) and the latest **Student Bulletin** posts. |
| **Offline QR pass** | Every confirmed appointment and pickup has a tamper-evident QR pass (`STARS1\|code\|sn\|dateISO\|hmac8`, HMAC-SHA256). Download it as a PNG, print it, or add the visit to a calendar as `.ics`. |
| **Support** | Help Desk tickets, Complaints (with confidentiality levels), an AI assistant, FAQs and Forms. |

### For staff
| Area | What it does |
|---|---|
| **Operations dashboard** | Today's appointments, processing queue, visit breakdown, staff activity and Client Satisfaction (CSAT) ratings. |
| **All Requests / All Appointments** | Review, approve, schedule pickups, advance statuses and notify students. Modals have one primary action and a *More* menu, and destructive actions ask for confirmation inline. |
| **Service Desk scanner** | Live camera QR scanner plus manual code lookup, walk-in queue tickets, and Check-in / Serve / No-show. Confidential `PSYCH` details are masked. |
| **Complaints** | Filter by category and confidentiality; super admins manage complaint categories. |
| **Content** | Student Bulletin posts (featured, scheduled, draft), FAQ manager with an AI training playground, and a single flat list of downloadable Forms. |
| **Analytics** | Tabs for overview, students, satisfaction, assistant and exports, with date ranges and CSV export. |
| **Audit Logs** | A separate page with filters, a live view and export. |
| **System Settings** | Left-hand section menu: Schedule, Services, Assistant, Registration, Login splash, and **Backups & Archives**. |

### Platform
- **Real-time updates** over Server-Sent Events (`/api/events`), all times in `Asia/Manila`.
- **Bidirectional sync:** when staff schedule a pickup, a linked `APT-###` appointment is created, and serving it completes both records.
- **Automatic archiving:** finished records older than 30 days (configurable) move to an *Archived* view.
- **Full database backup and restore** from System Settings.
- **Email is optional.** Without SMTP, messages are recorded as in-app notifications and in the email log instead of being sent.

---

## Roles and access

| Role | Access |
|---|---|
| **Student** | Own dashboard and calendar, visits, requests, QR pass, complaints, tickets, bulletin, FAQs, forms, AI assistant and profile. Booking and requests require a **verified** account (see below). |
| **Scanner** | QR scanner, manual lookup, daily manifest and the Check-in / Serve / No-show actions. |
| **Admin** | Everything operational: requests, appointments, referrals, complaints, help desk, bulletin, FAQs, forms. |
| **Super Admin** | Everything an admin can do, plus Analytics, Audit Logs, Accounts (approvals, verification, staff, organizations), Masterlist, Email Blast and System Settings (including backups and archive rules). |

Super Admin routes are hidden in the UI and also return `403` from the server. Confidential records are filtered by owner or authorized staff in the database query itself.

---

## Navigation and naming

Pages use the same name in the sidebar, the breadcrumb and the page heading, in every role.

- Student-owned lists start with **My** (*My Requests*, *My Appointments*). Staff-wide lists start with **All** (*All Requests*, *All Appointments*).
- Forms to create something start with **New** (*New Request*, *New Ticket*, *New Complaint*). Booking is **Schedule a Visit**.
- Shared pages keep one name for every role: *Student Bulletin*, *FAQs*, *Forms*, *Help Desk*, *Complaints*, *Referrals*.

| Sidebar group | Student | Admin / Super Admin |
|---|---|---|
| **Requests** | New Request, My Requests | All Requests, Referrals |
| **Appointments** | Schedule a Visit, My Appointments | All Appointments |
| **Support** | Help Desk, Complaints | Help Desk, Complaints |
| **Resources** | Student Bulletin, FAQs, Forms | Student Bulletin, FAQs, Forms |
| **Insights** | | Analytics, Audit Logs *(super admin)* |
| **Administration** | | Accounts, Masterlist, Email Blast, System Settings *(super admin)* |

The profile page is **My Profile** (profile menu, top right).

---

## Tech stack

- **Framework:** Next.js 14 (App Router), React 18, TypeScript 5.6. The portal itself is a single-page app driven by `public/app.js` and the page templates in `src/content/body.html`.
- **Database:** PostgreSQL 16 (`pgvector/pgvector:pg16`) with Prisma 5.20
- **Auth:** `jose` (HS256 JWT in `httpOnly` cookies), `bcryptjs`, Node `crypto` for QR signatures
- **QR:** `qrcode` (PNG/data URLs and email attachments); camera scanning in the browser
- **Email:** Nodemailer over SMTP (optional)
- **AI search (optional):** Ollama embeddings plus `pgvector` cosine search, with automatic rule and keyword fallback

---

## Quick start

**Requirements:** Node.js 18.18+ (20.x recommended), npm, and Docker (or an existing PostgreSQL instance).

```bash
npm install
docker compose up -d db          # PostgreSQL 16 + pgvector
cp .env.example .env             # then set AUTH_SECRET and DATABASE_URL
openssl rand -base64 48          # use the output as AUTH_SECRET
npx prisma migrate deploy
npm run prisma:seed              # demo data (see below)
npm run dev                      # http://localhost:3000
```

---

## Demo data

`npm run prisma:seed` creates a believable, ready-to-use environment. All dates are relative to the day you run it, so the dashboard always looks current.

- **People:** 30 students on the masterlist (24 with accounts), two newly signed-up students waiting for verification, and staff accounts.
- **Activity:** about a month of appointment history, today's schedule and the coming week. Linked requests, referrals, event requests, satisfaction ratings, ID applications, complaints, help-desk tickets and chatbot conversations are all generated to match.
- **Content:** bulletin posts, downloadable forms with real PDFs, memos, notifications, email and audit logs, closed days and holiday blocks in the calendar, and 24 FAQs.

| Role | Sign in with | Password |
|---|---|---|
| Student | `student@pup.edu.ph` or `2024-00123-SP-0` | `student123` |
| Student (org rep) | `2024-00102-SP-0` | `student123` |
| Student (unverified) | `2026-00188-SP-0` or `2025-00421-SP-0` | `student123` |
| Admin | `admin@pup.edu.ph` | `Admin@2026!` |
| Super Admin | `superadmin@pup.edu.ph` | `SuperAdmin@2026!` |
| Scanner | `scanner@pup.edu.ph` | `scan2026` |

```bash
npm run prisma:seed              # safe to repeat; refreshes demo records and logs
npm run prisma:seed -- --reset   # clear operational data first, then rebuild
```

`--reset` deletes appointments, requests, tickets, complaints, logs, notifications and student accounts. Staff accounts, FAQs and settings are kept. Use it only on a development database.

> **Production:** do not run the demo seed. Create the first Super Admin with `npm run bootstrap:admin` and remove any demo accounts.

---

## Configuration

Copy `.env.example` to `.env`.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string. |
| `AUTH_SECRET` | Yes | Signs session cookies and QR passes. Use a long random value. |
| `NEXT_PUBLIC_APP_URL` | Production | Public base URL, used in password-reset links. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Optional | Real email delivery. Leave unset to run without sending email. |
| `OLLAMA_BASE_URL`, `ASSISTANT_EMBED_MODEL` | Optional | Semantic FAQ search. Without them the assistant uses rules and keywords. |
| `CRON_SECRET` | Optional | Protects `POST /api/cron/reminders` and `POST /api/cron/archive`. |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL`, `_PASSWORD`, `_NAME` | Production | Used once by `npm run bootstrap:admin`. |

### Running without SMTP (testing)

With no SMTP settings, no email leaves the server. For registration this means the 6-digit code cannot be received, so the app accepts a fixed test code, **`842706`**, instead. The code is never shown on screen, and it stops working as soon as SMTP is configured, after which only emailed codes are valid. Do not rely on it outside testing.

---

## Registration and verification

Registration is open to any student, whether or not they are on the masterlist yet.

1. The student enters their details, a valid student number (`YYYY-NNNNN-SP-N`) and an email, then confirms the email with a 6-digit code.
2. **Student number is on the masterlist:** the account is *verified* straight away and goes to the usual Super Admin approval step.
3. **Student number is not on the masterlist:** the account can sign in immediately but is *unverified*. A dashboard banner explains this, and scheduling a visit, new requests, ID applications, referrals and event requests are blocked (in the UI and on the server with `NOT_VERIFIED`). The Help Desk, FAQs, Forms, Student Bulletin and Complaints stay available.
4. A Super Admin clears the **Needs Verification** card on the admin dashboard: *Verify* confirms the student and adds them to the masterlist, *Reject* removes the account and tells the student to visit the SSO.
5. Accounts are also verified automatically when a matching masterlist entry is added or imported, but only if the name agrees. A different name is flagged for manual review, so a student number cannot be claimed by someone else.

---

## Archiving and backups

- **Auto-archive:** the server checks shortly after start-up and then hourly, and archives once a day. Finished records (completed, cancelled, rejected, resolved, closed and similar) older than **30 days** are moved to an *Archived* view. The window is configurable in **System Settings → Backups & Archives**. Open requests and complaints are never archived. Old assistant chat history is purged on the same schedule (90 days by default).
- **Without the built-in scheduler:** call `POST /api/cron/archive` with `Authorization: Bearer $CRON_SECRET` (add `?dryRun=1` to preview).
- **Backups:** Super Admins can export a full JSON backup and restore from one in **System Settings → Backups & Archives**. Keep backups somewhere secure, as they contain personal data.

---

## AI assistant

- **How it answers:** bilingual rules plus the FAQ knowledge base (English, Tagalog, Taglish, with typo repair), live status lookups for the signed-in student's own records, contextual action pills and thumbs feedback.
- **Privacy rails:** identifiers are masked before chat messages are stored, output is scrubbed of other students' numbers and emails, and requests for other people's data or prompt-injection attempts are refused. Confidential `REF-` and `CMP-` records, TOR and billing questions are intercepted before retrieval.
- **Training:** Admins review unanswered and thumbs-down questions in **FAQs**, and can dry-run any query in the **AI Chatbot Training Playground** (`POST /api/assistant/simulate`). Rebuild embeddings with `POST /api/assistant/embeddings/rebuild`.
- **Evaluation:**
  ```bash
  npx tsx scripts/eval-assistant.ts   # 51 labeled cases (EN / Tagalog / Taglish / typos / safety)
  ```

---

## Running in production

```bash
npm run build
npm start                 # http://localhost:3000
```

- Run `npx prisma migrate deploy` before starting after pulling new code.
- A production server does not reload on changes, so rebuild and restart after each code change.
- The server must stay running for the daily auto-archive to happen.

---

## Deploying to Render

[`render.yaml`](./render.yaml) is a ready-to-use Blueprint:

1. In Render choose **New → Blueprint** and connect this repository.
2. It provisions the web service and PostgreSQL database and runs `npm ci && npx prisma migrate deploy && npm run bootstrap:admin && npm run build`.
3. Set `NEXT_PUBLIC_APP_URL`, `BOOTSTRAP_SUPER_ADMIN_*` and, if you want real email, the `SMTP_*` variables.
4. Optional: for semantic FAQ search run `CREATE EXTENSION IF NOT EXISTS vector;` once on the database.

Files uploaded through the app are stored in PostgreSQL (`UploadedFile`) and served from `/api/uploads/[file]`, so they survive container restarts.

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Type-check, lint and build for production |
| `npm start` | Start the production server |
| `npm run lint` | ESLint |
| `npx prisma migrate deploy` | Apply database migrations |
| `npm run prisma:seed` | Load demo data (`-- --reset` to clear first) |
| `npm run bootstrap:admin` | Create or update the production Super Admin |
| `npx tsx scripts/eval-assistant.ts` | Run the AI assistant evaluation |

---

## Project structure

```text
├── prisma/
│   ├── schema.prisma              # Data models
│   ├── migrations/                # SQL migrations
│   ├── seed.ts                    # Demo data generator (relative dates, deterministic)
│   └── bootstrap-super-admin.ts   # Production Super Admin bootstrap
├── public/
│   ├── app.js                     # Portal logic: navigation, lists, modals, scanner, chatbot UI
│   └── uploads/                   # Sample files written by the seed (git-ignored)
├── scripts/
│   └── eval-assistant.ts          # AI assistant evaluation harness
├── docs/                          # Specs, workflow notes and test walkthroughs
├── src/
│   ├── app/
│   │   ├── api/                   # auth, queue, modules, assistant, settings, archive, backup, calendar, reports
│   │   ├── globals.css            # Theme and layout styles
│   │   └── layout.tsx, page.tsx   # Root layout and portal shell
│   ├── components/                # Shared React components (toasts)
│   ├── content/body.html          # Page templates for every role
│   ├── instrumentation.ts         # Starts the daily auto-archive when the server boots
│   └── lib/
│       ├── appointments.ts        # Slot rules, locks, appointment/request sync
│       ├── archive.ts, auto-archive.ts   # 30-day archiving and its scheduler
│       ├── verification.ts        # Student verification against the masterlist
│       ├── assistant*.ts          # Assistant rules, words, pills, privacy, data access
│       ├── auth.ts, http.ts       # Sessions, role checks, strict number parsing
│       ├── mailer.ts, notify.ts   # Email transport, notifications, audit log
│       └── signature.ts           # QR signing (HMAC-SHA256)
├── docker-compose.yml             # Local PostgreSQL 16 + pgvector
└── render.yaml                    # Render Blueprint
```

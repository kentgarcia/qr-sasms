<div align="center">

<img src="./public/pup-seal-icon.png" alt="PUP San Pedro Campus Seal" width="110" />

# STARS — Student Transaction & Appointment Request System

**Official Student Services Office (SSO) Portal for Polytechnic University of the Philippines — San Pedro Campus**

[![Next.js](https://img.shields.io/badge/Next.js-14-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16_%2B_pgvector-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Prisma](https://img.shields.io/badge/Prisma-5.20-2D3748?style=for-the-badge&logo=prisma&logoColor=white)](https://www.prisma.io/)
[![License](https://img.shields.io/badge/Campus-PUP_San_Pedro-8B1A1A?style=for-the-badge)](#)

*Service-typed appointments · Signed offline QR passes & live camera scanner · Bidirectional request sync · Bilingual AI Support Assistant · 4-Role RBAC*

</div>

---

## ✨ Key Features

| Module | What It Does |
|---|---|
| 📅 **Appointment & Queue System** | Service-typed bookings (`General Visit`, `Event Consultation`, `Psychological Intervention`) with per-service slot capacity, weekday/holiday rules, 24h reschedule/cancel cutoff, max 2 reschedules, and race-safe Postgres advisory locks. |
| 🔄 **Bidirectional Transaction Sync** | Request-first services (`Student ID New/Lost`, `Authentication`, `Excuse Slip`) automatically generate a synced `APT-###` queue entry when SSO schedules a pickup — serving the appointment completes both records atomically. |
| 📱 **Offline Signed QR Pass & Live Scanner** | Every confirmed appointment and pickup produces a tamper-evident HMAC-SHA256 QR pass (`STARS1\|code\|sn\|dateISO\|hmac8`) — downloadable as PNG, printable, and embedded directly in confirmation/pickup emails. Staff verify via camera (`html5-qrcode`) or manual lookup on the Service Desk. |
| 🤖 **AI Support Assistant** | Bilingual (English, Tagalog, Taglish) rule + FAQ + optional `pgvector` semantic assistant with live student status lookups (`APT-`, `AUT-`, `EXC-`, `GEN-`, `IDA-`, `EVT-`, `TKT-`), rich contextual action pills (`Show QR Pass`, `Reschedule`, filtered navigation, prefilled Help Desk tickets), safety rails (TOR, billing, confidentiality), thumbs feedback, and an Admin Training Playground. |
| 🔐 **Hardened Auth & 4-Role RBAC** | `bcryptjs` password hashing, `httpOnly` signed JWT cookies (`jose`), strict strong-password enforcement (9+ chars with uppercase, lowercase, number, and special character), masterlist verification, 6-digit email/Gmail OTP registration, and strict server-side role scoping across `STUDENT`, `ADMIN`, `SUPER_ADMIN`, and `SCANNER`. |
| ⚡ **Real-Time Portal & Dashboard UX** | Live Server-Sent Events (`/api/events`), consistent `Asia/Manila` (PHT) timezone formatting, URL hash + `sessionStorage` tab persistence on browser refresh, interactive Student & Admin KPI shortcut cards, and a Super Admin-configurable PUP San Pedro login splash screen. |
| 🏢 **Full SSO Operations Suite** | Student ID Applications, Authentication & Excuse Slips, Organization & Event Requests (org-rep gated), Confidential Psychological Referrals & Complaints, Bulletins, Downloadable Forms, Help Desk Tickets, Masterlist CSV Import, Analytics & CSV Exports, Email Outbox/Blasts, and Full DB Backup & Restore. |

---

## 👥 Role-Based Access Control (4 Roles)

| Role | Access Scope |
|---|---|
| **Student** | Dashboard KPI shortcuts, Book/Request services, My Appointments & Offline QR Pass, ID Applications, Event Requests (active org reps only), Referrals, Complaints, Bulletins, Forms, AI Support Assistant, Help Desk Tickets, Account & Profile Change requests. |
| **Scanner** | Service Desk live camera QR scanner + manual code verification, daily appointment manifest (with `PSYCH` details masked as `Reserved — Confidential`), Check-in / Serve / No-Show actions. |
| **Admin** | Operational dashboard, Appointment approval & queue management, Service Request & ID pickup scheduling, Referrals, Complaints, Events, Help Desk replies/closing, Bulletins, FAQ Manager & AI Training Playground, Forms, Audit Log, Email Outbox. |
| **Super Admin** | All Admin capabilities **plus** Masterlist Manager, Accounts & Access (approvals, staff management, profile verifications), Organizations & Reps, System Settings (hours, per-service capacity, holidays, splash image, AI thresholds), Email Blasts, Insights & Analytics, CSV Exports, and Database Backup & Restore. |

> All Super Admin routes are both hidden in the UI **and** enforced with `403 FORBIDDEN` on the server. Confidential records (`Referral`, `Complaint`, `Ticket`, `IdApplication`, `EventRequest`) are scoped to the owning student or authorized staff at the database query level.

---

## 🛠️ Tech Stack

- **Framework:** Next.js 14 (App Router), React 18, TypeScript 5.6
- **Database & ORM:** PostgreSQL 16 (`pgvector/pgvector:pg16`) + Prisma 5.20
- **Authentication & Crypto:** `jose` (HS256 JWT in `httpOnly` cookies), `bcryptjs`, Node `crypto` (HMAC-SHA256 QR signatures)
- **QR Generation & Scanning:** `qrcode` (server PNG/data-URL + email CID attachments), `html5-qrcode` (live camera scanner)
- **Email Delivery:** Nodemailer SMTP (or built-in `SIMULATED` outbox mode when SMTP vars are unset)
- **AI Search (Optional Semantic):** Ollama embeddings (`all-MiniLM-L6-v2`) + Postgres `pgvector` cosine search with automatic rule + keyword fallback

---

## 🚀 Quick Start (Local Development)

### Prerequisites
- **Node.js** `18.18+` (recommended `20.x`) and `npm`
- **Docker** (for the bundled `pgvector` PostgreSQL 16 container), or an existing PostgreSQL instance

### 1. Install dependencies
```bash
npm install
```

### 2. Start PostgreSQL (`pgvector`)
```bash
docker compose up -d db
```

### 3. Configure environment variables
```bash
cp .env.example .env
```
Update `.env` with your local values (at minimum `AUTH_SECRET` and `DATABASE_URL`):
```bash
openssl rand -base64 48   # generate a strong AUTH_SECRET
```

### 4. Apply migrations & seed demo data
```bash
npx prisma migrate deploy
npm run prisma:seed
```

### 5. Run the development server
```bash
npm run dev
```
Open **http://localhost:3000** in your browser.

---

## 🔑 Seeded Demo Accounts

Running `npm run prisma:seed` populates realistic demo data (24 system FAQs across 7 categories, masterlist entries including an unregistered student `2024-00200-SP-0` for OTP registration testing, an org-rep student `2024-00102-SP-0`, pending bookings, and sample requests):

| Role | Email / Student Number | Password |
|---|---|---|
| **Student** | `student@pup.edu.ph` or `2024-00123-SP-0` | `student123` |
| **Admin** | `admin@pup.edu.ph` | `Admin@2026!` |
| **Super Admin** | `superadmin@pup.edu.ph` | `SuperAdmin@2026!` |
| **Scanner** | `scanner@pup.edu.ph` | `scan2026` |

> ⚠️ **Production Note:** Use `npm run bootstrap:admin` (`BOOTSTRAP_SUPER_ADMIN_EMAIL` / `BOOTSTRAP_SUPER_ADMIN_PASSWORD`) to provision your production Super Admin, and change or remove all demo accounts immediately after deployment.

---

## ⚙️ Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string (defaults to local Docker Postgres). |
| `AUTH_SECRET` | **Yes** | Random secret used to sign JWT sessions and appointment QR HMAC payloads. |
| `NEXT_PUBLIC_APP_URL` | Prod | Public base URL (e.g. `https://stars.onrender.com`) for password-reset links. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | Optional | SMTP server config (e.g. `smtp.gmail.com`, `587`, `false`). Leave unset for `SIMULATED` mode. |
| `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Optional | SMTP credentials (e.g. Gmail App Password) for live OTPs, confirmations, and embedded QR emails. |
| `OLLAMA_BASE_URL`, `ASSISTANT_EMBED_MODEL` | Optional | Enables semantic `pgvector` FAQ search; omits cleanly to rule + keyword mode when unset. |
| `CRON_SECRET` | Optional | Bearer secret protecting `POST /api/cron/reminders`. |
| `BOOTSTRAP_SUPER_ADMIN_*` | Prod | Initial Super Admin email, password, and name for `npm run bootstrap:admin`. |

---

## 🤖 Managing & Training the AI Assistant

1. **Knowledge Base (24 Seeded FAQs):** Sign in as Admin → **FAQ** to add/edit FAQs across 7 categories. FAQ matching automatically uses the bilingual synonym + typo-repair pipeline in `src/lib/assistant-words.ts`.
2. **Admin Training Playground:** Use the **AI Chatbot Training Playground** at the top of the Admin **FAQ** page (`POST /api/assistant/simulate`) to dry-run any English, Tagalog, or Taglish query and inspect the matched stage, rule ID, FAQ ID, confidence, and tokens.
3. **Unanswered & Feedback Curation:** Review low-confidence and thumbs-down (`👎`) clusters in FAQ Manager and promote them to verified FAQs. Rebuild vector embeddings anytime via `POST /api/assistant/embeddings/rebuild`.
4. **Safety Rails (Always Enforced):** Transcript of Records (`TOR`) inquiries, billing/tuition inquiries, and confidential `REF-`/`CMP-` references are intercepted before retrieval and never leak private records.
5. **Automated Evaluation Harness:**
   ```bash
   npx tsx scripts/eval-assistant.ts
   ```
   Verifies **51 labeled EN/Tagalog/Taglish/typo/safety test cases** (target: ≥90% accuracy, 0 safety violations — currently **51/51 = 100%**).

---

## ☁️ Deploying to Render

This repository includes a ready-to-use [`render.yaml`](./render.yaml) Blueprint:

1. In Render, select **New → Blueprint** and connect this GitHub repository.
2. Render provisions both the Node.js web service and PostgreSQL database automatically, running:
   ```bash
   npm ci && npx prisma migrate deploy && npm run bootstrap:admin && npm run build
   ```
3. Configure `NEXT_PUBLIC_APP_URL`, `BOOTSTRAP_SUPER_ADMIN_*`, and optional `SMTP_*` variables in the Render dashboard.
4. *(Optional)* For semantic FAQ search on Render Postgres, run `CREATE EXTENSION IF NOT EXISTS vector;` once on the database.

> Note: Uploaded files are persisted in PostgreSQL (`UploadedFile` table) and served via `/api/uploads/[file]`, so uploads survive ephemeral container restarts on Render.

---

## 📜 Useful Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Next.js development server (`http://localhost:3000`) |
| `npm run build` | Compile, typecheck, and build production bundle |
| `npm start` | Start production Next.js server |
| `npm run lint` | Run ESLint checks |
| `npx prisma migrate deploy` | Apply all Prisma SQL migrations |
| `npm run prisma:seed` | Idempotently seed demo users, masterlist, requests, and 24 FAQs |
| `npm run bootstrap:admin` | Create or update the production Super Admin account |
| `npx tsx scripts/eval-assistant.ts` | Run the 51-case AI chatbot accuracy & safety evaluation suite |

---

## 📂 Project Structure

```text
├── prisma/
│   ├── schema.prisma              # PostgreSQL + pgvector data models (incl. EmailOtp)
│   ├── migrations/                # Versioned SQL migrations
│   ├── seed.ts                    # Idempotent demo data & 24 system-aligned FAQs
│   └── bootstrap-super-admin.ts   # Production Super Admin bootstrap script
├── public/
│   ├── app.js                     # Client portal logic (SPA nav, SSE, QR scanner, chatbot UI)
│   ├── pup-seal.jpg               # PUP San Pedro official seal
│   └── pup-san-pedro-campus.svg   # Default PUP San Pedro Campus login splash artwork
├── scripts/
│   └── eval-assistant.ts          # 51-case automated AI chatbot evaluation harness
├── src/
│   ├── app/
│   │   ├── api/                   # REST endpoints (auth, OTP, queue, QR, scan, modules, assistant, settings)
│   │   ├── forgot-password/       # Password reset request page
│   │   ├── reset-password/        # Strong-password reset page with live checklist
│   │   ├── globals.css            # Glassmorphism theme & responsive layout styles
│   │   ├── layout.tsx             # Root layout, fonts & script loaders
│   │   └── page.tsx               # Portal shell loader
│   ├── content/
│   │   └── body.html              # Portal page templates (Auth, Student, Admin, Scanner, Settings)
│   └── lib/
│       ├── appointments.ts        # Slot validation (Asia/Manila), locks & bidirectional sync
│       ├── assistant*.ts          # NLP words, rules, pills, SIS data reader, curation & embeddings
│       ├── auth.ts                # JWT session cookies & bcrypt helpers
│       ├── format.ts              # Asia/Manila date/time formatters
│       ├── mailer.ts              # SMTP / simulated email transport (HTML + QR attachments)
│       ├── notify.ts              # Student email notifications (with embedded QR) & audit logs
│       ├── password.ts            # Shared strong-password validator (9+ chars + symbol)
│       └── signature.ts           # Document & offline appointment QR HMAC-SHA256 signing
├── docker-compose.yml             # Local pgvector PostgreSQL 16 database
└── render.yaml                    # Render Blueprint deployment config
```

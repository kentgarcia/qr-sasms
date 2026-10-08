# STARS — Student Transaction and Appointment Request System

Real, database-backed backend for the PUP San Pedro SSO document/service
portal. The original frontend's visual design and markup are untouched
(`src/content/body.html` is a byte-for-byte copy of the original `<body>`,
`src/app/globals.css` is a byte-for-byte copy of the original `<style>`
block) — only the JavaScript behind it was rewired from
localStorage-mocked data to real API calls (`public/app.js`).

 

- **PostgreSQL via Prisma** — every entity (users,
  appointments/queue (service-typed: Authentication, Excuse Slip, ID New/Lost,
  Event, Psychological Intervention, General), referrals, ID applications,
  bulletins, help desk tickets, FAQs, event requests, complaints, downloadable
  forms, email blasts, audit log, email outbox, in-app notifications, SSO
  masterlist) is a real table. See `prisma/schema.prisma`.
  Document requests were retired: Authentication and Excuse Slips are booked
  directly as appointments (purpose + copies captured at booking).
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
  `https://stars.onrender.com`. This is required for password-reset links.
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` — only if real email
  delivery is needed. Leave them blank to use the built-in simulated email mode.

The Render build command syncs the current Prisma schema and runs the idempotent
demo seed once safely. The default first-login accounts are listed below; change
their passwords immediately after deployment.

> Render's free disk is ephemeral. Files uploaded to the application can be lost
> after a redeploy or restart. Use an external object-storage service before using
> the system in production for real student files.

## Demo logins (created by the seed script)

| Role        | Username                                        | Password            |
|-------------|-------------------------------------------------|---------------------|
| Student     | `2024-00123-SP-0` (or `student@pup.edu.ph`)     | `student123`        |
| Admin       | `admin@pup.edu.ph`                              | `Admin@2026!`       |
| Super Admin | `superadmin@pup.edu.ph`                         | `SuperAdmin@2026!`  |
| Scanner     | `scanner@pup.edu.ph`                            | `scan2026`          |

### Admin vs Super Admin

Normal **Admin** accounts get the operational tools: dashboard (queue,
audit, email outbox), service requests, and bulletin/FAQ/forms managers.
**Super Admin** adds the restricted tools, which are hidden from normal
admins in the UI **and** rejected with `403 FORBIDDEN` at the API:
Records (Masterlist Manager, Accounts & Access incl. verifications and
account approvals), staff accounts, student registry, organizations,
masterlist groups, System Settings, Email Blast, Insights & System
(analytics, CSV exports, reminders), and Backup & Restore. Full matrix:
`docs/admin-superadmin-separation-spec.md`.

> Reseeding an older database migrates the legacy `admin@pup.edu.ph`
> account to the normal Admin role after ensuring a Super Admin exists,
> so the system is never left without one. For production, create the
> real Super Admin with `npm run bootstrap:admin`
> (`BOOTSTRAP_SUPER_ADMIN_EMAIL` / `BOOTSTRAP_SUPER_ADMIN_PASSWORD`)
> instead of using the demo credentials. Change all demo passwords
> immediately after deployment.

The seed also imports a small masterlist (including one **unregistered**
student, `2024-00200-SP-0` / Carla Dizon) so you can test the full
"Create Account" → "Awaiting admin approval" → admin approves →
sign in" flow end to end. It also seeds an approval inbox (`APT-008` /
`APT-010` awaiting review), a General Visit bundle (`APT-007` ↔
`GEN-SEED01`), a pickup demo (`EXC-SEED01`), an org-rep student
(`2024-00102-SP-0` / Pedro Reyes) with a seeded organization, and
system settings — so the appointment, pickup, event, and settings
workflows are walkable on a fresh database with no manual setup
(full matrix: `docs/seed-data-enhancement-spec.md`).

## AI assistant — adding knowledge

The student chatbot answers from two knowledge kinds. Full design:
`docs/ai-assistant-ticket-escalation-spec.md` (matching + escalation) and
`docs/ai-assistant-conversational-ux-spec.md` (tone, intents, guidance).

**1. Verified FAQs (the knowledge base).** Sign in as Admin → **FAQ
Manager** → pick a category → **Add FAQ**. Each entry needs a natural
question title and a self-contained answer:
- Write process answers as **numbered steps ending with the outcome**
  (e.g. "1. Open Appointments → Book Appointment. 2. Choose Excuse Slip…
  3. … Bring supporting documents to your visit."). The chatbot quotes
  answers verbatim and appends a deep-link button.
- The **category decides the button**: Appointments → Open Appointments,
  ID → Open ID Application, Events → Open Event Requests, document /
  request / service → Open Appointments (filing lives on the Book
  Appointment page; tracking under My Appointments). Put the entry in
  the matching category or the fallback buttons appear.
- You don't need to add every wording — semantic search handles
  paraphrases ("Where do I file my excuse slip?" matches "How do I request
  an Excuse Slip?"). Add a new FAQ only when students ask something
  uncovered.
- Transcript of Records (TOR) entries are rejected — this portal does not
  handle TOR, and the chatbot will never answer it.
- Saving is live immediately. If Ollama was down when you saved, re-index
  with `POST /api/assistant/embeddings/rebuild` (admin) once it's back.

**2. Unanswered questions → new FAQs (curation loop).** FAQ Manager shows
**"Questions needing answers"** — real student questions the bot couldn't
answer, with ask counts, a suggested category, and a warning when an
existing FAQ may already cover them. Click **Answer as FAQ**, write the
answer, save. Repeat questions then match the new entry and the cluster
clears on its own.

**3. Small talk, word recognition & transaction rules (code, not database).** Greetings, thanks,
farewells, and "what can you do" are recognized from phrase lists in
`src/lib/assistant-words.ts` (normalizer, EN+TL synonyms, typo repair, starter intents) — adding a variant (e.g. another Tagalog
greeting) is a one-line change there. Deterministic process guidance for every SSO transaction
(appointments, request-only lanes, reschedule/cancel, ID new/lost, events/org-rep, referrals,
complaints, tickets, bulletins, forms, account, office hours) lives in `src/lib/assistant-rules.ts`
as `{needs, wants, phrases}` rules with curated numbered-step replies. Rule-authoring convention:
`needs` = tokens that must ALL be present (canonical, post-synonym), `wants` = scoring bonus
(include the self-token so bare mentions guide instead of falling back), `phrases` = multi-word
triggers checked against the normalized message. The servant-voice rules live next to
them; verified answers and the safety fallback are never reworded by the
bot.

**4. Follow-ups remember the conversation (no setup).** Within one chat,
the bot resolves `it`, `the first one`, `yes` (after a clarification
question), and `the other one` from the session's own recent messages —
scoped to that student only, and explicit reference codes always win.
Pronouns with no prior context are never guessed. Full design:
`docs/ai-assistant-improvement-spec.md` (F-1).

**5. Feedback loop (👍/👎 + curation v2).** Every bot answer carries
thumbs up/down; re-tapping removes the vote. Super Admin →
**Insights & System** shows the down-rate, worst-rated FAQs/rules, and
per-pill taps. FAQ Manager's curation queue additionally surfaces
rule/synonym suggestions (near-miss clusters), rules with zero hits in 30
days, settings-drift warnings (e.g. cutoff or office hours changed after
the reply text was written), and 👎-heavy answers first.

**6. Tuning.** Super Admin → **System Settings → AI Assistant**: keyword
high score plus semantic high/medium similarity. Lower values answer more
(risking misses); higher values escalate to support tickets more often.
Semantic matching needs Ollama running (`OLLAMA_BASE_URL`,
`ASSISTANT_EMBED_MODEL` in `.env`) — without it the bot runs in keyword
mode automatically. Rule answers are logged as `FAQ_CHATBOT_QUERY:rule:<id>`
and count as answered/high; safety rails (TOR guard, referral/complaint
confidentiality, billing notice) always run before rules and are never
bypassed. Full design: `docs/ai-assistant-rulebased-chatbot-spec.md`.

## Project layout

```
prisma/schema.prisma      All database models
prisma/seed.ts            Demo data (users, requests, queue, FAQs, masterlist)
src/lib/                  auth, prisma client, mailer, notifications, uploads, formatting,
                      assistant (chatbot matching in assistant.ts, status reads in
                      assistant-data.ts, word recognition in assistant-words.ts,
                      transaction rules in assistant-rules.ts, curation in
                      assistant-curation.ts, embeddings in embeddings.ts)
src/app/api/**            Every REST endpoint the frontend calls
src/app/layout.tsx         Original <head> (fonts, CDN scripts, stylesheet)
src/app/globals.css        Original <style> block, copied verbatim
src/content/body.html      Original <body> markup, copied verbatim
src/app/page.tsx           Renders body.html + loads public/app.js
public/app.js              Rewired client logic (real fetch calls, same UI)
public/uploads/            Uploaded files land here at runtime
```

## Notes / deliberate deviations from the prototype

- **Session persistence**: the original never restored a session on
  reload. This build restores it from the signed cookie via `/api/auth/me`.
- **Service Desk page** (scanner role): with document claims retired, the old
  QR-scanner claim flow was removed. Scanners now work the day's appointment
  manifest (check-in / serve), with confidential rows masked.
- **Removed** the unused EmailJS CDN `<script>` tag reference from the
  `<head>` — email is sent from the server now, so the client-side EmailJS
  SDK is no longer loaded. This is the only non-visual line removed from
  the original file.

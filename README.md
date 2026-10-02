# FollowUp — self-hosted Basecamp-style project & follow-up system

Projects, to-dos (each with its own page), progress updates, message board, Campfire chat, automatic check-ins, schedule, card table, hill charts, files, DMs, bookmarks, search, project-scoped @mentions with autocomplete, reactions, Trash/restore, inbox, notifications, and admin user management.

The responsive workspace opens projects directly to their To-dos and named to-do lists. On phones, a persistent navigation dock keeps My Work, Projects, and Notifications within reach. Lists hold grouped assignments, due dates, comments, and reactions. Project Automatic Check-ins create individual daily, weekly, monthly, or one-time requests; recipients answer each request and discuss the answer in its own thread. Attachments are available on messages, comments, answers, inbox messages, and chat. Users can set their own profile picture, dark/light/system theme, and accent colour. Admin-managed job titles appear with profiles.

**This deployment enforces everything on the server**: logins, roles, private projects, DMs, invite codes and file access are checked by the backend, not the browser.

**Stack:** Node.js 22 · Fastify 5 · SQLite (local) or PostgreSQL (Vercel) · Server-Sent Events locally / polling on Vercel · Web Push (VAPID) + SMTP email · Docker.

---
## 1. Run it (Docker — recommended)
```bash
unzip followup-server.zip && cd followup
cp .env.example .env        # edit BASE_URL, COOKIE_SECURE, SMTP_URL …
docker compose up -d --build
```
Open `http://SERVER:3000` → **Sign up**. **The first account created on a fresh server becomes the admin/owner** (no invite code needed). Everyone else needs an invite code, or an admin creates their account.

## 2. Run it without Docker
```bash
npm install
cp .env.example .env && export $(grep -v '^#' .env | xargs)   # or set variables yourself
npm start                    # Node 20+; data is stored in ./data
```

> **Windows tip:** Node 22.13+ uses its built-in SQLite by default; older Node versions use `better-sqlite3`. Force the built-in driver with `FORCE_NODE_SQLITE=1` on supported Node versions. Install from a short path such as `C:\followup`.

## 3. Deploy to Vercel
1. Import this repository into Vercel with the `followup/` directory as the project root. The checked-in `public/index.html` is generated from the legacy UI; `npm run build` regenerates it.
2. Add a Neon Postgres database and set `DATABASE_URL` to its pooled connection string.
3. Connect a **private** Vercel Blob store (recommended: connect it to the project for OIDC credentials; a `BLOB_READ_WRITE_TOKEN` also works).
4. Set a long random `CRON_SECRET` in Vercel. The configured Vercel Cron calls `/api/cron` every five minutes to process scheduled check-ins, reminders, and session expiry.
5. Deploy. Vercel deployments use secure cookies and polling for live UI updates; persistent data and attachments live in Postgres and private Blob storage. Local disk storage is not used on Vercel.

Vercel's request-size limit means uploads are capped at 4 MB there (local installs default to 25 MB). The first account on an empty Neon database becomes the admin. This project cannot be deployed until the Vercel project, Neon database, and Blob store are connected and their environment variables are configured.

## 4. HTTPS (required for production and for phone/desktop push)
Put a reverse proxy in front and set `COOKIE_SECURE=true`, `TRUST_PROXY=true`, `BASE_URL=https://your.domain`.
Caddy (automatic certificates), `Caddyfile`:
```
followup.example.com {
  reverse_proxy localhost:3000
}
```
(nginx: proxy to :3000 and set `proxy_buffering off;` for the `/api/stream` live-update route.)

## 5. Managing people (⚙ admin)
* **👥 Users → Create a user**: account is created instantly with a temporary password (shown once; also emailed if SMTP is set). Set the user's job title in **Position**; users cannot change their own position. 🔑 resets a password. Role menu: admin / member / viewer. *Remove* blocks access and ends their sessions.
* **👥 Users → Bulk import users from Excel**: download the `.xlsx` template, then upload a workbook with **Full Name**, **Email**, and **Role** headers; **Temporary Password** (optional) and **Position** are supported. Blank passwords are generated and returned once in the import result. The importer accepts up to 500 user rows and reports invalid/duplicate rows without hiding them.
* **👥 Users → Invite users**: generate one-time or multi-use codes with expiry; people sign up themselves at the Sign up tab.
* **⚙ Settings → “New people must be approved”**: people without a code can sign up and wait as *pending* until an admin approves.
* Users change their own password in **⚙ Settings**.

## 6. Notifications
* In-app: bell, inbox, @mentions, CC, assignments, replies, completions, nudges, and scheduled check-ins — live via SSE.
* **Automatic Check-ins:** open a project’s Check-ins tool, create a question, select the first local date/time, recurrence, and project members. Each occurrence creates a recipient-specific request that only the target can answer; answers and follow-up comments stay threaded on it.
* `@TEAM` and individual mention suggestions are limited to members with access to the current project.
* **Push to phones/desktops:** each user clicks **Enable alerts** once (HTTPS required; on iPhone, “Add to Home Screen” first). VAPID keys are generated automatically in `data/vapid.json`.
* **Email:** set `SMTP_URL` + `MAIL_FROM`; every notification is also emailed (`EMAIL_NOTIFS=0` to turn off).
* **Automatic follow-ups:** the server itself scans every `SWEEP_MINUTES` (default 60) and reminds assignees of overdue / stale (2+ days) to-dos, at most once per 24 h per to-do — no admin has to be online.
* SMS is not included (add a provider such as Twilio inside `external()` in `server.js`).

## 7. Security model (what the server enforces)
| Area | Rule |
|---|---|
| Auth | scrypt password hashes, HttpOnly SameSite cookie sessions (30 d), login/signup rate limiting, CSRF header required on writes |
| Projects | visible only to creator, people granted access, and admins; to-dos, messages, chat, check-ins and files inherit this |
| Roles | viewer = read-only; member = create/edit in projects they can see; admin = everything. Only admins change roles, settings, invites |
| Inbox / DMs | only the recipient (inbox) or the two participants (DMs) can read; sender is stamped by the server and cannot be forged |
| Files | stored on disk outside the web root, served only to users who can see the project; risky types forced to download |
Known limits: inside a project any member can edit others’ items through the API (the UI restricts this to author/admin); no email verification or email-based password reset (admins reset passwords); the CSP allows inline scripts because the UI is a single file; single-node SQLite (good for hundreds of users, not thousands).

## 8. Operations
* **Backup:** stop or snapshot and copy the `data/` folder (SQLite DB + uploads + VAPID keys). Online: `sqlite3 data/followup.db ".backup backup.db"`.
* **Update:** replace files, `docker compose up -d --build`. The schema is created automatically.
* **Health check:** `GET /healthz`.
* **Tests:** with a fresh server running: `BASE=http://localhost:3000 npm test` (end-to-end auth, privacy, check-in, position, Excel import, file, and realtime checks).

## 9. Project layout
```
server.js                 API, auth, permissions, SSE, uploads, push/email, reminder job
public/index.html         the full UI (your current app, adapted)
public/shim.js            lets the original UI code talk to this server (same data model)
public/auth.js            login / sign-up / password / push client code
public/sw.js, manifest    service worker + installable PWA
scripts/build-frontend.py regenerates public/index.html from legacy/claude-artifact/followup-app.html
scripts/smoke-test.mjs    end-to-end tests
legacy/claude-artifact/   the original Claude-artifact version, untouched
```

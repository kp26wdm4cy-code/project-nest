# Accounts & logins — scoping

Status: **Phase 1 (auth MVP) is BUILT and live (v3).** Nest now requires a magic-link
sign-in; only allow-listed emails can get in. This doc keeps the full plan; the sections
below note what's done vs. still to come.

## What's built (v3 — magic-link auth MVP)

- Passwordless **magic-link sign-in** via the existing SendGrid. Enter email → one-time
  link (20-min expiry, single use) → server-side session in an `HttpOnly; Secure;
  SameSite=Lax` cookie (30 days). Endpoints: `POST /api/auth/request`, `GET
  /api/auth/callback`, `POST /api/auth/logout`, `GET /api/me`. In local dev (no SendGrid)
  the link is returned in the response so you can click through.
- **Allow-list** (`allowed_users` setting, seeded with Ralf) gates who can sign in —
  managed in-app under "People who can sign in" (name + email). Adding someone = a
  lightweight invite. Requests for non-allowed emails get a uniform response (no account
  enumeration); the signed-in user can't remove themselves.
- Tables `users`, `sessions`, `login_tokens`. Every `/api/*` route requires a session
  **except** the two cron jobs (`/api/discover`, `/api/send-weekly`), which act on shared
  data with no private read-back.
- The old Ralf/Hannah localStorage toggle is gone — **your verdict is attributed to the
  signed-in user** (set server-side, never client-supplied). The UI generalised from two
  fixed people to "you + everyone else who reacted". Existing `feedback.person`
  = 'Ralf'/'Hannah' still lines up because those users' names are Ralf/Hannah.
- Data is still **one shared workspace** (everyone allow-listed sees the same shortlist).
  The app is now private instead of open to the world.

## Also built (Google sign-in — optional second method)

- **"Sign in with Google"** (OAuth Authorization Code). Endpoints `/api/auth/google` and
  `/api/auth/google/callback`; `/api/auth/config` tells the login screen whether to show
  the button. It resolves the Google email → the same allow-list → the same
  `establishSession` used by magic-link, so both methods behave identically.
- Off by default: the button only appears when `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
  are set. See the README for the one-time Google Cloud setup.

## Still to come (phases 2–3, NOT built)

- **Per-household data separation** (workspaces + `workspace_id` scoping on every query) so
  different couples get their own private shortlists — see the model + risks below.
- **Email invitations** with links (today's allow-list is add-by-email, no invite email).
- Roles, account management, delete-account, multi-workspace switching, and authenticated
  per-workspace cron runs.

---

## Original plan (for reference / phases 2–3)

## Where we are today

- One global dataset. Every visitor to the URL sees and can edit everything.
- "Ralf / Hannah" is just a `localStorage` toggle — not a login. It only tags which
  person a verdict/note belongs to.
- All data is global: `properties`, `feedback` (keyed by `person` text), `settings`
  (search areas, destinations, emails, briefs), `guest_notes`.
- Turso holds the data; the repo is public but carries no secrets (Turso/SendGrid creds
  live in Render env vars).

So the work is two things: **authentication** (prove who you are) and **multi-tenancy**
(each user/household only sees their own homes).

## Recommended approach

**Passwordless magic-link email**, on the current stack (Node + Turso + SendGrid), with a
**workspace** model for sharing.

Why magic-link over passwords:
- We already have SendGrid wired and a verified sender — near-zero extra setup.
- No passwords to hash, store, leak, or reset. This sidesteps the biggest security burden
  and is the safest option for a small app maintained by one person.
- Flow: enter email → we email a one-time signed link → click it → you're logged in.

Google OAuth is a fine alternative (also no password handling) but adds a Google Cloud
OAuth app to configure; magic-link is simpler given SendGrid is already there. A hosted
auth service (Clerk, Supabase Auth) would be faster to wire but adds a vendor and would
sit awkwardly next to the existing Turso DB — not worth it at this size.

Why a **workspace** (not just per-user data): the whole point of Nest is Ralf **and**
Hannah sharing one shortlist. So the unit that owns data is a *workspace* (a household),
and users are *members* of it. Today's shared space becomes one workspace with two members.

## Data model changes

New tables:
- `users(id, email UNIQUE, name, created_at)`
- `sessions(token PRIMARY KEY, user_id, expires_at, created_at)` — server-side sessions
- `login_tokens(token PRIMARY KEY, email, expires_at, used_at)` — single-use magic links
- `workspaces(id, name, created_at)`
- `memberships(workspace_id, user_id, role, PRIMARY KEY(workspace_id,user_id))` —
  role = `owner` | `member`
- `invites(token, workspace_id, email, role, expires_at, accepted_at)` — invite by email

Scope existing data to a workspace (guarded `ALTER … ADD COLUMN workspace_id`, same
pattern already used for `listing_type` etc.):
- `properties.workspace_id`, `settings` → keyed per workspace, `commutes/insights/media`
  follow their property, `guest_notes` follow their property.
- `feedback.person` (text "Ralf"/"Hannah") → `feedback.user_id` referencing `users`.

Migration for existing data: create one workspace, assign every current row to it, create
two users (Ralf, Hannah) from their known emails, map existing feedback `person` → the
matching `user_id`, and add both as members. Nothing is lost.

## Server changes (the bulk of the work)

- **Auth endpoints:** `POST /api/auth/request {email}` (rate-limited; always replies
  "check your email" so it can't be used to probe who has an account) → create a
  `login_token`, email a link `…/auth/callback?token=…`. `GET /api/auth/callback?token`
  → verify unused + unexpired, mark used, create a `session`, set cookie, redirect in.
  `POST /api/auth/logout` → delete session. `GET /api/me` → current user + workspaces.
- **Session middleware:** read the session cookie on every `/api/*` call, resolve
  `session → user → membership → workspace`, reject if missing. This is new plumbing the
  whole API routes through.
- **Authorization on every query:** today no query filters by owner. Each handler must add
  `WHERE workspace_id = ?` (and writes must set it). This is the largest and most
  security-critical change — every read and write must be scoped, or one user could see
  another's homes. Worth a careful pass + a test that user A cannot touch user B's data.
- **Cookies:** `HttpOnly; Secure; SameSite=Lax`, random 32-byte token (crypto), server-side
  session row with expiry. Do **not** put tokens in `localStorage` (XSS can steal them).
- **CSRF:** SameSite=Lax covers most; add an origin/host check on POST/PUT/DELETE.
- **Invites:** `POST /api/workspaces/:id/invite {email}` (owner only) → create invite +
  email a link; accepting adds a membership.
- **Crons:** the GitHub Actions discover/weekly-email jobs currently hit endpoints with no
  auth. They'd need a service token (shared secret in an Actions secret + env var) and to
  iterate per workspace. Weekly email would target workspace members instead of the
  `emails` setting.

## Front-end changes

- A **login screen** (email box → "check your email" → magic link → in). Gate the app: if
  `GET /api/me` returns no user, show login.
- Replace the Ralf/Hannah `localStorage` toggle with the **real logged-in user**; the
  "partner" becomes the other workspace member(s). Verdict buttons write as the current
  user.
- **Workspace switcher** if someone belongs to more than one; **invite teammate** UI;
  **logout**; basic **account/settings** (name, delete account).

## Security & responsibility checklist

- No passwords stored (magic-link/OAuth). If passwords are ever required, use argon2/bcrypt
  via a vetted library, never plaintext, with a proper reset flow.
- Rate-limit login + invite requests; uniform responses to avoid email enumeration.
- High-entropy, single-use, short-lived tokens (login links and sessions).
- HTTPS only (Render provides TLS); Secure cookies.
- Once real personal data is stored: a delete-account path, a short privacy note, and light
  terms — enough for friends/family use; more if it ever goes wider.
- Repo can stay public (no secrets in code); the app becomes private-by-default behind auth.

## Suggested phasing

1. **Auth MVP** — users + sessions + magic-link login, one workspace holding today's shared
   data, everyone signs in. App is now private. (~1–2 focused days.)
2. **Sharing** — workspaces + email invitations, so new couples/people get their own space.
3. **Polish** — roles, account management, delete-account, multi-workspace switching, and
   pointing the crons at authenticated per-workspace runs.

## Effort & risk

- It's a meaningful change: auth plumbing + a **scope-everything** pass over every query.
  The risky part isn't login, it's making sure no query leaks across workspaces — that
  deserves a deliberate review and a cross-tenant test.
- Render free tier sleeping is fine: a magic link wakes the app; sessions persist in Turso.
- Turso migrations follow the existing guarded-`ALTER` pattern.

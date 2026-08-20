# Project Nest

A small, private, shared dashboard for **Ralf & Hannah's first-home search** in London.
Both partners react to the same curated leads; every verdict and note is saved to a
shared database, so you each see the other's take — plus live area intelligence,
photos/floor plans, commute times, price-drop alerts and a weekly email.

**Live:** https://project-nest-2mzu.onrender.com
(Free Render instance — the first visit after ~15 min idle takes ~30–50s to wake.)

---

## Signing in

Nest is private — you sign in with a **magic link** (no password). Enter your email and,
if it's on the allow-list, you get a one-time sign-in link by email (works once, expires
in 20 minutes). Sessions last 30 days in a secure cookie.

- **Who can get in:** only allow-listed emails. Ralf (`ralf.g.saade@gmail.com`) is seeded.
  Add others (e.g. Hannah) in the app under **"People who can sign in"** — set the name to
  match their past verdicts (e.g. "Hannah") so their history lines up.
- **Your verdicts** are attributed to whoever is signed in (no more Ralf/Hannah toggle).
- **Local dev without SendGrid:** the sign-in link is shown on screen so you can click
  straight through — no email needed.
- Sending links in production uses the same SendGrid sender as the weekly email
  (`SENDGRID_API_KEY` / `SENDGRID_FROM`).

### Optional: "Sign in with Google"

The Google button appears **only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are
set** — otherwise magic-link is the only method and nothing else changes. Google users
still have to be on the allow-list (their Google email must match an allowed entry).

To turn it on, create an OAuth client in the Google Cloud Console (one-time):

1. **console.cloud.google.com** → create/pick a project.
2. **APIs & Services → OAuth consent screen** → External; add your email as a test user.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web
   application.**
4. **Authorized redirect URIs** — add both:
   - `https://project-nest-2mzu.onrender.com/api/auth/google/callback` (live)
   - `http://127.0.0.1:5181/api/auth/google/callback` (local dev, if you use it)
5. Copy the **Client ID** and **Client secret** into Render env vars `GOOGLE_CLIENT_ID`
   and `GOOGLE_CLIENT_SECRET`, then redeploy/restart.

The redirect URI must match exactly. The button then shows automatically.

Full design + what's next (per-household separation, email invites): see
[`docs/ACCOUNTS.md`](docs/ACCOUNTS.md).

---

## Run it locally

```powershell
npm install
npm start
```

Open the address it prints (default <http://127.0.0.1:5181>). **With no environment
variables set, it just works** — data goes to a local SQLite file at `data/nest.sqlite`,
and the optional integrations (Turso, transport, email) simply stay off.

Requires **Node.js 18+** (built and running on Node 24). Plain JavaScript, no build step.

---

## Continue it on another computer

Everything lives in the cloud, so nothing needs to move:

- **The running app + all data** are on Render + Turso — reach them from any device at the URL above.
- **The code** is on GitHub: `kp26wdm4cy-code/project-nest` (public).

To keep *building* it elsewhere (including with the Claude desktop app's coding tools):

1. Install **Node.js** and **git**.
2. `git clone https://github.com/kp26wdm4cy-code/project-nest.git`
3. `cd project-nest` and open the folder in the Claude desktop app / your editor.
4. `npm install` then `npm start` — it runs immediately against a local SQLite file.
5. Point Claude at **this README**; it explains the whole architecture below.

To run locally against the **live shared data** (instead of a throwaway local file),
set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` (see the table below) — get the values
from the Render service's Environment tab. A `git push` to `main` auto-deploys to Render.

> Note: the assistant's working notes for this project are kept in Claude's local
> memory on the original machine, not in this repo — so on a new machine, this README
> and the git history are the source of truth that orients a fresh session.

---

## Restore points (going back to a known-good version)

- Milestones are tagged in git. To list them: `git tag`. To return to one:
  `git checkout v1.0` (read-only look) or branch from it: `git switch -c fix v1.0`.
- **`v1.0`** = the first complete build (map + verdicts, area intelligence, gallery,
  taste discovery, district search, price drops, commutes, verdict-coloured pins,
  precise geocoding, weekly email, tenure/lease length).
- Render also keeps a deploy history — you can **roll back** to any past deploy from
  the service's *Events* tab without touching git.

---

## Environment variables

All optional — unset ones just disable that feature. **Never commit secret values.**

| Variable | Purpose | Where to get it |
|---|---|---|
| `PORT` | port to listen on (default 5181) | — |
| `TURSO_DATABASE_URL` | if set, data lives in Turso cloud (survives redeploys) | Turso dashboard |
| `TURSO_AUTH_TOKEN` | auth token for the Turso URL | Turso dashboard |
| `DB_PATH` | override the local SQLite path (local mode only) | — |
| `TFL_APP_KEY` | TfL key for transport + commute times (works keyless too) | api.tfl.gov.uk |
| `SENDGRID_API_KEY` | send the weekly summary email | SendGrid → API Keys |
| `SENDGRID_FROM` | the verified single-sender address the email comes from | SendGrid → Sender Auth |
| `CHECK_INTERVAL_MS` | background re-check interval (default 12h) | — |

Production values are stored in the **Render** service's Environment tab.

---

## What's inside

- **Map + queue** of curated leads; pins are **coloured by your verdict** (love = vivid
  green, would-view = light green, watch = yellow; passed homes are hidden). Pins that
  share a postcode fan out so none hides behind another.
- **Contributor switch** — react as Ralf or Hannah; each keeps their own verdict, and
  you see the other's take on every lead.
- **Add by link** — paste a Rightmove / OnTheMarket link; Nest pulls photos, floor plan,
  price, beds, **tenure + lease length**, precise location and area data automatically.
- **"Suggest homes that fit us"** — learns from your verdicts and adds top Rightmove
  matches; a daily auto-discover keeps the best ~20.
- **Area intelligence** — per-home price trend, transport/green/amenity/value scorecard,
  crime/flood signals and "worth a detour" spots, from live public data.
- **Search areas** — pick London postcode districts on the map; they drive discovery.
- **Price-drop alerts**, **commute times** (transit + cycle) to places you add, and a
  **weekly email** summary (Sunday ~8am) with an open subscribe/unsubscribe box.
- **The brief** card reflects your keepers live (price range, bed mix, areas you lean to).
- **Export tracker (CSV)** — one file with both partners' verdicts, tenure, lease, etc.

---

## How it's built

- `server.mjs` — Node HTTP server + API, backed by SQLite (local file) or **Turso** in
  production, selected by `TURSO_DATABASE_URL`. Also does all listing scraping, geocoding,
  discovery, commute/insight computation and the weekly email.
- `insights.mjs` — computes the live area-intelligence for a location.
- `index.html` / `app.js` / `styles.css` — the front-end, talking to `/api/*`.
- `districts.geojson` — London postcode-district boundaries for the map layer.
- `.github/workflows/` — cron jobs: daily auto-discover, and the Sunday weekly email.

External data (all server-side, mostly keyless): postcodes.io, HM Land Registry, TfL,
OpenStreetMap/Overpass, Police.uk, Environment Agency, and Rightmove/OnTheMarket pages.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/properties?person=Ralf` | leads + this person's saved verdicts |
| POST | `/api/properties` | add a home from `{url}` |
| DELETE | `/api/properties/:id` | remove a home |
| PUT | `/api/properties/:id/feedback` | save `{person, verdict, note}` |
| GET/PUT | `/api/settings` | search districts, commute destinations, email subscribers |
| POST | `/api/refresh` | re-check availability, media, price, tenure now |
| POST | `/api/discover` | taste-based discovery (add `?scheduled=1` for the daily cap) |
| POST | `/api/regeocode` | re-locate saved homes to their exact postcode |
| POST | `/api/send-weekly` | send the weekly summary to subscribers |
| GET | `/api/export.csv` | download the tracker |

---

## Deploying

See **[DEPLOY.md](DEPLOY.md)** — hosting on Render with a Turso database, so it's
shared, free, and your notes persist. A push to `main` auto-deploys.

## Notes & caveats

- Reading listing pages is against portal ToS — keep it gentle and personal; it can be
  blocked, and it degrades gracefully (features go quiet rather than break).
- Area scores are **derived indicators, not financial advice**.
- Nest shows only what a listing publishes (e.g. lease length is omitted when the agent
  doesn't state it) — it never invents missing facts.

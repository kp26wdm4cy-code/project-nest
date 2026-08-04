# Project Nest

A small, private, shared dashboard for Ralf & Hannah's first-home search.
Both partners react to the same curated leads; every verdict and note is saved
to a shared database so you each see the other's take.

## Run it locally

```powershell
npm install
npm start
```

Then open the address it prints (default <http://127.0.0.1:5181>). With no
environment variables set, it stores data in a local file at `data/nest.sqlite`.

## Put it online (shared, free)

See **[DEPLOY.md](DEPLOY.md)** — a step-by-step guide to hosting on Render with a
Turso database, so you and Hannah can use it from anywhere and your notes persist.

## What's inside

- **Map + queue** of curated leads with availability and price markers
- **Contributor switch** — react as Ralf or Hannah; each keeps their own verdict
- **Shared verdicts & notes** — you see the other person's reaction on every lead
- **Export tracker (CSV)** — one file for Excel with both partners' columns
- **Check listings now** — marks each link available / off-market / needs-check
- Automatic listing re-check every 12 hours while the server runs

## How it's built

- `server.mjs` — Node HTTP server + API, backed by SQLite (local file) or Turso
  (in production), selected by the `TURSO_DATABASE_URL` environment variable.
- `index.html` / `app.js` / `styles.css` — the front-end, talking to `/api/*`.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/properties?person=Ralf` | leads + this person's saved verdicts |
| PUT | `/api/properties/:id/feedback` | save `{person, verdict, note}` |
| GET | `/api/export.csv` | download the tracker |
| POST | `/api/refresh` | re-check listing availability now |

### Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | port to listen on (default 5181) |
| `TURSO_DATABASE_URL` | Turso database URL — if set, data lives in Turso |
| `TURSO_AUTH_TOKEN` | Turso auth token (with the URL above) |
| `DB_PATH` | override the local SQLite file path (local mode only) |
| `CHECK_INTERVAL_MS` | listing re-check interval (default 12h) |

The starting three listings are illustrative — replace them with real homes as
you find them (in the `seed()` list in `server.mjs`, or directly in the database).

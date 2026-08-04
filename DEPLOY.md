# Putting Nest online (free) — Render + Turso

Nest is a small Node app that stores your and Hannah's verdicts in a database.
Online, that database lives in **Turso** (free) and the app runs on **Render**
(free). Your notes are safe across updates because they live in Turso, not on
the Render server.

You do this **once**. After that, every `git push` redeploys automatically.

---

## Step 1 — Put the code on GitHub

In this folder (`C:\Users\rs\project-nest`), the git repo is already created and
committed. You just need to push it to a repo of your own.

1. Go to <https://github.com/new>, name it `project-nest`, keep it **Private**,
   and click **Create repository** (do **not** add a README — this folder has one).
2. Copy the two commands GitHub shows under *"…or push an existing repository"*.
   They look like this (replace `YOUR-USERNAME`):

   ```powershell
   git remote add origin https://github.com/YOUR-USERNAME/project-nest.git
   git push -u origin main
   ```

3. Run them in this folder. The first push opens a browser to sign in to GitHub —
   approve it. Done when the files appear on github.com.

---

## Step 2 — Create the Turso database (holds your data)

1. Go to <https://turso.tech> and **Sign up** (use *Continue with GitHub*).
2. Create a database — call it `nest`, pick the **London / LHR** region.
3. Open the database and find its **URL** — it looks like
   `libsql://nest-yourname.turso.io`. Copy it. → this is `TURSO_DATABASE_URL`.
4. Create a **token** for it (look for *Tokens* / *Create token*). Copy the long
   string. → this is `TURSO_AUTH_TOKEN`.

Keep both values handy for Step 3. (Prefer the command line? See the CLI box at
the bottom.)

---

## Step 3 — Run it on Render

1. Go to <https://render.com> and **Sign up with GitHub**.
2. Click **New → Web Service**, and **connect the `project-nest` repo**.
   Render reads `render.yaml`, so build/start settings fill in automatically.
3. Before the first deploy, open **Environment** and add the two secrets from
   Step 2:
   - `TURSO_DATABASE_URL` = the `libsql://…` URL
   - `TURSO_AUTH_TOKEN` = the token string
4. Click **Create Web Service / Deploy**. After a minute or two you get a public
   address like `https://project-nest.onrender.com`.

**Share that link with Hannah.** You both open it, switch to your own name at the
top right, and every verdict and note is saved for both of you.

---

## Everyday use

- **Change something** (add a flat, tweak wording): edit the file, then in this
  folder run `git add -A`, `git commit -m "update"`, `git push`. Render redeploys
  on its own.
- **Add real listings:** they live in the `seed()` list in `server.mjs`, or can be
  added straight into the Turso database later.
- **Note on the free tier:** Render sleeps the app after ~15 minutes idle, so the
  first visit after a quiet spell takes ~30 seconds to wake. Your data is never
  lost — it's in Turso.

---

## Prefer the Turso command line (optional)

```powershell
# install (needs scoop) then log in
scoop install turso
turso auth login
turso db create nest --location lhr
turso db show nest --url        # -> TURSO_DATABASE_URL
turso db tokens create nest     # -> TURSO_AUTH_TOKEN
```

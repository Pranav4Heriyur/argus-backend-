# Getting this in front of the organiser

Two separate things need to happen:

1. **Push the code to GitHub** — so they can see/pull it.
2. **Deploy it somewhere that runs Node.js** — so they can actually click around and test it live.

GitHub Pages only does step-adjacent hosting for plain HTML/CSS/JS. It cannot
run `server.js`, so login and every API call would fail if you relied on
Pages alone. Use **Render** instead (free, and it's a couple of clicks). Once
it's live, the *same* Render URL serves both the admin portal and the parent
app — you don't host them separately.

## 1. Push to GitHub (PowerShell)

```powershell
cd path\to\argus-backend
git init
git add .
git commit -m "Argus backend + admin portal + parent app"
```

Create an empty repo on github.com (don't add a README/gitignore there), then:

```powershell
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

`.gitignore` already excludes `node_modules/`, `.env`, and the `.sqlite`
database file, so none of that gets pushed — that's correct, don't undo it.

## 2. Deploy on Render

1. Go to https://render.com and sign up / log in (free, GitHub login works).
2. **New +** → **Blueprint** → connect the GitHub repo you just pushed.
   Render will read `render.yaml` (already included in this project) and
   pre-fill everything: build command, start command, and a random
   `JWT_SECRET`.
3. Click **Apply** / **Create**. First deploy takes 2-3 minutes.
4. When it's live, Render gives you a URL like
   `https://argus-backend-xxxx.onrender.com`.

No Blueprint option, or you'd rather click through manually? **New +** → **Web
Service** → connect the repo → set:
- **Build command:** `npm install && npm run seed`
- **Start command:** `npm start`
- **Environment variable:** `JWT_SECRET` = any long random string

## 3. Send the organiser these two links

- Admin portal: `https://<your-app>.onrender.com/admin.html`
- Parent app: `https://<your-app>.onrender.com/index.html`

Same demo logins as local testing (see README's "Seeded accounts" table) —
they print to the Render logs on every deploy too, if you need to double-check
a password.

## Notes / things to know

- **Free tier sleeps.** After ~15 minutes of no traffic, the app spins down
  and the first request after that takes 20-30 seconds to wake it up. Warn
  the organiser it might look "stuck" for a moment on their first click —
  it isn't broken, it's waking up.
- **Data resets on every deploy** with the `render.yaml` as configured
  (build command re-runs `npm run seed`). That's intentional here so every
  test session starts from the same clean demo data. If you want changes
  (accounts, marks, notices) to persist across deploys, edit `render.yaml`
  and drop the `npm run seed &&` part of the build command — but note the
  free tier's disk is still not permanent storage long-term (a full redeploy
  or host migration can still wipe it). For anything beyond a demo/testing
  period, plan to move to Postgres eventually, as the README's `db/db.js`
  comment already flags.
- **Forgot password emails:** with `SMTP_USER`/`SMTP_PASS` left blank (as in
  `render.yaml`), reset links go to a free Ethereal test inbox instead of a
  real email — the preview link is printed in the Render logs. That's fine
  for testing; fill in real Gmail App Password credentials later if you want
  actual emails to land in parents' inboxes.

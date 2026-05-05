# Spyne Bulk Media Downloader

Static web UI that calls `https://api.spyne.ai/medias/bulk-download` directly
from the browser. Designed to be hosted on GitHub Pages so anyone on the team
can use it without installing anything.

```
spyne_bulk_download_ui/
├── index.html        ← the UI
├── app.js            ← form logic + API call
├── styles.css        ← dark UI styling
├── sample.csv        ← example input
├── proxy/worker.js   ← optional Cloudflare Worker (only needed if CORS blocks)
└── README.md         ← this file
```

## What it does

1. User pastes their Spyne **auth token**, **enterprise ID**, **team ID** (and optionally **user ID**).
2. User uploads a **CSV** with media IDs (and optional VIN labels).
3. UI sends one POST to `api.spyne.ai/medias/bulk-download` with `isSequence: true`.
4. UI handles the response: opens a download URL if one is returned, or saves the binary blob if the API responds with a ZIP.

Credentials are stored in the browser's `localStorage` (per device, per browser) so users don't have to re-paste IDs every day. They will need to update the **auth token** every 5–6 days when Spyne expires it; the UI displays the token's age and warns when it's getting stale.

## Deploy on GitHub Pages

1. Create a new GitHub repo, e.g. `spyne-bulk-downloader`.
2. Push the contents of this folder to the repo's `main` branch.
3. Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder: `/ (root)` → Save.
4. After ~30 seconds the site is live at `https://<your-org>.github.io/spyne-bulk-downloader/`.

That's it for the happy path. **Read the next section before sharing the link** — there's a likely CORS hurdle.

## CORS reality check

Spyne's `api.spyne.ai` very probably restricts CORS to `Origin: https://console.spyne.ai`. If so, when your GitHub Pages site (origin = `*.github.io`) tries to call the API, the browser will block the response and you'll see a `Failed to fetch` / CORS error in the UI.

You have two options:

### Option A — Open it in `console.spyne.ai`'s context (no proxy needed)

Install a userscript manager (Tampermonkey / Violentmonkey) and add a small userscript that injects a button into Spyne's console pointing at your GitHub Pages site, opening it in an iframe under the `console.spyne.ai` origin. Lower friction but each user has to install the userscript.

### Option B — Tiny Cloudflare Worker proxy (recommended)

The Worker forwards your requests to Spyne, attaches the `Origin: https://console.spyne.ai` header that Spyne expects, and returns the response with permissive CORS so your GitHub Pages site can read it.

Setup is genuinely 5 minutes:

1. Sign in to https://workers.cloudflare.com (free tier is fine).
2. **Create application → Create Worker**, name it e.g. `spyne-bulk-proxy`.
3. Click **Edit code**, paste the contents of `proxy/worker.js`, click **Save and deploy**.
4. Copy the deployed Worker URL (looks like `https://spyne-bulk-proxy.<your-name>.workers.dev`).
5. In `app.js`, change:
   ```js
   const API_URL = "https://api.spyne.ai/medias/bulk-download";
   ```
   to your Worker URL:
   ```js
   const API_URL = "https://spyne-bulk-proxy.<your-name>.workers.dev";
   ```
6. Commit, push — GitHub Pages picks it up automatically.

If you want to lock the Worker down so only your GitHub Pages site can call it, edit `ALLOWED_ORIGINS` in `worker.js` to your specific origin and remove the `"*"`.

## How users find their credentials

Tell each teammate:

1. Sign in to `https://console.spyne.ai`.
2. Open DevTools (`Cmd+Opt+I` / `F12`) → **Network** tab.
3. Click any vehicle's row, or change a filter — anything that triggers a request to `api.spyne.ai`.
4. Click any of those API requests → **Headers** tab.
5. Copy:
   - `authorization:` value (a long JWT — drop the `Bearer ` prefix when pasting if you prefer, the UI handles either)
   - From the **request payload** or any URL: `enterpriseId`, `teamId`, `userId`.
6. Paste into the UI and start uploading CSVs.

The token is saved in their browser; they only re-paste when it expires (every 5–6 days — the UI shows the warning).

## CSV format

Upload a CSV with at least a media-ID column. The UI accepts these header names (case-insensitive):

- **Media ID column** — `Media ID`, `mediaId`, `media_id`, `mediaIds`, `media ids`
- **VIN column (optional)** — `VIN`, `Sku Name`, `Sku`, `vin name`

Example (also see `sample.csv`):

```csv
VIN,Media ID
1C4PJLCB4MD155207,abc123-media-id-1
1C4RDHAG7NC103119,def456-media-id-2
```

VIN values are used purely as labels in the status output; the API call only uses `Media ID`.

## Where do downloaded files go?

Whatever your browser's default Downloads folder is. The UI either:

- Opens the signed download URL Spyne returns (the browser saves it normally), or
- Saves the binary ZIP the API responds with directly.

## Troubleshooting

- **`401 Unauthorized`** — the auth token expired. Re-paste a fresh one from DevTools.
- **`403 Forbidden`** — wrong `enterpriseId` / `teamId` for this user, or the user doesn't have access.
- **`Failed to fetch` / CORS error** — see the *CORS reality check* above; deploy the Worker.
- **Empty / no download triggered** — the API returned JSON without a recognisable URL field. Open DevTools → Console, inspect the `Server response:` line, and tell us what shape the response has so we can extend the parser.
- **Downloads are huge / slow** — set `formatType: zip` (default) and `isSequence: true` so Spyne does one bundled download instead of N individual files.

## Why not VIN-based input?

Spyne's bulk-download API takes `mediaIds`, not VINs. The CSV-with-VIN-and-mediaId-columns format keeps the human-readable VIN visible in the UI status output while sending the correct identifier to the API. If your team only has VINs and not media IDs, you'll need a separate Spyne lookup endpoint — share that endpoint and we can add a VIN→mediaId resolver step before the bulk call.

## Roadmap-ish

- Per-row status (which media IDs in the batch succeeded vs failed) once Spyne's response shape is known.
- Optional VIN → media ID resolution (needs lookup API).
- Auto-refresh stale tokens via OAuth (only worth doing if someone's running a backend).

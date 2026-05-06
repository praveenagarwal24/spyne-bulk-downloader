/* Spyne Bulk Media Downloader — front-end logic.
 * Calls https://api.spyne.ai/medias/bulk-download directly from the browser.
 * If Spyne's CORS rejects the call (origin must be console.spyne.ai), the user
 * needs to deploy the optional proxy described in README.md.
 */

// Per-VIN POST endpoint: POST /medias/{mediaId}/download with userData + downloadRequestData.
// The body does NOT include mediaIds — the mediaId is in the URL path.
const PER_VIN_POST_URL = (mediaId) =>
  `https://api.spyne.ai/medias/${encodeURIComponent(mediaId)}/download`;

// Status / direct-download GET for a previously-issued request.
const PER_MEDIA_URL = (mediaId, requestId) =>
  `https://api.spyne.ai/medias/${encodeURIComponent(mediaId)}/download/${encodeURIComponent(requestId)}`;

const STORAGE_KEY = "spyne-bulk-downloader/v1";

// Wait between successive polling cycles while items are still pending.
// Starts short and backs off if Spyne stays "in_progress" for a while.
const POLL_INTERVALS_MS = [3_000, 5_000, 10_000, 15_000, 30_000];

// Hard ceiling on total polling time so the UI doesn't loop forever.
const POLL_MAX_MS = 15 * 60 * 1000; // 15 minutes

// Delay after a successful download trigger before moving to the next VIN.
// Gives the browser time to actually start saving the previous ZIP without
// triggering popup-blocker collisions.
const SEQUENTIAL_DOWNLOAD_DELAY_MS = 2_000;

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);

const els = {
  authToken: $("auth-token"),
  tokenMeta: $("token-meta"),
  enterpriseId: $("enterprise-id"),
  teamId: $("team-id"),
  userId: $("user-id"),
  csvFile: $("csv-file"),
  csvSummary: $("csv-summary"),
  downloadType: $("download-type"),
  formatType: $("format-type"),
  isSequence: $("is-sequence"),
  downloadProduct: $("download-product"),
  downloadBtn: $("download-btn"),
  refetchBtn: $("refetch-btn"),
  clearCredsBtn: $("clear-creds-btn"),
  outputCard: $("output-card"),
  output: $("output"),
};

let parsedRows = []; // [{mediaId, vin}]

// ---------- credential persistence ----------

function loadCreds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.authToken) els.authToken.value = data.authToken;
    if (data.enterpriseId) els.enterpriseId.value = data.enterpriseId;
    if (data.teamId) els.teamId.value = data.teamId;
    if (data.userId) els.userId.value = data.userId;
    if (data.tokenSavedAt) {
      const ageDays = (Date.now() - data.tokenSavedAt) / 86_400_000;
      const stamp = new Date(data.tokenSavedAt).toLocaleString();
      const warn = ageDays >= 5;
      els.tokenMeta.textContent =
        `Token saved ${ageDays.toFixed(1)} days ago (${stamp}).` +
        (warn ? " Spyne tokens typically expire after 5–6 days; if downloads fail with 401, paste a fresh one." : "");
      els.tokenMeta.style.color = warn ? "var(--warn)" : "";
    }
  } catch (e) {
    console.warn("Could not load saved credentials:", e);
  }
}

function saveCreds() {
  const data = {
    authToken: els.authToken.value.trim(),
    enterpriseId: els.enterpriseId.value.trim(),
    teamId: els.teamId.value.trim(),
    userId: els.userId.value.trim(),
    tokenSavedAt: Date.now(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("Could not save credentials:", e);
  }
}

function clearCreds() {
  localStorage.removeItem(STORAGE_KEY);
  els.authToken.value = "";
  els.enterpriseId.value = "";
  els.teamId.value = "";
  els.userId.value = "";
  els.tokenMeta.textContent = "";
  log("Cleared saved credentials.", "warn");
}

// ---------- CSV parsing ----------

/** Tiny CSV parser — handles quoted fields and commas inside quotes. */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") { /* skip */ }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c && c.trim() !== ""));
}

const MEDIA_ID_HEADERS = ["media id", "mediaid", "media_id", "mediaids", "media ids"];
const VIN_HEADERS = ["vin", "sku name", "sku", "vin name"];
const ENTERPRISE_ID_HEADERS = ["enterprise id", "enterpriseid", "enterprise_id", "enterprise"];
const TEAM_ID_HEADERS = ["team id", "teamid", "team_id", "team"];
const USER_ID_HEADERS = ["user id", "userid", "user_id", "user"];

function findHeaderIndex(headers, candidates) {
  const norm = (s) => s.toLowerCase().trim();
  for (let i = 0; i < headers.length; i++) {
    if (candidates.includes(norm(headers[i]))) return i;
  }
  return -1;
}

function loadCSVFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = parseCSV(reader.result);
      if (rows.length < 2) {
        log("CSV must have a header row and at least one data row.", "err");
        parsedRows = [];
        return;
      }
      const headers = rows[0];
      const mediaIdx = findHeaderIndex(headers, MEDIA_ID_HEADERS);
      const vinIdx = findHeaderIndex(headers, VIN_HEADERS);
      const eidIdx = findHeaderIndex(headers, ENTERPRISE_ID_HEADERS);
      const tidIdx = findHeaderIndex(headers, TEAM_ID_HEADERS);
      const uidIdx = findHeaderIndex(headers, USER_ID_HEADERS);
      if (mediaIdx === -1) {
        log(
          `CSV is missing a media-ID column. Expected one of: ${MEDIA_ID_HEADERS.join(", ")}. ` +
          `Found columns: ${headers.join(", ")}`,
          "err"
        );
        parsedRows = [];
        return;
      }
      const seen = new Set();
      parsedRows = [];
      for (let i = 1; i < rows.length; i++) {
        const m = (rows[i][mediaIdx] || "").trim();
        if (!m || seen.has(m)) continue;
        seen.add(m);
        parsedRows.push({
          mediaId: m,
          vin: vinIdx >= 0 ? (rows[i][vinIdx] || "").trim() : "",
          enterpriseId: eidIdx >= 0 ? (rows[i][eidIdx] || "").trim() : "",
          teamId: tidIdx >= 0 ? (rows[i][tidIdx] || "").trim() : "",
          userId: uidIdx >= 0 ? (rows[i][uidIdx] || "").trim() : "",
        });
      }
      // Auto-fill the credential form fields from the first row that supplies them,
      // so users who put creds in the CSV don't also have to paste them above.
      if (parsedRows.length) {
        const first = parsedRows[0];
        if (first.enterpriseId && !els.enterpriseId.value.trim()) els.enterpriseId.value = first.enterpriseId;
        if (first.teamId && !els.teamId.value.trim()) els.teamId.value = first.teamId;
        if (first.userId && !els.userId.value.trim()) els.userId.value = first.userId;
      }
      const extras = [];
      if (vinIdx >= 0) extras.push("VIN labels");
      if (eidIdx >= 0 || tidIdx >= 0 || uidIdx >= 0) extras.push("per-row credentials");
      els.csvSummary.textContent =
        `Loaded ${parsedRows.length} unique media ID${parsedRows.length === 1 ? "" : "s"} from ${file.name}` +
        (extras.length ? ` (with ${extras.join(" and ")}).` : ".");
    } catch (e) {
      log(`Failed to parse CSV: ${e.message}`, "err");
      parsedRows = [];
    }
  };
  reader.onerror = () => log("Could not read CSV file.", "err");
  reader.readAsText(file);
}

// ---------- output / logging ----------

function log(msg, kind = "info") {
  els.outputCard.hidden = false;
  const stamp = new Date().toLocaleTimeString();
  const cls = kind === "ok" ? "row-ok" : kind === "err" ? "row-err" : kind === "warn" ? "row-warn" : "";
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${stamp}] ${msg}`;
  els.output.appendChild(line);
  els.output.scrollTop = els.output.scrollHeight;
}

// ---------- API call ----------

function buildPayload(row) {
  // Per-VIN POST does not include mediaIds — the mediaId is in the URL path.
  // Each CSV row may override the form's credentials; otherwise we use the
  // values typed into section 1.
  const enterpriseId = (row?.enterpriseId || els.enterpriseId.value).trim();
  const userId = (row?.userId || els.userId.value).trim();
  const teamId = (row?.teamId || els.teamId.value).trim();
  return {
    userData: { enterpriseId, userId, teamId },
    downloadRequestData: {
      downloadType: els.downloadType.value,
      formatType: els.formatType.value,
      isSequence: els.isSequence.checked,
      downloadProduct: [els.downloadProduct.value],
    },
  };
}

function newRequestId() {
  // crypto.randomUUID is available in all modern browsers (Chrome 92+, Safari 15.4+, Firefox 95+).
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for older browsers.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function buildHeaders(token) {
  // Browsers won't let JS set Origin, Referer, or Sec-* headers — they're populated automatically.
  // X-Request-Id is required by Spyne's API; we generate a fresh UUID per call.
  return {
    accept: "application/json, text/plain, */*",
    authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    "content-type": "application/json",
    "x-request-id": newRequestId(),
  };
}

async function callPerVinPost(mediaId, payload, token) {
  const res = await fetch(PER_VIN_POST_URL(mediaId), {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(payload),
    mode: "cors",
  });
  return res;
}

/** Try to find a usable download URL anywhere in the API response. */
function extractDownloadUrl(json, preferredProduct) {
  const products = json?.data?.products || json?.products;
  if (products && typeof products === "object") {
    const orderedKeys = preferredProduct && products[preferredProduct]
      ? [preferredProduct, ...Object.keys(products).filter((k) => k !== preferredProduct)]
      : Object.keys(products);
    for (const key of orderedKeys) {
      const p = products[key] || {};
      const purl = p.url || p.downloadUrl || p.signedUrl;
      if (typeof purl === "string" && purl.startsWith("http")) return purl;
    }
  }
  return (
    json?.data?.downloadUrl ||
    json?.data?.url ||
    json?.data?.signedUrl ||
    json?.downloadUrl ||
    json?.url ||
    json?.signedUrl ||
    null
  );
}

/** Save a Blob to disk via a hidden <a download>. */
function saveBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

/** Sanitize a string for use as a filename. */
function safeFilename(name, fallback = "download") {
  const cleaned = String(name || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return cleaned || fallback;
}

/** Try to fetch this VIN's ZIP and add it to the master ZIP under {VIN}.zip.
 *  If the fetch fails (typically CORS on the S3 URL), fall back to opening the
 *  URL in a new tab so the browser saves it to the default Downloads folder.
 */
async function deliverDownload(url, row, label) {
  const entryName = `${safeFilename(row.vin || row.mediaId)}.zip`;
  if (masterZip) {
    try {
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      masterZip.file(entryName, blob);
      masterZipEntries++;
      log(`  ✓ ${label}: added ${entryName} (${(blob.size / 1024 / 1024).toFixed(2)} MB) to master ZIP.`, "ok");
      return;
    } catch (e) {
      log(
        `  Could not fetch ${entryName} for the master ZIP (${e.message}). ` +
        `Opening the URL directly so the browser saves it to your default Downloads folder…`,
        "warn"
      );
      // Fall through to window.open below.
    }
  }
  window.open(url, "_blank", "noopener");
  log(`  ✓ ${label}: download URL opened in a new tab.`, "ok");
}

/** Result codes for fetchPerMediaDownload(). */
const RESULT_DOWNLOADED = "downloaded";   // file saved or URL opened — done
const RESULT_PENDING = "pending";         // still preparing — retry later
const RESULT_FAILED = "failed";           // hard failure — don't retry

/** Hit the per-media GET endpoint and turn the response into a download.
 *  Returns one of RESULT_DOWNLOADED / RESULT_PENDING / RESULT_FAILED. */
async function fetchPerMediaDownload(row, requestId, token, { quiet = false } = {}) {
  const url = PER_MEDIA_URL(row.mediaId, requestId);
  const label = row.vin ? `${row.mediaId}  (VIN ${row.vin})` : row.mediaId;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
      "x-request-id": newRequestId(),
    },
    mode: "cors",
  });

  const ctype = (res.headers.get("content-type") || "").toLowerCase();

  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    // 404 right after POST often means "not yet available"; treat as pending.
    if (res.status === 404 || res.status === 425 || /not.?ready|in[\s_-]?progress/i.test(txt)) {
      if (!quiet) log(`  ⋯ ${label}: still preparing (HTTP ${res.status}). Will retry.`, "warn");
      return RESULT_PENDING;
    }
    log(`  ✗ ${label}: HTTP ${res.status} — ${txt.slice(0, 240)}`, "err");
    return RESULT_FAILED;
  }

  if (ctype.includes("application/json")) {
    const json = await res.json().catch(() => null);
    const overallStatus = (json?.data?.status || json?.status || "").toLowerCase();
    const products = json?.data?.products || json?.products;
    const PENDING_STATES = ["pending", "in_progress", "yet_to_start", "queued", "processing"];

    // Spyne's per-media GET response shape is:
    //   { data: { status: "COMPLETED", products: { CATALOG: { status: "COMPLETED", url: "https://..." } } } }
    // Hunt for the first product with a usable download URL.
    let downloadUrl = null;
    let anyProductPending = false;
    if (products && typeof products === "object") {
      // Prefer the product the user actually selected.
      const preferredKey = els.downloadProduct?.value;
      const orderedKeys = preferredKey && products[preferredKey]
        ? [preferredKey, ...Object.keys(products).filter((k) => k !== preferredKey)]
        : Object.keys(products);
      for (const key of orderedKeys) {
        const p = products[key] || {};
        const purl = p.url || p.downloadUrl || p.signedUrl;
        const pstatus = (p.status || "").toLowerCase();
        if (typeof purl === "string" && purl.startsWith("http")) {
          downloadUrl = purl;
          break;
        }
        if (PENDING_STATES.includes(pstatus)) anyProductPending = true;
      }
    }
    // Fallback to flat URL fields if products didn't yield one.
    if (!downloadUrl) {
      downloadUrl =
        json?.data?.downloadUrl ||
        json?.data?.url ||
        json?.data?.signedUrl ||
        json?.downloadUrl ||
        json?.url ||
        json?.signedUrl ||
        null;
    }

    if (typeof downloadUrl === "string" && downloadUrl.startsWith("http")) {
      await deliverDownload(downloadUrl, row, label);
      return RESULT_DOWNLOADED;
    }

    if (PENDING_STATES.includes(overallStatus) || anyProductPending) {
      if (!quiet) log(`  ⋯ ${label}: still preparing (${overallStatus || "in_progress"}). Will retry.`, "warn");
      return RESULT_PENDING;
    }

    // Completed but no URL — surface the response so we can extend the parser.
    log(`  ! ${label}: ${JSON.stringify(json).slice(0, 280)}`, "err");
    return RESULT_FAILED;
  }

  // Anything non-JSON we treat as the file itself.
  const blob = await res.blob();
  const ext = ctype.includes("zip") ? "zip" : "bin";
  const fname = `${safeFilename(row.vin || row.mediaId)}.${ext}`;
  if (downloadDirHandle) {
    try {
      const fh = await downloadDirHandle.getFileHandle(fname, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      log(`  ✓ ${label}: saved ${fname} (${(blob.size / 1024 / 1024).toFixed(2)} MB) to ${downloadDirHandle.name}/`, "ok");
      return RESULT_DOWNLOADED;
    } catch (e) {
      log(`  Folder save failed (${e.message}); using default Downloads folder.`, "warn");
    }
  }
  saveBlob(blob, fname);
  log(`  ✓ ${label}: saved ${fname} (${(blob.size / 1024 / 1024).toFixed(2)} MB) to default Downloads`, "ok");
  return RESULT_DOWNLOADED;
}

/** Poll a single VIN's per-media GET until its ZIP is ready, then trigger one
 *  download. Returns true on success, false on hard failure or timeout.
 */
async function pollAndDownloadOne(row, requestId, token, idx, total) {
  const label = row.vin ? `${row.mediaId} (VIN ${row.vin})` : row.mediaId;
  const prefix = `[${idx + 1}/${total}]`;

  const startMs = Date.now();
  let attempt = 0;
  let backoffIdx = 0;

  while (Date.now() - startMs < POLL_MAX_MS) {
    attempt++;

    if (attempt > 1) {
      const wait = POLL_INTERVALS_MS[Math.min(backoffIdx, POLL_INTERVALS_MS.length - 1)];
      const elapsed = Date.now() - startMs;
      log(`${prefix}   …still preparing (elapsed ${(elapsed / 1000).toFixed(0)}s). Waiting ${(wait / 1000).toFixed(0)}s.`);
      await new Promise((r) => setTimeout(r, wait));
    }

    let result;
    try {
      result = await fetchPerMediaDownload(row, requestId, token, { quiet: attempt > 1 });
    } catch (e) {
      log(`${prefix}   ✗ ${label}: ${e.message}`, "err");
      return false;
    }

    if (result === RESULT_DOWNLOADED) {
      const totalSec = ((Date.now() - startMs) / 1000).toFixed(1);
      log(`${prefix}   ✓ ${label}: triggered after ${totalSec}s.`, "ok");
      return true;
    }
    if (result === RESULT_FAILED) {
      log(`${prefix}   ✗ ${label}: hard failure — see response above.`, "err");
      return false;
    }
    backoffIdx++;
  }

  log(`${prefix}   ⏱  ${label}: ${(POLL_MAX_MS / 60000).toFixed(0)}-min polling cap hit, still pending.`, "warn");
  return false;
}

/** Process every VIN strictly sequentially: poll until that VIN's ZIP is ready,
 *  trigger its download, wait for the browser to start saving, then move to
 *  the next. This way the per-VIN images (sequenced inside each ZIP via
 *  `isSequence: true`) also arrive on disk in VIN order, one at a time.
 */
async function downloadEachMedia(rows, requestId, token) {
  if (!rows.length) return;

  log(
    `Sequential per-VIN download for request ID ${requestId} ` +
    `(${rows.length} VIN${rows.length === 1 ? "" : "s"} — one at a time, images in sequence inside each ZIP).`
  );

  const startMs = Date.now();
  let succeeded = 0, failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const label = row.vin ? `${row.mediaId} (VIN ${row.vin})` : row.mediaId;
    log(`[${i + 1}/${rows.length}] Starting ${label}…`);

    const ok = await pollAndDownloadOne(row, requestId, token, i, rows.length);
    if (ok) succeeded++; else failed++;

    // Pause after a successful trigger so the browser starts saving the ZIP
    // before we open the next tab. Skip this delay on the very last item.
    if (ok && i < rows.length - 1) {
      log(`  Waiting ${(SEQUENTIAL_DOWNLOAD_DELAY_MS / 1000).toFixed(1)}s before the next VIN…`);
      await new Promise((r) => setTimeout(r, SEQUENTIAL_DOWNLOAD_DELAY_MS));
    }
  }

  const totalSec = ((Date.now() - startMs) / 1000).toFixed(1);
  log(
    `Sequential downloads done in ${totalSec}s. Success=${succeeded}  Failure=${failed}`,
    failed ? "warn" : "ok"
  );
}

// Set after a successful run so the user can re-fetch downloads later
// (e.g., once the per-VIN jobs finish) without re-submitting.
let lastRows = [];
let lastRequestIdsByMedia = new Map(); // mediaId -> requestId

// Master ZIP being built during the current run (one entry per VIN).
let masterZip = null;
let masterZipEntries = 0;

/** Try to make a download happen from whatever shape the API responds with. */
async function handleResponse(res, token) {
  const ctype = (res.headers.get("content-type") || "").toLowerCase();

  if (ctype.includes("application/json")) {
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} — ${JSON.stringify(json) || res.statusText}`);
    }

    // 1) Inline download URL?
    const url =
      json?.downloadUrl ||
      json?.download_url ||
      json?.data?.downloadUrl ||
      json?.data?.download_url ||
      json?.url ||
      json?.signedUrl;
    if (typeof url === "string" && url.startsWith("http")) {
      log(`Triggering download: ${url}`, "ok");
      window.open(url, "_blank", "noopener");
      return;
    }

    // 2) Async accepted — extract requestId and trigger per-media GETs.
    const requestId =
      json?.data?.requestId ||
      json?.requestId ||
      json?.jobId ||
      json?.data?.jobId;
    const acceptedStatuses = ["in_progress", "yet_to_start", "queued", "pending", "processing"];
    const status = (json?.data?.status || json?.status || "").toLowerCase();

    if (requestId || acceptedStatuses.includes(status) ||
        (typeof json?.message === "string" && /accepted|in[\s_-]?progress/i.test(json.message))) {
      log(`Spyne accepted the request. ${json?.message || ""}`.trim(), "ok");
      if (requestId) log(`  Request ID: ${requestId}`, "ok");

      if (requestId) {
        lastRequestId = requestId;
        lastRows = parsedRows.slice();
        els.refetchBtn.hidden = false;
        // No arbitrary up-front delay — drive everything off the GET response status.
        await downloadEachMedia(parsedRows, requestId, token);
      } else {
        log(
          "Server didn't return a request ID, so per-media GETs aren't possible. " +
          "Spyne will deliver the ZIP via in-app notification or email when ready.",
          "warn"
        );
      }
      return;
    }

    // 3) Truly nothing actionable — dump the raw response.
    log(`Server response: ${JSON.stringify(json)}`, "warn");
    log("Request succeeded but the response shape isn't recognised. Share this with the developer to extend the parser.", "warn");
    return;
  }

  // Binary response — treat as the file itself.
  if (res.ok) {
    const blob = await res.blob();
    const name = (res.headers.get("content-disposition") || "").match(/filename="?([^"]+)"?/)?.[1] ||
                 `spyne-bulk-${Date.now()}.zip`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    log(`Downloaded ${name} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`, "ok");
    return;
  }

  const text = await res.text().catch(() => res.statusText);
  throw new Error(`HTTP ${res.status} — ${text}`);
}

// ---------- main flow ----------

async function onDownloadClick() {
  els.output.innerHTML = "";
  els.outputCard.hidden = false;

  const token = els.authToken.value.trim();
  if (!token) return log("Authorization token is required.", "err");
  if (!els.enterpriseId.value.trim()) return log("Enterprise ID is required.", "err");
  if (!els.teamId.value.trim()) return log("Team ID is required.", "err");
  if (!parsedRows.length) return log("Upload a CSV with at least one media ID.", "err");

  saveCreds();
  lastRows = parsedRows.slice();
  lastRequestIdsByMedia = new Map();

  // Build a master ZIP if JSZip is available. As each VIN's ZIP comes back,
  // we add it as an entry; at the end we generate one combined ZIP file and
  // trigger a single download.
  if (typeof JSZip === "function") {
    masterZip = new JSZip();
    masterZipEntries = 0;
  } else {
    masterZip = null;
    log("JSZip didn't load (CDN blocked?). Falling back to one tab per VIN.", "warn");
  }

  log(
    `Will process ${parsedRows.length} VIN${parsedRows.length === 1 ? "" : "s"} ` +
    `sequentially via POST /medias/{mediaId}/download` +
    (masterZip ? ` and bundle them into one master ZIP.` : `.`)
  );

  els.downloadBtn.disabled = true;
  els.refetchBtn.hidden = false;
  const startMs = Date.now();
  let succeeded = 0, failed = 0;

  try {
    for (let i = 0; i < parsedRows.length; i++) {
      const row = parsedRows[i];
      const label = row.vin ? `${row.mediaId} (VIN ${row.vin})` : row.mediaId;
      const tag = `[${i + 1}/${parsedRows.length}]`;
      log(`${tag} POST /medias/${row.mediaId}/download …`);

      try {
        const payload = buildPayload(row);
        const postRes = await callPerVinPost(row.mediaId, payload, token);

        if (!postRes.ok) {
          const text = await postRes.text().catch(() => postRes.statusText);
          log(`${tag}   ✗ POST HTTP ${postRes.status} — ${text.slice(0, 240)}`, "err");
          failed++;
        } else {
          const json = await postRes.json().catch(() => null);

          // Case A: POST is synchronous and already returns a download URL.
          const directUrl = extractDownloadUrl(json, els.downloadProduct.value);
          if (typeof directUrl === "string" && directUrl.startsWith("http")) {
            await deliverDownload(directUrl, row, label);
            succeeded++;
          } else {
            // Case B: POST is async — polling required via the GET endpoint.
            const requestId =
              json?.data?.requestId || json?.requestId || json?.jobId || json?.data?.jobId;
            if (!requestId) {
              log(`${tag}   ✗ ${label}: POST returned neither URL nor requestId. Body: ${JSON.stringify(json).slice(0, 240)}`, "err");
              failed++;
            } else {
              lastRequestIdsByMedia.set(row.mediaId, requestId);
              log(`${tag}   POST accepted (requestId ${requestId}). Polling status…`);
              const ok = await pollAndDownloadOne(row, requestId, token, i, parsedRows.length);
              if (ok) succeeded++; else failed++;
            }
          }
        }
      } catch (e) {
        if (e.message?.includes("Failed to fetch") || e.name === "TypeError") {
          log(`${tag}   ✗ Network/CORS error. See README → CORS proxy setup.`, "err");
        } else {
          log(`${tag}   ✗ ${e.message}`, "err");
        }
        failed++;
      }

      // Pause between VINs so the browser starts saving the previous ZIP first.
      if (i < parsedRows.length - 1) {
        log(`  Waiting ${(SEQUENTIAL_DOWNLOAD_DELAY_MS / 1000).toFixed(1)}s before next VIN…`);
        await new Promise((r) => setTimeout(r, SEQUENTIAL_DOWNLOAD_DELAY_MS));
      }
    }
  } finally {
    els.downloadBtn.disabled = false;
  }

  const totalSec = ((Date.now() - startMs) / 1000).toFixed(1);
  log(
    `All VINs processed in ${totalSec}s. Success=${succeeded}  Failure=${failed}`,
    failed ? "warn" : "ok"
  );

  // Finalize the master ZIP if any entries were collected.
  if (masterZip && masterZipEntries > 0) {
    log(`Building master ZIP with ${masterZipEntries} VIN${masterZipEntries === 1 ? "" : "s"}…`);
    try {
      const blob = await masterZip.generateAsync({ type: "blob", compression: "STORE" });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      saveBlob(blob, `spyne-downloads-${stamp}.zip`);
      log(`Master ZIP saved (${(blob.size / 1024 / 1024).toFixed(2)} MB).`, "ok");
    } catch (e) {
      log(`Could not build master ZIP: ${e.message}`, "err");
    }
  } else if (masterZip && masterZipEntries === 0) {
    log(
      "No VINs were added to the master ZIP — every fetch fell back to a tab. " +
      "If this happened due to CORS, you'll need a small Cloudflare Worker proxy (see README).",
      "warn"
    );
  }
  masterZip = null;
  masterZipEntries = 0;
}

// ---------- wire up ----------

async function onRefetchClick() {
  if (!lastRequestIdsByMedia.size || !lastRows.length) {
    log("No previous run to re-fetch. Click Download first.", "warn");
    return;
  }
  const token = els.authToken.value.trim();
  if (!token) return log("Authorization token is required.", "err");

  // Build a fresh master ZIP for this re-fetch run.
  if (typeof JSZip === "function") {
    masterZip = new JSZip();
    masterZipEntries = 0;
  } else {
    masterZip = null;
  }

  els.refetchBtn.disabled = true;
  const startMs = Date.now();
  let succeeded = 0, failed = 0;
  try {
    log(`Re-fetching ${lastRows.length} VIN${lastRows.length === 1 ? "" : "s"} using previously-saved request IDs…`);
    for (let i = 0; i < lastRows.length; i++) {
      const row = lastRows[i];
      const requestId = lastRequestIdsByMedia.get(row.mediaId);
      if (!requestId) {
        log(`[${i + 1}/${lastRows.length}]   ✗ No saved requestId for ${row.mediaId}; click Download to start fresh.`, "err");
        failed++;
        continue;
      }
      log(`[${i + 1}/${lastRows.length}] Re-checking ${row.mediaId}${row.vin ? ` (VIN ${row.vin})` : ""}…`);
      const ok = await pollAndDownloadOne(row, requestId, token, i, lastRows.length);
      if (ok) succeeded++; else failed++;
      if (i < lastRows.length - 1) {
        await new Promise((r) => setTimeout(r, SEQUENTIAL_DOWNLOAD_DELAY_MS));
      }
    }
  } finally {
    els.refetchBtn.disabled = false;
  }
  const totalSec = ((Date.now() - startMs) / 1000).toFixed(1);
  log(`Re-fetch done in ${totalSec}s. Success=${succeeded}  Failure=${failed}`, failed ? "warn" : "ok");

  if (masterZip && masterZipEntries > 0) {
    try {
      const blob = await masterZip.generateAsync({ type: "blob", compression: "STORE" });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      saveBlob(blob, `spyne-downloads-${stamp}.zip`);
      log(`Master ZIP saved with ${masterZipEntries} VIN(s) (${(blob.size / 1024 / 1024).toFixed(2)} MB).`, "ok");
    } catch (e) {
      log(`Could not build master ZIP: ${e.message}`, "err");
    }
  }
  masterZip = null;
  masterZipEntries = 0;
}

document.addEventListener("DOMContentLoaded", () => {
  loadCreds();
  els.csvFile.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) loadCSVFile(f);
  });
  els.downloadBtn.addEventListener("click", onDownloadClick);
  if (els.refetchBtn) els.refetchBtn.addEventListener("click", onRefetchClick);
  els.clearCredsBtn.addEventListener("click", clearCreds);
});

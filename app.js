/* Spyne Bulk Media Downloader — front-end logic.
 * Calls https://api.spyne.ai/medias/bulk-download directly from the browser.
 * If Spyne's CORS rejects the call (origin must be console.spyne.ai), the user
 * needs to deploy the optional proxy described in README.md.
 */

const API_URL = "https://api.spyne.ai/medias/bulk-download";
const PER_MEDIA_URL = (mediaId, requestId) =>
  `https://api.spyne.ai/medias/${encodeURIComponent(mediaId)}/download/${encodeURIComponent(requestId)}`;
const STORAGE_KEY = "spyne-bulk-downloader/v1";

// Delay between per-media GETs so we don't hammer the server.
const PER_MEDIA_DELAY_MS = 600;
// Initial wait after POST before starting per-media GETs (lets the bulk job kick off).
const POST_TO_GET_DELAY_MS = 1500;

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
        });
      }
      els.csvSummary.textContent =
        `Loaded ${parsedRows.length} unique media ID${parsedRows.length === 1 ? "" : "s"} from ${file.name}` +
        (vinIdx >= 0 ? " (with VIN labels)." : ".");
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

function buildPayload(mediaIds) {
  return {
    userData: {
      enterpriseId: els.enterpriseId.value.trim(),
      userId: els.userId.value.trim(),
      teamId: els.teamId.value.trim(),
    },
    downloadRequestData: {
      downloadType: els.downloadType.value,
      formatType: els.formatType.value,
      isSequence: els.isSequence.checked,
      downloadProduct: [els.downloadProduct.value],
    },
    mediaIds,
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

async function callBulkDownload(payload, token) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(payload),
    mode: "cors",
  });
  return res;
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

/** Hit the per-media GET endpoint and turn the response into a download. */
async function fetchPerMediaDownload(row, requestId, token) {
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
    log(`  ✗ ${label}: HTTP ${res.status} — ${txt.slice(0, 240)}`, "err");
    return false;
  }

  if (ctype.includes("application/json")) {
    const json = await res.json().catch(() => null);
    const downloadUrl =
      json?.data?.downloadUrl ||
      json?.data?.url ||
      json?.data?.signedUrl ||
      json?.downloadUrl ||
      json?.url ||
      json?.signedUrl;
    const status = (json?.data?.status || json?.status || "").toLowerCase();

    if (typeof downloadUrl === "string" && downloadUrl.startsWith("http")) {
      window.open(downloadUrl, "_blank", "noopener");
      log(`  ✓ ${label}: download URL opened`, "ok");
      return true;
    }
    if (["pending", "in_progress", "yet_to_start", "queued", "processing"].includes(status)) {
      log(`  ⋯ ${label}: still preparing (${status}). Try the "Re-fetch downloads" button in a minute.`, "warn");
      return false;
    }
    log(`  ? ${label}: ${JSON.stringify(json).slice(0, 240)}`, "warn");
    return false;
  }

  // Anything non-JSON we treat as the file itself.
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") || "";
  const fnameMatch = cd.match(/filename="?([^"]+)"?/i);
  const fname =
    fnameMatch?.[1] ||
    `${row.vin || row.mediaId}-${Date.now()}.${ctype.includes("zip") ? "zip" : "bin"}`;
  saveBlob(blob, fname);
  log(`  ✓ ${label}: saved ${fname} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`, "ok");
  return true;
}

/** Iterate through each mediaId and hit the per-media download endpoint. */
async function downloadEachMedia(rows, requestId, token) {
  log(`Fetching per-media downloads (request ID ${requestId})…`);
  let ok = 0, fail = 0;
  for (const row of rows) {
    try {
      const success = await fetchPerMediaDownload(row, requestId, token);
      success ? ok++ : fail++;
    } catch (e) {
      const label = row.vin ? `${row.mediaId} (VIN ${row.vin})` : row.mediaId;
      log(`  ✗ ${label}: ${e.message}`, "err");
      fail++;
    }
    // Small delay so we don't trigger rate-limiting / popup-blocker collisions.
    await new Promise((r) => setTimeout(r, PER_MEDIA_DELAY_MS));
  }
  log(`Per-media downloads done. Success=${ok}  Failure=${fail}`, fail ? "warn" : "ok");
}

// Set after a successful POST so the user can re-fetch downloads later
// (e.g., once the bulk job finishes processing) without re-submitting.
let lastRequestId = null;
let lastRows = [];

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
        log(`Waiting ${POST_TO_GET_DELAY_MS} ms, then fetching per-media downloads…`);
        await new Promise((r) => setTimeout(r, POST_TO_GET_DELAY_MS));
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

  log(`Submitting ${parsedRows.length} media ID(s) to Spyne…`);
  if (parsedRows.length <= 20) {
    parsedRows.forEach((r) =>
      log(`  • ${r.mediaId}${r.vin ? `  (VIN ${r.vin})` : ""}`)
    );
  }

  els.downloadBtn.disabled = true;
  try {
    const payload = buildPayload(parsedRows.map((r) => r.mediaId));
    const res = await callBulkDownload(payload, token);
    await handleResponse(res, token);
  } catch (e) {
    if (e.message?.includes("Failed to fetch") || e.name === "TypeError") {
      log(
        "Network/CORS error. Most likely Spyne's API rejected the cross-origin call. " +
        "See README.md → 'CORS proxy setup' for the 5-minute Cloudflare Worker fix.",
        "err"
      );
    } else {
      log(`Error: ${e.message}`, "err");
    }
    console.error(e);
  } finally {
    els.downloadBtn.disabled = false;
  }
}

// ---------- wire up ----------

async function onRefetchClick() {
  if (!lastRequestId || !lastRows.length) {
    log("No previous request to re-fetch. Click Download first.", "warn");
    return;
  }
  const token = els.authToken.value.trim();
  if (!token) return log("Authorization token is required.", "err");
  els.refetchBtn.disabled = true;
  try {
    log(`Re-fetching downloads for request ID ${lastRequestId}…`);
    await downloadEachMedia(lastRows, lastRequestId, token);
  } finally {
    els.refetchBtn.disabled = false;
  }
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

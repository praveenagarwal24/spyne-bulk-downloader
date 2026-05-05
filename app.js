/* Spyne Bulk Media Downloader — front-end logic.
 * Calls https://api.spyne.ai/medias/bulk-download directly from the browser.
 * If Spyne's CORS rejects the call (origin must be console.spyne.ai), the user
 * needs to deploy the optional proxy described in README.md.
 */

const API_URL = "https://api.spyne.ai/medias/bulk-download";
const STORAGE_KEY = "spyne-bulk-downloader/v1";

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

function buildHeaders(token) {
  // Browsers won't let JS set Origin, Referer, or Sec-* headers — they're populated automatically.
  return {
    accept: "application/json, text/plain, */*",
    authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    "content-type": "application/json",
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

/** Try to make a download happen from whatever shape the API responds with. */
async function handleResponse(res) {
  const ctype = (res.headers.get("content-type") || "").toLowerCase();

  if (ctype.includes("application/json")) {
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} — ${JSON.stringify(json) || res.statusText}`);
    }
    log(`Server response: ${JSON.stringify(json)}`, "ok");

    // Common patterns for download URLs in JSON responses.
    const url =
      json?.downloadUrl ||
      json?.download_url ||
      json?.data?.downloadUrl ||
      json?.data?.download_url ||
      json?.url ||
      json?.signedUrl;
    if (typeof url === "string" && url.startsWith("http")) {
      log(`Triggering download: ${url}`, "ok");
      // Open in a new tab so the browser can handle the binary.
      window.open(url, "_blank", "noopener");
      return;
    }

    if (json?.jobId || json?.requestId) {
      log(
        "API accepted the request asynchronously. Spyne typically emails the ZIP link " +
        "when ready, or you can refresh the inventory page to see it appear in the " +
        "downloads notification.",
        "ok"
      );
      return;
    }

    log("Request succeeded but no download URL was found in the response.", "warn");
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
    await handleResponse(res);
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

document.addEventListener("DOMContentLoaded", () => {
  loadCreds();
  els.csvFile.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) loadCSVFile(f);
  });
  els.downloadBtn.addEventListener("click", onDownloadClick);
  els.clearCredsBtn.addEventListener("click", clearCreds);
});

/* Spyne Bulk Media Downloader — front-end logic.
 * Calls https://api.spyne.ai/medias/{mediaId}/download per VIN.
 * Enterprise ID, Team ID, and User ID are read exclusively from the CSV.
 * All VINs are collected into one master ZIP for a single download trigger.
 *
 * If Spyne's CORS rejects the call (origin must be console.spyne.ai), deploy
 * the optional proxy described in README.md.
 */

// Per-VIN POST endpoint: POST /medias/{mediaId}/download
const PER_VIN_POST_URL = (mediaId) =>
  `https://api.spyne.ai/medias/${encodeURIComponent(mediaId)}/download`;

// Status / direct-download GET for a previously-issued request.
const PER_MEDIA_URL = (mediaId, requestId) =>
  `https://api.spyne.ai/medias/${encodeURIComponent(mediaId)}/download/${encodeURIComponent(requestId)}`;

const STORAGE_KEY = "spyne-bulk-downloader/v2";

// Polling back-off intervals (ms).
const POLL_INTERVALS_MS = [3_000, 5_000, 10_000, 15_000, 30_000];
const POLL_MAX_MS = 15 * 60 * 1000; // 15 minutes hard cap

// Brief pause between VINs so the browser breathes between fetch calls.
const SEQUENTIAL_DELAY_MS = 1_000;

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);

const els = {
  authToken: $("auth-token"),
  tokenMeta: $("token-meta"),
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

// [{mediaId, vin, enterpriseId, teamId, userId}]
let parsedRows = [];

// ---------- credential persistence (token only) ----------

function loadCreds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.authToken) els.authToken.value = data.authToken;
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      authToken: els.authToken.value.trim(),
      tokenSavedAt: Date.now(),
    }));
  } catch (e) {
    console.warn("Could not save credentials:", e);
  }
}

function clearCreds() {
  localStorage.removeItem(STORAGE_KEY);
  els.authToken.value = "";
  els.tokenMeta.textContent = "";
  log("Cleared saved token.", "warn");
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

const MEDIA_ID_HEADERS     = ["media id", "mediaid", "media_id", "mediaids", "media ids"];
const VIN_HEADERS          = ["vin", "sku name", "sku", "vin name"];
const ENTERPRISE_ID_HEADERS = ["enterprise id", "enterpriseid", "enterprise_id", "enterprise"];
const TEAM_ID_HEADERS      = ["team id", "teamid", "team_id", "team"];
const USER_ID_HEADERS      = ["user id", "userid", "user_id", "user"];

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
      const vinIdx   = findHeaderIndex(headers, VIN_HEADERS);
      const eidIdx   = findHeaderIndex(headers, ENTERPRISE_ID_HEADERS);
      const tidIdx   = findHeaderIndex(headers, TEAM_ID_HEADERS);
      const uidIdx   = findHeaderIndex(headers, USER_ID_HEADERS);

      // Media ID column is required.
      if (mediaIdx === -1) {
        log(
          `CSV is missing a Media ID column. Expected one of: ${MEDIA_ID_HEADERS.join(", ")}. ` +
          `Found: ${headers.join(", ")}`,
          "err"
        );
        parsedRows = [];
        return;
      }

      // Enterprise ID and Team ID columns are required.
      if (eidIdx === -1) {
        log(
          `CSV is missing an Enterprise ID column. Expected one of: ${ENTERPRISE_ID_HEADERS.join(", ")}. ` +
          `Found: ${headers.join(", ")}`,
          "err"
        );
        parsedRows = [];
        return;
      }
      if (tidIdx === -1) {
        log(
          `CSV is missing a Team ID column. Expected one of: ${TEAM_ID_HEADERS.join(", ")}. ` +
          `Found: ${headers.join(", ")}`,
          "err"
        );
        parsedRows = [];
        return;
      }

      const seen = new Set();
      parsedRows = [];
      const missingCreds = [];

      for (let i = 1; i < rows.length; i++) {
        const m  = (rows[i][mediaIdx] || "").trim();
        if (!m || seen.has(m)) continue;
        seen.add(m);

        const enterpriseId = (rows[i][eidIdx] || "").trim();
        const teamId       = (rows[i][tidIdx] || "").trim();
        const userId       = uidIdx >= 0 ? (rows[i][uidIdx] || "").trim() : "";

        if (!enterpriseId || !teamId) {
          missingCreds.push(`row ${i + 1} (${m})`);
        }

        parsedRows.push({
          mediaId: m,
          vin: vinIdx >= 0 ? (rows[i][vinIdx] || "").trim() : "",
          enterpriseId,
          teamId,
          userId,
        });
      }

      if (missingCreds.length) {
        log(
          `Warning: ${missingCreds.length} row(s) are missing Enterprise ID or Team ID: ` +
          missingCreds.slice(0, 5).join(", ") +
          (missingCreds.length > 5 ? ` … and ${missingCreds.length - 5} more.` : "."),
          "warn"
        );
      }

      const extras = [];
      if (vinIdx >= 0) extras.push("VIN labels");
      if (uidIdx >= 0) extras.push("User ID");

      els.csvSummary.textContent =
        `Loaded ${parsedRows.length} unique media ID${parsedRows.length === 1 ? "" : "s"} from ${file.name}` +
        (extras.length ? ` (with ${extras.join(" and ")}).` : ".");

      log(
        `CSV parsed: ${parsedRows.length} rows — credentials read from CSV columns.`,
        missingCreds.length ? "warn" : "ok"
      );
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

// ---------- API helpers ----------

function buildPayload(row) {
  return {
    userData: {
      enterpriseId: row.enterpriseId,
      teamId: row.teamId,
      userId: row.userId || "",
    },
    downloadRequestData: {
      downloadType: els.downloadType.value,
      formatType: els.formatType.value,
      isSequence: els.isSequence.checked,
      downloadProduct: [els.downloadProduct.value],
    },
  };
}

function newRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function buildHeaders(token) {
  return {
    accept: "application/json, text/plain, */*",
    authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    "content-type": "application/json",
    "x-request-id": newRequestId(),
  };
}

async function callPerVinPost(mediaId, payload, token) {
  return fetch(PER_VIN_POST_URL(mediaId), {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(payload),
    mode: "cors",
  });
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

/** Sanitize a string for use as a filename/folder-name entry. */
function safeFilename(name, fallback = "download") {
  const cleaned = String(name || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return cleaned || fallback;
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

// ---------- master ZIP ----------

// One JSZip instance is reused across the whole run.  Each VIN's ZIP blob is
// added as an entry; when everything is done we generate one combined download.
let masterZip = null;
let masterZipEntries = 0;

/** Fetch a signed URL and add the blob to masterZip under "{VIN}.zip".
 *  Falls back to window.open() if the fetch is blocked by CORS on the S3 URL.
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
        `  Could not fetch ${entryName} for master ZIP (${e.message}). ` +
        `Opening URL directly — browser will save it to your default Downloads folder.`,
        "warn"
      );
    }
  }
  window.open(url, "_blank", "noopener");
  log(`  ✓ ${label}: download URL opened in a new tab.`, "ok");
}

// ---------- per-VIN polling ----------

const RESULT_DOWNLOADED = "downloaded";
const RESULT_PENDING    = "pending";
const RESULT_FAILED     = "failed";

async function fetchPerMediaDownload(row, requestId, token, { quiet = false } = {}) {
  const url   = PER_MEDIA_URL(row.mediaId, requestId);
  const label = row.vin ? `${row.mediaId} (VIN ${row.vin})` : row.mediaId;

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

    let downloadUrl = null;
    let anyProductPending = false;
    if (products && typeof products === "object") {
      const preferredKey = els.downloadProduct?.value;
      const orderedKeys = preferredKey && products[preferredKey]
        ? [preferredKey, ...Object.keys(products).filter((k) => k !== preferredKey)]
        : Object.keys(products);
      for (const key of orderedKeys) {
        const p = products[key] || {};
        const purl = p.url || p.downloadUrl || p.signedUrl;
        if (typeof purl === "string" && purl.startsWith("http")) { downloadUrl = purl; break; }
        if (PENDING_STATES.includes((p.status || "").toLowerCase())) anyProductPending = true;
      }
    }
    if (!downloadUrl) {
      downloadUrl =
        json?.data?.downloadUrl || json?.data?.url || json?.data?.signedUrl ||
        json?.downloadUrl || json?.url || json?.signedUrl || null;
    }

    if (typeof downloadUrl === "string" && downloadUrl.startsWith("http")) {
      await deliverDownload(downloadUrl, row, label);
      return RESULT_DOWNLOADED;
    }
    if (PENDING_STATES.includes(overallStatus) || anyProductPending) {
      if (!quiet) log(`  ⋯ ${label}: still preparing (${overallStatus || "in_progress"}). Will retry.`, "warn");
      return RESULT_PENDING;
    }
    log(`  ! ${label}: unrecognised response shape — ${JSON.stringify(json).slice(0, 280)}`, "err");
    return RESULT_FAILED;
  }

  // Binary response — treat as the file itself.
  const blob = await res.blob();
  const ext  = ctype.includes("zip") ? "zip" : "bin";
  const fname = `${safeFilename(row.vin || row.mediaId)}.${ext}`;
  if (masterZip) {
    masterZip.file(fname, blob);
    masterZipEntries++;
    log(`  ✓ ${label}: added ${fname} (${(blob.size / 1024 / 1024).toFixed(2)} MB) to master ZIP.`, "ok");
  } else {
    saveBlob(blob, fname);
    log(`  ✓ ${label}: saved ${fname} (${(blob.size / 1024 / 1024).toFixed(2)} MB).`, "ok");
  }
  return RESULT_DOWNLOADED;
}

async function pollAndDownloadOne(row, requestId, token, idx, total) {
  const label  = row.vin ? `${row.mediaId} (VIN ${row.vin})` : row.mediaId;
  const prefix = `[${idx + 1}/${total}]`;
  const startMs = Date.now();
  let attempt = 0, backoffIdx = 0;

  while (Date.now() - startMs < POLL_MAX_MS) {
    attempt++;
    if (attempt > 1) {
      const wait = POLL_INTERVALS_MS[Math.min(backoffIdx, POLL_INTERVALS_MS.length - 1)];
      log(`${prefix}   …still preparing (${((Date.now() - startMs) / 1000).toFixed(0)}s elapsed). Waiting ${(wait / 1000).toFixed(0)}s.`);
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
      log(`${prefix}   ✓ ${label}: done after ${((Date.now() - startMs) / 1000).toFixed(1)}s.`, "ok");
      return true;
    }
    if (result === RESULT_FAILED) {
      log(`${prefix}   ✗ ${label}: hard failure — see above.`, "err");
      return false;
    }
    backoffIdx++;
  }

  log(`${prefix}   ⏱  ${label}: ${(POLL_MAX_MS / 60000).toFixed(0)}-min cap hit, still pending.`, "warn");
  return false;
}

// ---------- state for re-fetch ----------

let lastRows = [];
let lastRequestIdsByMedia = new Map();

// ---------- finalize master ZIP ----------

async function finalizeMasterZip(label = "") {
  if (!masterZip || masterZipEntries === 0) {
    if (masterZip) {
      log(
        "No VINs were added to the master ZIP — every fetch fell back to a tab. " +
        "If this is CORS-related, deploy the Cloudflare Worker proxy (see README).",
        "warn"
      );
    }
    masterZip = null;
    masterZipEntries = 0;
    return;
  }

  log(`Building master ZIP with ${masterZipEntries} VIN${masterZipEntries === 1 ? "" : "s"}…`);
  try {
    const blob = await masterZip.generateAsync({ type: "blob", compression: "STORE" });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `spyne-downloads-${stamp}.zip`;
    saveBlob(blob, filename);
    log(`✓ Master ZIP saved: ${filename} (${(blob.size / 1024 / 1024).toFixed(2)} MB).${label}`, "ok");
  } catch (e) {
    log(`Could not build master ZIP: ${e.message}`, "err");
  }
  masterZip = null;
  masterZipEntries = 0;
}

// ---------- main download flow ----------

async function onDownloadClick() {
  els.output.innerHTML = "";
  els.outputCard.hidden = false;

  const token = els.authToken.value.trim();
  if (!token) return log("Authorization token is required.", "err");
  if (!parsedRows.length) return log("Upload a CSV with at least one media ID.", "err");

  // Validate that every row has credentials.
  const badRows = parsedRows.filter((r) => !r.enterpriseId || !r.teamId);
  if (badRows.length) {
    return log(
      `${badRows.length} row(s) are missing Enterprise ID or Team ID. ` +
      `Please fix the CSV and re-upload.`,
      "err"
    );
  }

  saveCreds();
  lastRows = parsedRows.slice();
  lastRequestIdsByMedia = new Map();

  if (typeof JSZip === "function") {
    masterZip = new JSZip();
    masterZipEntries = 0;
  } else {
    masterZip = null;
    log("JSZip didn't load (CDN blocked?). Falling back to one tab per VIN.", "warn");
  }

  log(
    `Processing ${parsedRows.length} VIN${parsedRows.length === 1 ? "" : "s"} ` +
    `sequentially` +
    (masterZip ? ` — will bundle all into one master ZIP.` : `.`)
  );

  els.downloadBtn.disabled = true;
  els.refetchBtn.hidden = false;
  const startMs = Date.now();
  let succeeded = 0, failed = 0;

  try {
    for (let i = 0; i < parsedRows.length; i++) {
      const row   = parsedRows[i];
      const label = row.vin ? `${row.mediaId} (VIN ${row.vin})` : row.mediaId;
      const tag   = `[${i + 1}/${parsedRows.length}]`;
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
          const directUrl = extractDownloadUrl(json, els.downloadProduct.value);

          if (typeof directUrl === "string" && directUrl.startsWith("http")) {
            await deliverDownload(directUrl, row, label);
            succeeded++;
          } else {
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

      if (i < parsedRows.length - 1) {
        await new Promise((r) => setTimeout(r, SEQUENTIAL_DELAY_MS));
      }
    }
  } finally {
    els.downloadBtn.disabled = false;
  }

  const totalSec = ((Date.now() - startMs) / 1000).toFixed(1);
  log(
    `All VINs processed in ${totalSec}s — Success: ${succeeded}  Failed: ${failed}`,
    failed ? "warn" : "ok"
  );

  await finalizeMasterZip(` Contains ${succeeded} VIN${succeeded === 1 ? "" : "s"}.`);
}

// ---------- re-fetch flow ----------

async function onRefetchClick() {
  if (!lastRequestIdsByMedia.size || !lastRows.length) {
    log("No previous run to re-fetch. Click Download first.", "warn");
    return;
  }
  const token = els.authToken.value.trim();
  if (!token) return log("Authorization token is required.", "err");

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
    log(`Re-fetching ${lastRows.length} VIN${lastRows.length === 1 ? "" : "s"} using saved request IDs…`);
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
        await new Promise((r) => setTimeout(r, SEQUENTIAL_DELAY_MS));
      }
    }
  } finally {
    els.refetchBtn.disabled = false;
  }

  const totalSec = ((Date.now() - startMs) / 1000).toFixed(1);
  log(`Re-fetch done in ${totalSec}s — Success: ${succeeded}  Failed: ${failed}`, failed ? "warn" : "ok");

  await finalizeMasterZip(` Contains ${succeeded} VIN${succeeded === 1 ? "" : "s"}.`);
}

// ---------- wire up ----------

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

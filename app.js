/* Spyne Bulk Media Downloader — front-end logic.
 *
 * DOWNLOAD MODES (selected automatically based on what you've configured):
 *
 *  FOLDER mode  — folder picked → each VIN's images extracted into  folder/enterpriseId/teamId/VIN/
 *  ZIP mode     — proxy URL set, no folder → all VINs bundled into one master ZIP download
 *  TAB mode     — neither set → each VIN opens in a new browser tab
 *
 * The proxy URL is always needed to fetch blobs (S3 CORS blocks direct browser requests).
 * The folder picker controls WHERE the fetched blobs land.
 */

const STORAGE_KEY         = "spyne-bulk-downloader/v3";
const POLL_INTERVALS_MS   = [1_000, 3_000, 5_000, 10_000, 15_000, 30_000];
const POLL_MAX_MS         = 15 * 60 * 1000;
const DEFAULT_CONCURRENCY = 5;

const $ = (id) => document.getElementById(id);

// Grab all UI elements once at startup
const els = {
  authToken:         $("auth-token"),
  tokenMeta:         $("token-meta"),
  proxyUrl:          $("proxy-url"),
  concurrency:       $("concurrency"),
  csvFile:           $("csv-file"),
  csvSummary:        $("csv-summary"),
  downloadType:      $("download-type"),
  formatType:        $("format-type"),
  isSequence:        $("is-sequence"),
  downloadProduct:   $("download-product"),
  downloadBtn:       $("download-btn"),
  refetchBtn:        $("refetch-btn"),
  clearCredsBtn:     $("clear-creds-btn"),
  pickFolderBtn:     $("pick-folder-btn"),
  folderStatus:      $("folder-status"),
  folderUnsupported: $("folder-unsupported"),
  outputCard:        $("output-card"),
  output:            $("output"),
  progressBar:       $("progress-bar"),
  progressText:      $("progress-text"),
  progressWrap:      $("progress-wrap"),
};

// Global state
let parsedRows        = [];   // rows parsed from CSV
let downloadDirHandle = null; // FileSystemDirectoryHandle when folder picker used
let masterZip         = null; // JSZip instance for ZIP mode
let masterZipEntries  = 0;
let zipMutex          = Promise.resolve();
let lastRows          = [];
let lastRequestIdsByMedia = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Config helpers
// ─────────────────────────────────────────────────────────────────────────────

function proxyBase() {
  return (els.proxyUrl?.value || "").trim().replace(/\/$/, "");
}

function getConcurrency() {
  const v = parseInt(els.concurrency?.value, 10);
  return (!isNaN(v) && v >= 1 && v <= 20) ? v : DEFAULT_CONCURRENCY;
}

// Use proxy for API calls if proxy URL is set, otherwise call Spyne directly
function perVinPostUrl(mediaId) {
  const b = proxyBase();
  return b ? `${b}/medias/${encodeURIComponent(mediaId)}/download`
           : `https://api.spyne.ai/medias/${encodeURIComponent(mediaId)}/download`;
}
function perMediaGetUrl(mediaId, requestId) {
  const b = proxyBase();
  return b ? `${b}/medias/${encodeURIComponent(mediaId)}/download/${encodeURIComponent(requestId)}`
           : `https://api.spyne.ai/medias/${encodeURIComponent(mediaId)}/download/${encodeURIComponent(requestId)}`;
}
function fetchUrlProxyEndpoint() {
  const b = proxyBase();
  return b ? `${b}/fetch-url` : null;
}

// Which mode are we in right now?
function getMode() {
  if (downloadDirHandle) return "FOLDER";   // folder picked → save there
  if (proxyBase())       return "ZIP";      // proxy set, no folder → master ZIP
  return "TAB";                             // nothing set → open tabs
}

// ─────────────────────────────────────────────────────────────────────────────
// Credentials (localStorage)
// ─────────────────────────────────────────────────────────────────────────────

function loadCreds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.authToken && els.authToken) els.authToken.value = d.authToken;
    if (d.proxyUrl  && els.proxyUrl)  els.proxyUrl.value  = d.proxyUrl;
    if (d.tokenSavedAt) {
      const ageDays = (Date.now() - d.tokenSavedAt) / 86_400_000;
      const warn    = ageDays >= 5;
      els.tokenMeta.textContent =
        `Token saved ${ageDays.toFixed(1)} days ago (${new Date(d.tokenSavedAt).toLocaleString()}).` +
        (warn ? " May be expired — paste a fresh one if you see 401 errors." : "");
      els.tokenMeta.style.color = warn ? "var(--warn)" : "";
    }
  } catch (e) { console.warn("loadCreds:", e); }
}

function saveCreds() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      authToken:    els.authToken.value.trim(),
      proxyUrl:     els.proxyUrl?.value.trim() || "",
      tokenSavedAt: Date.now(),
    }));
  } catch (e) { console.warn("saveCreds:", e); }
}

function clearCreds() {
  localStorage.removeItem(STORAGE_KEY);
  els.authToken.value = "";
  if (els.proxyUrl) els.proxyUrl.value = "";
  els.tokenMeta.textContent = "";
  log("Cleared saved token and proxy URL.", "warn");
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ""; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c && c.trim()));
}

const HDR_MEDIA      = ["media id","mediaid","media_id","mediaids","media ids"];
const HDR_VIN        = ["vin","sku name","sku","vin name"];
const HDR_ENTERPRISE = ["enterprise id","enterpriseid","enterprise_id","enterprise"];
const HDR_TEAM       = ["team id","teamid","team_id","team"];
const HDR_USER       = ["user id","userid","user_id","user"];

function hdrIdx(headers, candidates) {
  const norm = s => s.toLowerCase().trim();
  for (let i = 0; i < headers.length; i++)
    if (candidates.includes(norm(headers[i]))) return i;
  return -1;
}

function loadCSVFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = parseCSV(reader.result);
      if (rows.length < 2) { log("CSV needs a header + at least one data row.", "err"); parsedRows = []; return; }
      const H  = rows[0];
      const mi = hdrIdx(H, HDR_MEDIA), vi = hdrIdx(H, HDR_VIN);
      const ei = hdrIdx(H, HDR_ENTERPRISE), ti = hdrIdx(H, HDR_TEAM), ui = hdrIdx(H, HDR_USER);
      if (mi < 0) { log(`Missing Media ID column. Found: ${H.join(", ")}`, "err"); parsedRows = []; return; }
      if (ei < 0) { log(`Missing Enterprise ID column. Found: ${H.join(", ")}`, "err"); parsedRows = []; return; }
      if (ti < 0) { log(`Missing Team ID column. Found: ${H.join(", ")}`, "err"); parsedRows = []; return; }
      const seen = new Set(); parsedRows = []; const warn = [];
      for (let i = 1; i < rows.length; i++) {
        const m = (rows[i][mi] || "").trim();
        if (!m || seen.has(m)) continue;
        seen.add(m);
        const eid = (rows[i][ei] || "").trim(), tid = (rows[i][ti] || "").trim();
        const uid = ui >= 0 ? (rows[i][ui] || "").trim() : "";
        if (!eid || !tid) warn.push(`row ${i+1}`);
        parsedRows.push({ mediaId: m, vin: vi >= 0 ? (rows[i][vi] || "").trim() : "", enterpriseId: eid, teamId: tid, userId: uid });
      }
      if (warn.length) log(`${warn.length} row(s) missing Enterprise/Team ID: ${warn.slice(0,5).join(", ")}${warn.length>5?` +${warn.length-5} more`:""}`, "warn");
      const extras = [vi>=0&&"VIN labels", ui>=0&&"User ID"].filter(Boolean);
      els.csvSummary.textContent = `Loaded ${parsedRows.length} unique media ID${parsedRows.length===1?"":"s"} from ${file.name}${extras.length?` (with ${extras.join(" and ")}).`:"."}`; 
      log(`CSV parsed: ${parsedRows.length} rows.`, warn.length ? "warn" : "ok");
    } catch(e) { log(`CSV parse error: ${e.message}`, "err"); parsedRows = []; }
  };
  reader.onerror = () => log("Could not read CSV file.", "err");
  reader.readAsText(file);
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging & progress
// ─────────────────────────────────────────────────────────────────────────────

function log(msg, kind = "info") {
  els.outputCard.hidden = false;
  const cls  = kind==="ok"?"row-ok":kind==="err"?"row-err":kind==="warn"?"row-warn":"";
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  els.output.appendChild(line);
  els.output.scrollTop = els.output.scrollHeight;
}

function updateProgress(done, total) {
  if (!els.progressBar || !els.progressText) return;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  els.progressBar.style.width = `${pct}%`;
  els.progressText.textContent = `${done} / ${total}`;
}

function showProgress(show) {
  if (els.progressWrap) els.progressWrap.hidden = !show;
}

// ─────────────────────────────────────────────────────────────────────────────
// Folder picker
// ─────────────────────────────────────────────────────────────────────────────

async function pickFolder() {
  try {
    downloadDirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    els.folderStatus.textContent = `📁 Saving to: ${downloadDirHandle.name}`;
    els.folderStatus.style.color = "var(--ok)";
    log(`Output folder set: "${downloadDirHandle.name}" — files will save here instead of a master ZIP.`, "ok");
  } catch(e) {
    if (e.name !== "AbortError") log(`Folder picker error: ${e.message}`, "err");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildPayload(row) {
  return {
    userData: { enterpriseId: row.enterpriseId, teamId: row.teamId, userId: row.userId || "" },
    downloadRequestData: {
      downloadType:    els.downloadType.value,
      formatType:      els.formatType.value,
      isSequence:      els.isSequence.checked,
      downloadProduct: [els.downloadProduct.value],
    },
  };
}

function newUUID() {
  return (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = Math.random()*16|0; return (c==="x"?r:(r&3)|8).toString(16);
      });
}

function apiHeaders(token) {
  return {
    accept: "application/json, text/plain, */*",
    authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    "content-type": "application/json",
    "x-request-id": newUUID(),
  };
}

function extractDownloadUrl(json, preferredProduct) {
  const products = json?.data?.products || json?.products;
  if (products && typeof products === "object") {
    const keys = preferredProduct && products[preferredProduct]
      ? [preferredProduct, ...Object.keys(products).filter(k => k !== preferredProduct)]
      : Object.keys(products);
    for (const k of keys) {
      const u = products[k]?.url || products[k]?.downloadUrl || products[k]?.signedUrl;
      if (typeof u === "string" && u.startsWith("http")) return u;
    }
  }
  return json?.data?.downloadUrl || json?.data?.url || json?.data?.signedUrl ||
         json?.downloadUrl || json?.url || json?.signedUrl || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// File utilities
// ─────────────────────────────────────────────────────────────────────────────

function saveBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

function safeName(s, fb = "download") {
  return (String(s || fb).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim()) || fb;
}

async function getNestedDir(root, ...parts) {
  let dir = root;
  for (const part of parts)
    dir = await dir.getDirectoryHandle(safeName(part, "unknown"), { create: true });
  return dir;
}

// Write a blob into  folderRoot/enterpriseId/teamId/vin/
// If the blob is itself a ZIP, extract its contents directly into that folder.
async function writeBlobToFolder(blob, fname, label, row) {
  const targetDir = await getNestedDir(
    downloadDirHandle,
    row.enterpriseId || "unknown_enterprise",
    row.teamId       || "unknown_team",
    row.vin || row.mediaId
  );
  const pathStr = `${downloadDirHandle.name}/${row.enterpriseId}/${row.teamId}/${row.vin || row.mediaId}/`;

  if (fname.endsWith(".zip") && typeof JSZip === "function") {
    try {
      const zip     = await JSZip.loadAsync(blob);
      const entries = Object.values(zip.files).filter(f => !f.dir);
      for (const entry of entries) {
        const entryBlob = await entry.async("blob");
        const entryName = entry.name.split("/").pop();
        const fh = await targetDir.getFileHandle(safeName(entryName, "file"), { create: true });
        const w  = await fh.createWritable();
        await w.write(entryBlob); await w.close();
      }
      log(`  ✓ ${label}: extracted ${entries.length} image(s) → ${pathStr}`, "ok");
      return;
    } catch(e) {
      log(`  ZIP extraction failed (${e.message}), saving raw ZIP file instead.`, "warn");
    }
  }

  const fh = await targetDir.getFileHandle(fname, { create: true });
  const w  = await fh.createWritable();
  await w.write(blob); await w.close();
  log(`  ✓ ${label}: saved → ${pathStr}${fname} (${(blob.size/1024/1024).toFixed(2)} MB)`, "ok");
}

// ─────────────────────────────────────────────────────────────────────────────
// Master ZIP (used only in ZIP mode, mutex-protected for parallel safety)
// ─────────────────────────────────────────────────────────────────────────────

async function addToMasterZip(fname, blob, row) {
  const basePath = [
    safeName(row.enterpriseId || "unknown_enterprise"),
    safeName(row.teamId       || "unknown_team"),
    safeName(row.vin || row.mediaId),
  ].join("/") + "/";

  zipMutex = zipMutex.then(async () => {
    if (fname.endsWith(".zip") && typeof JSZip === "function") {
      try {
        const inner   = await JSZip.loadAsync(blob);
        const entries = Object.values(inner.files).filter(f => !f.dir);
        for (const entry of entries) {
          const entryName = entry.name.split("/").pop();
          const data      = await entry.async("arraybuffer");
          masterZip.file(basePath + safeName(entryName, "file"), data);
        }
        masterZipEntries++;
        return;
      } catch(e) { /* fall through */ }
    }
    masterZip.file(basePath + fname, blob);
    masterZipEntries++;
  });
  return zipMutex;
}

async function finalizeMasterZip() {
  if (!masterZip) return;
  if (masterZipEntries === 0) {
    log("No files collected into master ZIP. Check proxy URL and auth token.", "warn");
    masterZip = null; return;
  }
  log(`Building master ZIP with ${masterZipEntries} VIN${masterZipEntries===1?"":"s"}…`);
  try {
    const blob  = await masterZip.generateAsync({ type: "blob", compression: "STORE" });
    const stamp = new Date().toISOString().replace(/[:.]/g,"-").slice(0,19);
    saveBlob(blob, `spyne-downloads-${stamp}.zip`);
    log(`✓ Master ZIP saved: spyne-downloads-${stamp}.zip (${(blob.size/1024/1024).toFixed(2)} MB, ${masterZipEntries} VINs).`, "ok");
  } catch(e) { log(`Could not build master ZIP: ${e.message}`, "err"); }
  masterZip = null; masterZipEntries = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Blob fetching
// Always tries the Cloudflare proxy /fetch-url first (bypasses S3 CORS).
// Falls back to direct fetch as a best-effort (works only if S3 allows CORS).
// ─────────────────────────────────────────────────────────────────────────────

async function fetchBlob(signedUrl) {
  // Route 1: proxy /fetch-url (recommended — avoids S3 CORS entirely)
  const proxyEndpoint = fetchUrlProxyEndpoint();
  if (proxyEndpoint) {
    try {
      const res = await fetch(proxyEndpoint, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ url: signedUrl }),
      });
      if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
      return await res.blob();
    } catch(e) {
      log(`  Proxy /fetch-url failed (${e.message}). Trying direct fetch…`, "warn");
    }
  }

  // Route 2: direct (only works if Spyne's S3 allows CORS for this origin)
  try {
    const res = await fetch(signedUrl, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  } catch(e) {
    log(`  Direct fetch blocked (CORS). ${proxyEndpoint ? "Proxy also failed — check worker URL." : "No proxy set — paste your Cloudflare Worker URL above."}`, "warn");
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SINGLE DELIVERY FUNCTION
// All download paths funnel here. Mode is decided once, cleanly.
// ─────────────────────────────────────────────────────────────────────────────

async function deliverDownload(signedUrl, row, label) {
  const mode  = getMode();
  const fname = `${safeName(row.vin || row.mediaId)}.zip`;

  if (mode === "TAB") {
    // No proxy, no folder — can't fetch blob. Open in tab.
    window.open(signedUrl, "_blank", "noopener");
    log(`  ↗ ${label}: no proxy set — opened in new tab.`, "warn");
    return;
  }

  // Fetch the blob (via proxy if available)
  const blob = await fetchBlob(signedUrl);
  if (!blob) {
    // fetchBlob already logged why it failed. Fall back to tab.
    window.open(signedUrl, "_blank", "noopener");
    log(`  ↗ ${label}: blob fetch failed — opened in new tab as fallback.`, "warn");
    return;
  }

  if (mode === "FOLDER") {
    // FOLDER mode: write directly into the chosen folder
    try {
      await writeBlobToFolder(blob, fname, label, row);
    } catch(e) {
      log(`  ✗ ${label}: folder write failed (${e.message}). Saving to Downloads instead.`, "err");
      saveBlob(blob, fname);
    }
    return;
  }

  // ZIP mode: accumulate into master ZIP
  await addToMasterZip(fname, blob, row);
  log(`  ✓ ${label}: added to master ZIP → ${row.enterpriseId}/${row.teamId}/${row.vin || row.mediaId}/`, "ok");
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-VIN polling
// ─────────────────────────────────────────────────────────────────────────────

const R_DONE    = "downloaded";
const R_PENDING = "pending";
const R_FAILED  = "failed";

async function fetchPerMedia(row, requestId, token, { quiet = false } = {}) {
  const label = row.vin ? `${row.mediaId} (VIN ${row.vin})` : row.mediaId;
  const res   = await fetch(perMediaGetUrl(row.mediaId, requestId), {
    method:  "GET",
    headers: {
      accept:        "application/json, text/plain, */*",
      authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
      "x-request-id": newUUID(),
    },
    mode: "cors",
  });
  const ctype = (res.headers.get("content-type") || "").toLowerCase();

  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    if (res.status === 404 || res.status === 425 || /not.?ready|in[\s_-]?progress/i.test(txt)) {
      if (!quiet) log(`  ⋯ ${label}: still preparing (HTTP ${res.status}). Will retry.`, "warn");
      return R_PENDING;
    }
    log(`  ✗ ${label}: HTTP ${res.status} — ${txt.slice(0,240)}`, "err");
    return R_FAILED;
  }

  // JSON response: extract download URL or check status
  if (ctype.includes("application/json")) {
    const json    = await res.json().catch(() => null);
    const PENDING = ["pending","in_progress","yet_to_start","queued","processing"];
    const overallStatus = (json?.data?.status || json?.status || "").toLowerCase();
    const products      = json?.data?.products || json?.products;
    let downloadUrl = null, anyPending = false;
    if (products && typeof products === "object") {
      const preferred = els.downloadProduct?.value;
      const keys = preferred && products[preferred]
        ? [preferred, ...Object.keys(products).filter(k => k !== preferred)]
        : Object.keys(products);
      for (const k of keys) {
        const p = products[k] || {};
        const u = p.url || p.downloadUrl || p.signedUrl;
        if (typeof u === "string" && u.startsWith("http")) { downloadUrl = u; break; }
        if (PENDING.includes((p.status||"").toLowerCase())) anyPending = true;
      }
    }
    if (!downloadUrl) downloadUrl = extractDownloadUrl(json, els.downloadProduct?.value);
    if (typeof downloadUrl === "string" && downloadUrl.startsWith("http")) {
      await deliverDownload(downloadUrl, row, label);
      return R_DONE;
    }
    if (PENDING.includes(overallStatus) || anyPending) {
      if (!quiet) log(`  ⋯ ${label}: still preparing (${overallStatus||"in_progress"}). Will retry.`, "warn");
      return R_PENDING;
    }
    log(`  ! ${label}: unrecognised response — ${JSON.stringify(json).slice(0,280)}`, "err");
    return R_FAILED;
  }

  // Binary response: API returned the file directly (no signed URL step)
  const blob  = await res.blob();
  const ext   = ctype.includes("zip") ? "zip" : "bin";
  const fname = `${safeName(row.vin || row.mediaId)}.${ext}`;
  const mode  = getMode();
  if (mode === "FOLDER" && downloadDirHandle) {
    try { await writeBlobToFolder(blob, fname, label, row); return R_DONE; }
    catch(e) { log(`  Folder write failed (${e.message}). Saving to Downloads.`, "warn"); }
  } else if (mode === "ZIP" && masterZip) {
    await addToMasterZip(fname, blob, row);
    log(`  ✓ ${label}: added to master ZIP → ${row.enterpriseId}/${row.teamId}/${row.vin || row.mediaId}/`, "ok");
    return R_DONE;
  }
  saveBlob(blob, fname);
  log(`  ✓ ${label}: saved ${fname} (${(blob.size/1024/1024).toFixed(2)} MB) to Downloads.`, "ok");
  return R_DONE;
}

async function pollOne(row, requestId, token, idx, total) {
  const label  = row.vin ? `${row.mediaId} (VIN ${row.vin})` : row.mediaId;
  const prefix = `[${idx+1}/${total}]`;
  const t0 = Date.now(); let attempt = 0, bi = 0;
  while (Date.now() - t0 < POLL_MAX_MS) {
    attempt++;
    if (attempt > 1) {
      const wait = POLL_INTERVALS_MS[Math.min(bi, POLL_INTERVALS_MS.length-1)];
      log(`${prefix}   …still preparing (${((Date.now()-t0)/1000).toFixed(0)}s). Waiting ${wait/1000}s.`);
      await new Promise(r => setTimeout(r, wait));
    }
    let result;
    try { result = await fetchPerMedia(row, requestId, token, { quiet: attempt > 1 }); }
    catch(e) { log(`${prefix}   ✗ ${label}: ${e.message}`, "err"); return false; }
    if (result === R_DONE)   { log(`${prefix}   ✓ ${label}: done after ${((Date.now()-t0)/1000).toFixed(1)}s.`, "ok"); return true; }
    if (result === R_FAILED) { log(`${prefix}   ✗ ${label}: hard failure.`, "err"); return false; }
    bi++;
  }
  log(`${prefix}   ⏱  ${label}: polling cap hit, still pending.`, "warn");
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parallel pool
// ─────────────────────────────────────────────────────────────────────────────

async function runPool(tasks, concurrency) {
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < tasks.length) { const i = nextIdx++; await tasks[i](); }
  }
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, tasks.length); w++) workers.push(worker());
  await Promise.all(workers);
}

// ─────────────────────────────────────────────────────────────────────────────
// Process one VIN
// ─────────────────────────────────────────────────────────────────────────────

async function processVin(row, token, idx, total) {
  const label = row.vin ? `${row.mediaId} (VIN ${row.vin})` : row.mediaId;
  const tag   = `[${idx+1}/${total}]`;
  log(`${tag} POST /medias/${row.mediaId}/download …`);
  try {
    const postRes = await fetch(perVinPostUrl(row.mediaId), {
      method:  "POST",
      headers: apiHeaders(token),
      body:    JSON.stringify(buildPayload(row)),
      mode:    "cors",
    });
    if (!postRes.ok) {
      const txt = await postRes.text().catch(() => postRes.statusText);
      log(`${tag}   ✗ POST HTTP ${postRes.status} — ${txt.slice(0,240)}`, "err");
      return false;
    }
    const json      = await postRes.json().catch(() => null);
    const directUrl = extractDownloadUrl(json, els.downloadProduct.value);
    if (typeof directUrl === "string" && directUrl.startsWith("http")) {
      await deliverDownload(directUrl, row, label);
      return true;
    }
    const requestId = json?.data?.requestId || json?.requestId || json?.jobId || json?.data?.jobId;
    if (!requestId) {
      log(`${tag}   ✗ ${label}: no URL nor requestId. Body: ${JSON.stringify(json).slice(0,240)}`, "err");
      return false;
    }
    lastRequestIdsByMedia.set(row.mediaId, requestId);
    log(`${tag}   POST accepted (requestId ${requestId}). Polling…`);
    return await pollOne(row, requestId, token, idx, total);
  } catch(e) {
    log(`${tag}   ✗ ${e.message?.includes("Failed to fetch") ? "Network/CORS error — check proxy URL." : e.message}`, "err");
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main download click
// ─────────────────────────────────────────────────────────────────────────────

async function onDownloadClick() {
  els.output.innerHTML = "";
  els.outputCard.hidden = false;
  const token = els.authToken.value.trim();
  if (!token)          return log("Authorization token is required.", "err");
  if (!parsedRows.length) return log("Upload a CSV with at least one media ID.", "err");
  const bad = parsedRows.filter(r => !r.enterpriseId || !r.teamId);
  if (bad.length) return log(`${bad.length} row(s) missing Enterprise/Team ID. Fix CSV and re-upload.`, "err");

  saveCreds();
  lastRows = parsedRows.slice();
  lastRequestIdsByMedia = new Map();
  zipMutex       = Promise.resolve();
  masterZipEntries = 0;

  const mode = getMode();
  // Only create a master ZIP in ZIP mode
  masterZip = (mode === "ZIP" && typeof JSZip === "function") ? new JSZip() : null;
  if (mode === "ZIP" && !masterZip) log("JSZip didn't load (CDN blocked?). Blobs will be saved individually.", "warn");

  const concurrency = getConcurrency();

  // Log which mode we're running in so it's visible in the status panel
  if (mode === "FOLDER") {
    log(`Mode: FOLDER PICKER → files will be extracted into "${downloadDirHandle.name}/" (${concurrency} parallel)`, "ok");
  } else if (mode === "ZIP") {
    log(`Mode: PROXY + master ZIP [${proxyBase()}] (${concurrency} parallel)`, "ok");
  } else {
    log(`Mode: TAB FALLBACK — set a proxy URL and/or pick a folder above. (${concurrency} parallel)`, "warn");
  }

  log(`Processing ${parsedRows.length} VIN${parsedRows.length===1?"":"s"}…`);
  showProgress(true);
  updateProgress(0, parsedRows.length);
  els.downloadBtn.disabled = true;
  els.refetchBtn.hidden = false;

  const t0 = Date.now(); let ok = 0, fail = 0, done = 0;
  const tasks = parsedRows.map((row, i) => async () => {
    const result = await processVin(row, token, i, parsedRows.length);
    done++; result ? ok++ : fail++;
    updateProgress(done, parsedRows.length);
  });

  try { await runPool(tasks, concurrency); }
  finally { els.downloadBtn.disabled = false; }

  log(`Done in ${((Date.now()-t0)/1000).toFixed(1)}s — ✓ ${ok}  ✗ ${fail}`, fail ? "warn" : "ok");
  showProgress(false);
  await finalizeMasterZip();
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-fetch
// ─────────────────────────────────────────────────────────────────────────────

async function onRefetchClick() {
  if (!lastRequestIdsByMedia.size) { log("No previous run to re-fetch. Click Download first.", "warn"); return; }
  const token = els.authToken.value.trim();
  if (!token) return log("Authorization token is required.", "err");

  zipMutex       = Promise.resolve();
  masterZipEntries = 0;
  const mode = getMode();
  masterZip  = (mode === "ZIP" && typeof JSZip === "function") ? new JSZip() : null;

  const concurrency = getConcurrency();
  showProgress(true);
  updateProgress(0, lastRows.length);
  els.refetchBtn.disabled = true;
  const t0 = Date.now(); let ok = 0, fail = 0, done = 0;
  log(`Re-fetching ${lastRows.length} VIN${lastRows.length===1?"":"s"} in ${mode} mode…`);

  const tasks = lastRows.map((row, i) => async () => {
    const rid = lastRequestIdsByMedia.get(row.mediaId);
    if (!rid) {
      log(`[${i+1}/${lastRows.length}]   ✗ No requestId for ${row.mediaId}.`, "err");
      done++; fail++; updateProgress(done, lastRows.length); return;
    }
    log(`[${i+1}/${lastRows.length}] Re-checking ${row.mediaId}${row.vin?` (VIN ${row.vin})`:""}…`);
    const result = await pollOne(row, rid, token, i, lastRows.length);
    done++; result ? ok++ : fail++;
    updateProgress(done, lastRows.length);
  });

  try { await runPool(tasks, concurrency); }
  finally { els.refetchBtn.disabled = false; }

  log(`Re-fetch done in ${((Date.now()-t0)/1000).toFixed(1)}s — ✓ ${ok}  ✗ ${fail}`, fail ? "warn" : "ok");
  showProgress(false);
  await finalizeMasterZip();
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  loadCreds();
  if (!("showDirectoryPicker" in window)) {
    if (els.pickFolderBtn)     els.pickFolderBtn.hidden = true;
    if (els.folderUnsupported) els.folderUnsupported.hidden = false;
  }
  els.csvFile.addEventListener("change", e => { const f = e.target.files?.[0]; if (f) loadCSVFile(f); });
  els.downloadBtn.addEventListener("click", onDownloadClick);
  if (els.refetchBtn)    els.refetchBtn.addEventListener("click", onRefetchClick);
  els.clearCredsBtn.addEventListener("click", clearCreds);
  if (els.pickFolderBtn) els.pickFolderBtn.addEventListener("click", pickFolder);
});

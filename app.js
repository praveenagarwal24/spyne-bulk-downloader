/* Spyne Bulk Media Downloader — front-end logic.
 * Enterprise ID, Team ID, User ID come exclusively from the CSV.
 *
 * DOWNLOAD STRATEGY (three modes, auto-selected at runtime):
 *
 *  Mode A — PROXY + master ZIP
 *  Mode B — FOLDER PICKER  (no proxy needed)
 *  Mode C — TAB FALLBACK
 *
 * SPEED UPGRADE v2:
 *  - Parallel concurrency: CONCURRENCY VINs processed simultaneously (default 5).
 *  - Each VIN's poll loop runs independently — no VIN blocks another.
 *  - First poll delay reduced to 1 s (API often resolves quickly).
 *  - Sequential 1 s inter-VIN delay removed entirely.
 *  - Real-time progress bar.
 */

const STORAGE_KEY = "spyne-bulk-downloader/v3";

const POLL_INTERVALS_MS = [1_000, 3_000, 5_000, 10_000, 15_000, 30_000];
const POLL_MAX_MS       = 15 * 60 * 1000;
const DEFAULT_CONCURRENCY = 5;

const $ = (id) => document.getElementById(id);

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

let parsedRows        = [];
let downloadDirHandle = null;

// ---------- config ----------

function proxyBase() {
  return (els.proxyUrl?.value || "").trim().replace(/\/$/, "");
}
function getConcurrency() {
  const v = parseInt(els.concurrency?.value, 10);
  return (!isNaN(v) && v >= 1 && v <= 20) ? v : DEFAULT_CONCURRENCY;
}
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

// ---------- credentials ----------

function loadCreds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.authToken) els.authToken.value = d.authToken;
    if (d.proxyUrl && els.proxyUrl) els.proxyUrl.value = d.proxyUrl;
    if (d.tokenSavedAt) {
      const ageDays = (Date.now() - d.tokenSavedAt) / 86_400_000;
      const warn = ageDays >= 5;
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

// ---------- CSV ----------

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
      const H = rows[0];
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

// ---------- logging ----------

function log(msg, kind = "info") {
  els.outputCard.hidden = false;
  const cls = kind==="ok"?"row-ok":kind==="err"?"row-err":kind==="warn"?"row-warn":"";
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  els.output.appendChild(line);
  els.output.scrollTop = els.output.scrollHeight;
}

// ---------- progress ----------

function updateProgress(done, total) {
  if (!els.progressBar || !els.progressText) return;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  els.progressBar.style.width = `${pct}%`;
  els.progressText.textContent = `${done} / ${total}`;
}

function showProgress(show) {
  if (els.progressWrap) els.progressWrap.hidden = !show;
}

// ---------- folder picker ----------

async function pickFolder() {
  try {
    downloadDirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    els.folderStatus.textContent = `📁 Saving to: ${downloadDirHandle.name}`;
    els.folderStatus.style.color = "var(--ok)";
    log(`Output folder set: "${downloadDirHandle.name}"`, "ok");
  } catch(e) {
    if (e.name !== "AbortError") log(`Folder picker error: ${e.message}`, "err");
  }
}

// ---------- API helpers ----------

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

/** Recursively get-or-create a nested directory handle. */
async function getNestedDir(root, ...parts) {
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(safeName(part, "unknown"), { create: true });
  }
  return dir;
}

/**
 * Write blob into  root/enterpriseId/teamId/vin/images/<fname>
 * If the blob is a ZIP, extract its entries directly into the images/ folder.
 */
async function writeBlobToFolder(blob, fname, label, row) {
  const imagesDir = await getNestedDir(
    downloadDirHandle,
    row.enterpriseId || "unknown_enterprise",
    row.teamId       || "unknown_team",
    row.vin || row.mediaId
  );

  const path = `${row.enterpriseId}/${row.teamId}/${row.vin || row.mediaId}/`;

  // If it's a ZIP, extract entries directly into images/
  if (fname.endsWith(".zip") && typeof JSZip === "function") {
    try {
      const zip = await JSZip.loadAsync(blob);
      const entries = Object.values(zip.files).filter(f => !f.dir);
      for (const entry of entries) {
        const entryBlob = await entry.async("blob");
        const entryName = entry.name.split("/").pop(); // strip any sub-path inside the zip
        const fh = await imagesDir.getFileHandle(safeName(entryName, "file"), { create: true });
        const w  = await fh.createWritable();
        await w.write(entryBlob); await w.close();
      }
      log(`  ✓ ${label}: extracted ${entries.length} image(s) → ${path}`, "ok");
      return;
    } catch(e) {
      log(`  ZIP extraction failed (${e.message}), saving raw file instead.`, "warn");
    }
  }

  // Fallback: write the file as-is
  const fh = await imagesDir.getFileHandle(fname, { create: true });
  const w  = await fh.createWritable();
  await w.write(blob); await w.close();
  log(`  ✓ ${label}: saved → ${path}${fname} (${(blob.size/1024/1024).toFixed(2)} MB)`, "ok");
}

// ---------- master ZIP (mutex-protected for parallel safety) ----------

let masterZip = null;
let masterZipEntries = 0;
let zipMutex = Promise.resolve();

async function addToMasterZip(fname, blob, row) {
  const basePath = [
    safeName(row.enterpriseId || "unknown_enterprise"),
    safeName(row.teamId       || "unknown_team"),
    safeName(row.vin || row.mediaId),
  ].join("/") + "/";

  zipMutex = zipMutex.then(async () => {
    // If it's a ZIP, extract entries into the images/ folder
    if (fname.endsWith(".zip") && typeof JSZip === "function") {
      try {
        const inner = await JSZip.loadAsync(blob);
        const entries = Object.values(inner.files).filter(f => !f.dir);
        for (const entry of entries) {
          const entryName = entry.name.split("/").pop();
          const data = await entry.async("arraybuffer");
          masterZip.file(basePath + safeName(entryName, "file"), data);
        }
        masterZipEntries++;
        return;
      } catch(e) {
        // fall through to raw file
      }
    }
    masterZip.file(basePath + fname, blob);
    masterZipEntries++;
  });
  return zipMutex;
}

// ---------- blob fetch ----------

async function fetchBlob(signedUrl) {
  const proxyEndpoint = fetchUrlProxyEndpoint();
  if (proxyEndpoint) {
    try {
      const res = await fetch(proxyEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: signedUrl }),
      });
      if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
      return await res.blob();
    } catch(e) {
      log(`  Proxy fetch failed (${e.message}). Trying direct…`, "warn");
    }
  }
  try {
    const res = await fetch(signedUrl, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  } catch(e) {
    log(`  Direct fetch failed (CORS blocked). ${downloadDirHandle ? "Folder picker needs a proxy URL (Option A) to fetch blobs — set one above." : "Set a proxy URL (Option A) to fix this."}`, "warn");
    return null;
  }
}

async function deliverDownload(signedUrl, row, label) {
  const fname = `${safeName(row.vin || row.mediaId)}.zip`;
  const blob  = await fetchBlob(signedUrl);

  if (!blob) {
    // Blob fetch failed (CORS). If folder picker is active, we can't write to it either.
    // Open in tab as the only cross-origin option the browser allows.
    window.open(signedUrl, "_blank", "noopener");
    log(`  ⚠ ${label}: CORS blocked blob fetch — opened in new tab. To save to your folder, also set a Proxy URL in Option A above.`, "warn");
    return;
  }

  // Folder picker takes priority when a folder is selected
  if (downloadDirHandle) {
    try { await writeBlobToFolder(blob, fname, label, row); return; }
    catch(e) { log(`  Folder write failed (${e.message}). Saving flat.`, "warn"); }
  }

  // Proxy mode: add to master ZIP (only when proxy URL is configured)
  if (masterZip && proxyBase()) {
    await addToMasterZip(fname, blob, row);
    log(`  ✓ ${label}: queued → ${row.enterpriseId}/${row.teamId}/${row.vin || row.mediaId}/`, "ok");
    return;
  }

  // Last resort: flat save to default Downloads
  saveBlob(blob, fname);
  log(`  ✓ ${label}: saved ${fname} (${(blob.size/1024/1024).toFixed(2)} MB) to default Downloads.`, "ok");
}

// ---------- per-VIN polling ----------

const R_DONE    = "downloaded";
const R_PENDING = "pending";
const R_FAILED  = "failed";

async function fetchPerMedia(row, requestId, token, { quiet = false } = {}) {
  const label = row.vin ? `${row.mediaId} (VIN ${row.vin})` : row.mediaId;
  const res = await fetch(perMediaGetUrl(row.mediaId, requestId), {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
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

  if (ctype.includes("application/json")) {
    const json = await res.json().catch(() => null);
    const PENDING = ["pending","in_progress","yet_to_start","queued","processing"];
    const overallStatus = (json?.data?.status || json?.status || "").toLowerCase();
    const products = json?.data?.products || json?.products;
    let downloadUrl = null, anyPending = false;
    if (products && typeof products === "object") {
      const preferred = els.downloadProduct?.value;
      const keys = preferred && products[preferred]
        ? [preferred, ...Object.keys(products).filter(k=>k!==preferred)]
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

  // Binary response
  const blob = await res.blob();
  const ext  = ctype.includes("zip") ? "zip" : "bin";
  const fname = `${safeName(row.vin || row.mediaId)}.${ext}`;
  // Mode B — folder picker (no proxy needed)
  if (downloadDirHandle) {
    try { await writeBlobToFolder(blob, fname, label, row); return R_DONE; }
    catch(e) { log(`  Folder write failed (${e.message}). Falling back.`, "warn"); }
  }
  // Mode A — proxy ZIP
  if (masterZip && proxyBase()) {
    await addToMasterZip(fname, blob, row);
    log(`  ✓ ${label}: added to master ZIP under ${row.enterpriseId}/${row.teamId}/${row.vin || row.mediaId}/`, "ok");
    return R_DONE;
  }
  saveBlob(blob, fname);
  log(`  ✓ ${label}: saved ${fname} (${(blob.size/1024/1024).toFixed(2)} MB) to default Downloads.`, "ok");
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
    try { result = await fetchPerMedia(row, requestId, token, { quiet: attempt>1 }); }
    catch(e) { log(`${prefix}   ✗ ${label}: ${e.message}`, "err"); return false; }
    if (result === R_DONE)   { log(`${prefix}   ✓ ${label}: done after ${((Date.now()-t0)/1000).toFixed(1)}s.`, "ok"); return true; }
    if (result === R_FAILED) { log(`${prefix}   ✗ ${label}: hard failure.`, "err"); return false; }
    bi++;
  }
  log(`${prefix}   ⏱  ${label}: polling cap hit, still pending.`, "warn");
  return false;
}

// ---------- parallel pool ----------

async function runPool(tasks, concurrency) {
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < tasks.length) {
      const i = nextIdx++;
      await tasks[i]();
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, tasks.length); w++) workers.push(worker());
  await Promise.all(workers);
}

// ---------- state for re-fetch ----------

let lastRows = [];
let lastRequestIdsByMedia = new Map();

// ---------- finalize master ZIP ----------

async function finalizeMasterZip() {
  if (!masterZip) return;
  if (masterZipEntries === 0) {
    log("No files were collected. Check your proxy URL and auth token.", "warn");
    masterZip = null; return;
  }
  log(`Building master ZIP with ${masterZipEntries} VIN${masterZipEntries===1?"":"s"}…`);
  try {
    const blob = await masterZip.generateAsync({ type: "blob", compression: "STORE" });
    const stamp = new Date().toISOString().replace(/[:.]/g,"-").slice(0,19);
    saveBlob(blob, `spyne-downloads-${stamp}.zip`);
    log(`✓ Master ZIP saved: spyne-downloads-${stamp}.zip (${(blob.size/1024/1024).toFixed(2)} MB, ${masterZipEntries} VINs).`, "ok");
  } catch(e) { log(`Could not build master ZIP: ${e.message}`, "err"); }
  masterZip = null; masterZipEntries = 0;
}

// ---------- mode announcement ----------

function announceMode(concurrency) {
  const cStr = `(${concurrency} parallel)`;
  if (downloadDirHandle && proxyBase()) {
    log(`Mode: PROXY (fetch) + FOLDER PICKER (save) → "${downloadDirHandle.name}/"  ${cStr}`, "ok");
  } else if (downloadDirHandle) {
    log(`Mode: FOLDER PICKER → "${downloadDirHandle.name}/"  ${cStr} — ⚠ No proxy set; S3 CORS may block downloads.`, "warn");
  } else if (proxyBase()) {
    log(`Mode: PROXY → master ZIP  [${proxyBase()}]  ${cStr}`, "ok");
  } else {
    log(`Mode: TAB FALLBACK — files go to default Downloads. Set a proxy URL or choose a folder above.  ${cStr}`, "warn");
  }
}

// ---------- process one VIN ----------

async function processVin(row, token, idx, total) {
  const label = row.vin ? `${row.mediaId} (VIN ${row.vin})` : row.mediaId;
  const tag   = `[${idx+1}/${total}]`;
  log(`${tag} POST /medias/${row.mediaId}/download …`);
  try {
    const postRes = await fetch(perVinPostUrl(row.mediaId), {
      method: "POST",
      headers: apiHeaders(token),
      body: JSON.stringify(buildPayload(row)),
      mode: "cors",
    });
    if (!postRes.ok) {
      const txt = await postRes.text().catch(() => postRes.statusText);
      log(`${tag}   ✗ POST HTTP ${postRes.status} — ${txt.slice(0,240)}`, "err");
      return false;
    }
    const json = await postRes.json().catch(() => null);
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
    log(`${tag}   ✗ ${e.message?.includes("Failed to fetch") ? "Network/CORS error. See README → proxy setup." : e.message}`, "err");
    return false;
  }
}

// ---------- main download ----------

async function onDownloadClick() {
  els.output.innerHTML = "";
  els.outputCard.hidden = false;
  const token = els.authToken.value.trim();
  if (!token) return log("Authorization token is required.", "err");
  if (!parsedRows.length) return log("Upload a CSV with at least one media ID.", "err");
  const bad = parsedRows.filter(r => !r.enterpriseId || !r.teamId);
  if (bad.length) return log(`${bad.length} row(s) missing Enterprise/Team ID. Fix CSV and re-upload.`, "err");

  saveCreds();
  lastRows = parsedRows.slice();
  lastRequestIdsByMedia = new Map();
  zipMutex = Promise.resolve();
  masterZip = (typeof JSZip === "function") ? new JSZip() : null;
  masterZipEntries = 0;
  if (!masterZip) log("JSZip didn't load (CDN blocked?). Blobs will be saved individually.", "warn");

  const concurrency = getConcurrency();
  announceMode(concurrency);
  log(`Processing ${parsedRows.length} VIN${parsedRows.length===1?"":"s"} with concurrency=${concurrency}…`);
  showProgress(true);
  updateProgress(0, parsedRows.length);

  els.downloadBtn.disabled = true;
  els.refetchBtn.hidden = false;
  const t0 = Date.now(); let ok = 0, fail = 0, done = 0;

  const tasks = parsedRows.map((row, i) => async () => {
    const result = await processVin(row, token, i, parsedRows.length);
    done++;
    result ? ok++ : fail++;
    updateProgress(done, parsedRows.length);
  });

  try { await runPool(tasks, concurrency); }
  finally { els.downloadBtn.disabled = false; }

  log(`Done in ${((Date.now()-t0)/1000).toFixed(1)}s — Success: ${ok}  Failed: ${fail}`, fail ? "warn" : "ok");
  showProgress(false);
  await finalizeMasterZip();
}

// ---------- re-fetch ----------

async function onRefetchClick() {
  if (!lastRequestIdsByMedia.size) { log("No previous run to re-fetch. Click Download first.", "warn"); return; }
  const token = els.authToken.value.trim();
  if (!token) return log("Authorization token is required.", "err");

  zipMutex = Promise.resolve();
  masterZip = (typeof JSZip === "function") ? new JSZip() : null;
  masterZipEntries = 0;

  const concurrency = getConcurrency();
  showProgress(true);
  updateProgress(0, lastRows.length);
  els.refetchBtn.disabled = true;
  const t0 = Date.now(); let ok = 0, fail = 0, done = 0;
  log(`Re-fetching ${lastRows.length} VIN${lastRows.length===1?"":"s"} with concurrency=${concurrency}…`);

  const tasks = lastRows.map((row, i) => async () => {
    const rid = lastRequestIdsByMedia.get(row.mediaId);
    if (!rid) {
      log(`[${i+1}/${lastRows.length}]   ✗ No requestId for ${row.mediaId}.`, "err");
      done++; fail++;
      updateProgress(done, lastRows.length);
      return;
    }
    log(`[${i+1}/${lastRows.length}] Re-checking ${row.mediaId}${row.vin?` (VIN ${row.vin})`:""}…`);
    const result = await pollOne(row, rid, token, i, lastRows.length);
    done++;
    result ? ok++ : fail++;
    updateProgress(done, lastRows.length);
  });

  try { await runPool(tasks, concurrency); }
  finally { els.refetchBtn.disabled = false; }

  log(`Re-fetch done in ${((Date.now()-t0)/1000).toFixed(1)}s — Success: ${ok}  Failed: ${fail}`, fail ? "warn" : "ok");
  showProgress(false);
  await finalizeMasterZip();
}

// ---------- wire up ----------

document.addEventListener("DOMContentLoaded", () => {
  loadCreds();
  if (!("showDirectoryPicker" in window)) {
    if (els.pickFolderBtn) els.pickFolderBtn.hidden = true;
    if (els.folderUnsupported) els.folderUnsupported.hidden = false;
  }
  els.csvFile.addEventListener("change", e => { const f = e.target.files?.[0]; if (f) loadCSVFile(f); });
  els.downloadBtn.addEventListener("click", onDownloadClick);
  if (els.refetchBtn)    els.refetchBtn.addEventListener("click", onRefetchClick);
  els.clearCredsBtn.addEventListener("click", clearCreds);
  if (els.pickFolderBtn) els.pickFolderBtn.addEventListener("click", pickFolder);
});

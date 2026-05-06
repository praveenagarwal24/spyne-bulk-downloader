/* Spyne Bulk Media Downloader — front-end logic.
 * Enterprise ID, Team ID, User ID come exclusively from the CSV.
 *
 * DOWNLOAD STRATEGY (three modes, auto-selected at runtime):
 *
 *  Mode A — PROXY + master ZIP
 *    User pastes their Cloudflare Worker URL into the UI.
 *    The Worker's /fetch-url endpoint fetches each S3 signed URL server-side
 *    and returns the bytes with permissive CORS, so JSZip can collect all blobs
 *    into one master ZIP that the browser downloads as a single file.
 *
 *  Mode B — FOLDER PICKER  (no proxy needed)
 *    User clicks "Choose folder". Each VIN ZIP is fetched via the proxy if set,
 *    otherwise fetched directly (works if CORS allows it), and written into the
 *    chosen folder via the File System Access API (Chrome/Edge 86+).
 *
 *  Mode C — TAB FALLBACK
 *    window.open() per VIN. Files land in the browser's default Downloads folder.
 */

const STORAGE_KEY = "spyne-bulk-downloader/v3";

const POLL_INTERVALS_MS = [3_000, 5_000, 10_000, 15_000, 30_000];
const POLL_MAX_MS       = 15 * 60 * 1000;
const SEQUENTIAL_DELAY  = 1_000;

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);

const els = {
  authToken:       $("auth-token"),
  tokenMeta:       $("token-meta"),
  proxyUrl:        $("proxy-url"),
  csvFile:         $("csv-file"),
  csvSummary:      $("csv-summary"),
  downloadType:    $("download-type"),
  formatType:      $("format-type"),
  isSequence:      $("is-sequence"),
  downloadProduct: $("download-product"),
  downloadBtn:     $("download-btn"),
  refetchBtn:      $("refetch-btn"),
  clearCredsBtn:   $("clear-creds-btn"),
  pickFolderBtn:   $("pick-folder-btn"),
  folderStatus:    $("folder-status"),
  folderUnsupported: $("folder-unsupported"),
  outputCard:      $("output-card"),
  output:          $("output"),
};

let parsedRows       = [];   // [{mediaId, vin, enterpriseId, teamId, userId}]
let downloadDirHandle = null; // FileSystemDirectoryHandle

// ---------- runtime config helpers ----------

function proxyBase() {
  return (els.proxyUrl?.value || "").trim().replace(/\/$/, "");
}
function perVinPostUrl(mediaId) {
  const b = proxyBase();
  return b
    ? `${b}/medias/${encodeURIComponent(mediaId)}/download`
    : `https://api.spyne.ai/medias/${encodeURIComponent(mediaId)}/download`;
}
function perMediaGetUrl(mediaId, requestId) {
  const b = proxyBase();
  return b
    ? `${b}/medias/${encodeURIComponent(mediaId)}/download/${encodeURIComponent(requestId)}`
    : `https://api.spyne.ai/medias/${encodeURIComponent(mediaId)}/download/${encodeURIComponent(requestId)}`;
}
function fetchUrlProxyEndpoint() {
  const b = proxyBase();
  return b ? `${b}/fetch-url` : null;
}

// ---------- credential persistence ----------

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

// ---------- CSV parsing ----------

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
      const mi = hdrIdx(H, HDR_MEDIA);
      const vi = hdrIdx(H, HDR_VIN);
      const ei = hdrIdx(H, HDR_ENTERPRISE);
      const ti = hdrIdx(H, HDR_TEAM);
      const ui = hdrIdx(H, HDR_USER);
      if (mi < 0) { log(`Missing Media ID column. Found: ${H.join(", ")}`, "err"); parsedRows = []; return; }
      if (ei < 0) { log(`Missing Enterprise ID column. Found: ${H.join(", ")}`, "err"); parsedRows = []; return; }
      if (ti < 0) { log(`Missing Team ID column. Found: ${H.join(", ")}`, "err"); parsedRows = []; return; }

      const seen = new Set();
      parsedRows = [];
      const warn = [];
      for (let i = 1; i < rows.length; i++) {
        const m = (rows[i][mi] || "").trim();
        if (!m || seen.has(m)) continue;
        seen.add(m);
        const eid = (rows[i][ei] || "").trim();
        const tid = (rows[i][ti] || "").trim();
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

async function writeBlobToFolder(blob, fname, label) {
  const fh = await downloadDirHandle.getFileHandle(fname, { create: true });
  const w  = await fh.createWritable();
  await w.write(blob); await w.close();
  log(`  ✓ ${label}: saved ${fname} (${(blob.size/1024/1024).toFixed(2)} MB) → ${downloadDirHandle.name}/`, "ok");
}

// ---------- master ZIP ----------

let masterZip = null;
let masterZipEntries = 0;

/**
 * Fetch the blob for a signed URL.
 * Tries proxy /fetch-url first (bypasses S3 CORS), falls back to direct fetch.
 * Returns null if both fail.
 */
async function fetchBlob(signedUrl) {
  const proxyEndpoint = fetchUrlProxyEndpoint();

  // Try proxy first
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

  // Try direct (will work if CORS allows, which it usually doesn't for S3 signed URLs)
  try {
    const res = await fetch(signedUrl, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  } catch(e) {
    log(`  Direct fetch also failed (${e.message}).`, "warn");
    return null;
  }
}

/**
 * Deliver one VIN's download.
 *
 * Priority:
 *   1. Fetch blob (via proxy or direct) → add to master ZIP (if proxy set)
 *   2. Fetch blob → write to chosen folder (if folder picker used)
 *   3. Fetch blob → saveBlob to default Downloads
 *   4. window.open fallback (when blob cannot be fetched)
 */
async function deliverDownload(signedUrl, row, label) {
  const fname = `${safeName(row.vin || row.mediaId)}.zip`;
  const blob  = await fetchBlob(signedUrl);

  if (blob) {
    // Mode A: proxy set → collect into master ZIP
    if (proxyBase() && masterZip) {
      masterZip.file(fname, blob);
      masterZipEntries++;
      log(`  ✓ ${label}: added ${fname} (${(blob.size/1024/1024).toFixed(2)} MB) to master ZIP.`, "ok");
      return;
    }

    // Mode B: folder picker active → write directly to folder
    if (downloadDirHandle) {
      try { await writeBlobToFolder(blob, fname, label); return; }
      catch(e) { log(`  Folder write failed (${e.message}). Saving to default Downloads.`, "warn"); }
    }

    // Mode C-blob: save to default Downloads (at least it's one click, not a tab)
    saveBlob(blob, fname);
    log(`  ✓ ${label}: saved ${fname} (${(blob.size/1024/1024).toFixed(2)} MB) to default Downloads.`, "ok");
    return;
  }

  // Mode C-tab: cannot get bytes at all — open in tab
  window.open(signedUrl, "_blank", "noopener");
  log(`  ✓ ${label}: download URL opened in a new tab (browser default Downloads folder).`, "ok");
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

  // Binary response — treat as the file itself
  const blob = await res.blob();
  const ext  = ctype.includes("zip") ? "zip" : "bin";
  const fname = `${safeName(row.vin || row.mediaId)}.${ext}`;
  if (downloadDirHandle) {
    try { await writeBlobToFolder(blob, fname, label); return R_DONE; }
    catch(e) { log(`  Folder write failed (${e.message}). Falling back.`, "warn"); }
  }
  if (masterZip && proxyBase()) {
    masterZip.file(fname, blob); masterZipEntries++;
    log(`  ✓ ${label}: added ${fname} (${(blob.size/1024/1024).toFixed(2)} MB) to master ZIP.`, "ok");
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
    if (result === R_DONE) { log(`${prefix}   ✓ ${label}: done after ${((Date.now()-t0)/1000).toFixed(1)}s.`, "ok"); return true; }
    if (result === R_FAILED) { log(`${prefix}   ✗ ${label}: hard failure.`, "err"); return false; }
    bi++;
  }
  log(`${prefix}   ⏱  ${label}: polling cap hit, still pending.`, "warn");
  return false;
}

// ---------- state for re-fetch ----------

let lastRows = [];
let lastRequestIdsByMedia = new Map();

// ---------- finalize master ZIP ----------

async function finalizeMasterZip() {
  if (!masterZip) return;
  if (masterZipEntries === 0) {
    log("No VINs were collected into the master ZIP. Check proxy URL and try again.", "warn");
    masterZip = null; return;
  }
  log(`Building master ZIP with ${masterZipEntries} VIN${masterZipEntries===1?"":"s"}…`);
  try {
    const blob = await masterZip.generateAsync({ type: "blob", compression: "STORE" });
    const stamp = new Date().toISOString().replace(/[:.]/g,"-").slice(0,19);
    const filename = `spyne-downloads-${stamp}.zip`;
    saveBlob(blob, filename);
    log(`✓ Master ZIP saved: ${filename} (${(blob.size/1024/1024).toFixed(2)} MB, ${masterZipEntries} VINs).`, "ok");
  } catch(e) { log(`Could not build master ZIP: ${e.message}`, "err"); }
  masterZip = null; masterZipEntries = 0;
}

// ---------- mode announcement ----------

function announceMode() {
  if (proxyBase()) {
    log(`Mode: PROXY → master ZIP  [${proxyBase()}]`, "ok");
  } else if (downloadDirHandle) {
    log(`Mode: FOLDER PICKER → writing to "${downloadDirHandle.name}/"`, "ok");
  } else {
    log(`Mode: TAB FALLBACK — files go to default Downloads. Set a proxy URL (Option A) or choose a folder (Option B) above to control the destination.`, "warn");
  }
}

// ---------- main flow ----------

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

  // Init master ZIP only when proxy is set (otherwise blob fetch will fail)
  masterZip = (proxyBase() && typeof JSZip === "function") ? new JSZip() : null;
  masterZipEntries = 0;
  if (proxyBase() && !masterZip) log("JSZip didn't load (CDN blocked?). Blobs will be saved individually.", "warn");

  announceMode();
  log(`Processing ${parsedRows.length} VIN${parsedRows.length===1?"":"s"} sequentially…`);

  els.downloadBtn.disabled = true;
  els.refetchBtn.hidden = false;
  const t0 = Date.now(); let ok = 0, fail = 0;

  try {
    for (let i = 0; i < parsedRows.length; i++) {
      const row = parsedRows[i];
      const label = row.vin ? `${row.mediaId} (VIN ${row.vin})` : row.mediaId;
      const tag   = `[${i+1}/${parsedRows.length}]`;
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
          log(`${tag}   ✗ POST HTTP ${postRes.status} — ${txt.slice(0,240)}`, "err"); fail++;
        } else {
          const json = await postRes.json().catch(() => null);
          const directUrl = extractDownloadUrl(json, els.downloadProduct.value);

          if (typeof directUrl === "string" && directUrl.startsWith("http")) {
            await deliverDownload(directUrl, row, label); ok++;
          } else {
            const requestId = json?.data?.requestId || json?.requestId || json?.jobId || json?.data?.jobId;
            if (!requestId) {
              log(`${tag}   ✗ ${label}: no URL nor requestId. Body: ${JSON.stringify(json).slice(0,240)}`, "err"); fail++;
            } else {
              lastRequestIdsByMedia.set(row.mediaId, requestId);
              log(`${tag}   POST accepted (requestId ${requestId}). Polling…`);
              const done = await pollOne(row, requestId, token, i, parsedRows.length);
              if (done) ok++; else fail++;
            }
          }
        }
      } catch(e) {
        log(`${tag}   ✗ ${e.message?.includes("Failed to fetch") ? "Network/CORS error. See README → proxy setup." : e.message}`, "err");
        fail++;
      }

      if (i < parsedRows.length - 1) await new Promise(r => setTimeout(r, SEQUENTIAL_DELAY));
    }
  } finally { els.downloadBtn.disabled = false; }

  log(`Done in ${((Date.now()-t0)/1000).toFixed(1)}s — Success: ${ok}  Failed: ${fail}`, fail ? "warn" : "ok");
  await finalizeMasterZip();
}

async function onRefetchClick() {
  if (!lastRequestIdsByMedia.size) { log("No previous run to re-fetch. Click Download first.", "warn"); return; }
  const token = els.authToken.value.trim();
  if (!token) return log("Authorization token is required.", "err");

  masterZip = (proxyBase() && typeof JSZip === "function") ? new JSZip() : null;
  masterZipEntries = 0;

  els.refetchBtn.disabled = true;
  const t0 = Date.now(); let ok = 0, fail = 0;
  try {
    log(`Re-fetching ${lastRows.length} VIN${lastRows.length===1?"":"s"}…`);
    for (let i = 0; i < lastRows.length; i++) {
      const row = lastRows[i];
      const rid = lastRequestIdsByMedia.get(row.mediaId);
      if (!rid) { log(`[${i+1}/${lastRows.length}]   ✗ No requestId for ${row.mediaId}.`, "err"); fail++; continue; }
      log(`[${i+1}/${lastRows.length}] Re-checking ${row.mediaId}${row.vin?` (VIN ${row.vin})`:""}…`);
      const done = await pollOne(row, rid, token, i, lastRows.length);
      if (done) ok++; else fail++;
      if (i < lastRows.length - 1) await new Promise(r => setTimeout(r, SEQUENTIAL_DELAY));
    }
  } finally { els.refetchBtn.disabled = false; }

  log(`Re-fetch done in ${((Date.now()-t0)/1000).toFixed(1)}s — Success: ${ok}  Failed: ${fail}`, fail ? "warn" : "ok");
  await finalizeMasterZip();
}

// ---------- wire up ----------

document.addEventListener("DOMContentLoaded", () => {
  loadCreds();

  // Hide folder picker if browser doesn't support it
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

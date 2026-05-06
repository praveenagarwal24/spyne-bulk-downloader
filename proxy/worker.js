/**
 * Cloudflare Worker: Spyne bulk-download CORS proxy.
 *
 * Two routes:
 *
 *   POST /          — forwards the request to api.spyne.ai/medias/bulk-download
 *                     (original route, kept for backwards compatibility)
 *
 *   POST /fetch-url — body: { "url": "https://..." }
 *                     Fetches that URL server-side and streams it back with
 *                     permissive CORS headers so the browser can read the blob.
 *                     Used to pull per-VIN ZIP files from Spyne's S3 URLs
 *                     without hitting the browser's CORS restriction.
 *
 *   POST /medias/*  — forwards per-VIN POST /medias/{id}/download to api.spyne.ai
 *
 *   GET  /medias/*  — forwards per-VIN GET  /medias/{id}/download/{requestId}
 *
 * Setup:
 *   1. https://workers.cloudflare.com → Create a Worker → paste this file.
 *   2. Save & Deploy. Note the Worker URL (e.g. spyne-proxy.<you>.workers.dev).
 *   3. Optionally lock down the ALLOWED_ORIGINS array to your GitHub Pages URL.
 *   4. In app.js set:
 *        const PROXY_BASE = "https://spyne-proxy.<you>.workers.dev";
 */

const SPYNE_API_BASE = "https://api.spyne.ai";

const ALLOWED_ORIGINS = [
  // Add your GitHub Pages URL here, e.g.:
  // "https://yourorg.github.io",
  "*", // wide-open by default; tighten before sharing
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes("*") ? "*" :
                ALLOWED_ORIGINS.includes(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, accept, x-request-id",
    "Access-Control-Max-Age": "86400",
  };
}

function spyneHeaders(request) {
  return {
    "accept": "application/json, text/plain, */*",
    "authorization": request.headers.get("authorization") || "",
    "content-type": "application/json",
    "origin": "https://console.spyne.ai",
    "referer": "https://console.spyne.ai/",
    "user-agent": request.headers.get("user-agent") || "spyne-bulk-downloader-proxy",
    "x-request-id": request.headers.get("x-request-id") || crypto.randomUUID(),
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const url    = new URL(request.url);

    // ── Preflight ──────────────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── /fetch-url  — proxy an arbitrary signed URL back to the browser ────
    // Used to stream per-VIN ZIPs so JSZip can collect them into a master ZIP.
    if (url.pathname === "/fetch-url" && request.method === "POST") {
      let targetUrl;
      try {
        const body = await request.json();
        targetUrl = body?.url;
        if (!targetUrl || !targetUrl.startsWith("https://")) throw new Error("bad url");
      } catch {
        return new Response(JSON.stringify({ error: "Body must be JSON { url: 'https://...' }" }), {
          status: 400,
          headers: { ...corsHeaders(origin), "content-type": "application/json" },
        });
      }

      const upstream = await fetch(targetUrl);
      const passthroughHeaders = new Headers(corsHeaders(origin));
      const ct = upstream.headers.get("content-type");
      if (ct) passthroughHeaders.set("content-type", ct);
      const cd = upstream.headers.get("content-disposition");
      if (cd) passthroughHeaders.set("content-disposition", cd);

      return new Response(upstream.body, {
        status: upstream.status,
        headers: passthroughHeaders,
      });
    }

    // ── /medias/*  — forward per-VIN POST or GET to api.spyne.ai ──────────
    if (url.pathname.startsWith("/medias/")) {
      if (request.method !== "POST" && request.method !== "GET") {
        return new Response("Use GET or POST", { status: 405, headers: corsHeaders(origin) });
      }
      const spyneUrl = `${SPYNE_API_BASE}${url.pathname}${url.search}`;
      const body = request.method === "POST" ? await request.text() : undefined;

      const upstream = await fetch(spyneUrl, {
        method: request.method,
        headers: spyneHeaders(request),
        body,
      });

      const passthroughHeaders = new Headers(corsHeaders(origin));
      const ct = upstream.headers.get("content-type");
      if (ct) passthroughHeaders.set("content-type", ct);
      const cd = upstream.headers.get("content-disposition");
      if (cd) passthroughHeaders.set("content-disposition", cd);

      return new Response(upstream.body, {
        status: upstream.status,
        headers: passthroughHeaders,
      });
    }

    // ── / (root)  — legacy bulk-download route ─────────────────────────────
    if (url.pathname === "/" || url.pathname === "") {
      if (request.method !== "POST") {
        return new Response("Use POST", { status: 405, headers: corsHeaders(origin) });
      }
      const body = await request.text();
      const upstream = await fetch(`${SPYNE_API_BASE}/medias/bulk-download`, {
        method: "POST",
        headers: spyneHeaders(request),
        body,
      });
      const passthroughHeaders = new Headers(corsHeaders(origin));
      const ct = upstream.headers.get("content-type");
      if (ct) passthroughHeaders.set("content-type", ct);
      const cd = upstream.headers.get("content-disposition");
      if (cd) passthroughHeaders.set("content-disposition", cd);

      return new Response(upstream.body, {
        status: upstream.status,
        headers: passthroughHeaders,
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders(origin) });
  },
};

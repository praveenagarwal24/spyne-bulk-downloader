/**
 * Cloudflare Worker: Spyne bulk-download CORS proxy.
 *
 * Deploy this if your GitHub Pages site can't call api.spyne.ai directly because
 * Spyne's CORS only accepts origin=https://console.spyne.ai.
 *
 * Setup:
 *   1. https://workers.cloudflare.com → Create a Worker → paste this file.
 *   2. Save & Deploy. Note the Worker URL (e.g. spyne-proxy.<you>.workers.dev).
 *   3. Optionally lock down the ALLOWED_ORIGINS array below to your GitHub Pages URL.
 *   4. In the UI, point the API_URL constant in app.js at the Worker URL instead
 *      of "https://api.spyne.ai/medias/bulk-download".
 *
 * The Worker forwards the request to Spyne, sets the required Origin/Referer,
 * and adds permissive CORS headers on the response.
 */

const SPYNE_API = "https://api.spyne.ai/medias/bulk-download";

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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, accept",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return new Response("Use POST", { status: 405, headers: corsHeaders(origin) });
    }

    const body = await request.text();

    // Forward to Spyne with the headers their API expects.
    const upstream = await fetch(SPYNE_API, {
      method: "POST",
      headers: {
        "accept": "application/json, text/plain, */*",
        "authorization": request.headers.get("authorization") || "",
        "content-type": "application/json",
        "origin": "https://console.spyne.ai",
        "referer": "https://console.spyne.ai/",
        "user-agent": request.headers.get("user-agent") || "spyne-bulk-downloader-proxy",
      },
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
  },
};

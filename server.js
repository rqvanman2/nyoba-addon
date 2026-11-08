// BitChord addon — Internet Archive FLAC (lossless, legal catalogue)
// Protocol: https://bitchord.kushagrasingh.in/docs
//   GET /manifest.json   addon identity + capabilities
//   GET /search?q=...    { tracks: [...] }
//   GET /stream/:id     { url, codec, ... }   (404 = "not in this addon")
//   GET /health         liveness
//   GET /               human-readable info page
//
// What it serves: only files that are already free on archive.org —
// live recordings (etree), netlabels, public-domain / Creative Commons
// audio, in real FLAC. No mainstream commercial catalogue: if a song
// isn't on the Internet Archive, BitChord falls through to YouTube Music.
//
// No dependencies. Node 18.17+ (uses the global fetch).
// Run:  PORT=8787 node server.js
// Add in BitChord: Settings -> Sources -> Add an addon ->
//   https://<your-host>/manifest.json

const http = require("node:http");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const SEARCH_ROWS = 20; // IA candidates per query
const MAX_TRACKS = 10; // tracks returned to BitChord
const FETCH_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 10 * 60 * 1000; // BitChord caches searches 10 min too

const MANIFEST = {
  id: "dev.muse.bitchord-ia-flac",
  name: "Internet Archive FLAC",
  version: "1.0.0",
  resources: ["search", "stream"],
  allowDownloads: 1,
  settings: [
    {
      key: "quality",
      type: "select",
      default: "lossless",
      options: [
        { label: "Lossless", value: "lossless" },
        { label: "High", value: "high" },
        { label: "Low", value: "low" },
      ],
    },
  ],
};

// ---------------------------------------------------------------- cache
const cache = new Map(); // key -> { ts, value }
function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.value;
  cache.delete(key);
  return undefined;
}
function cacheSet(key, value) {
  cache.set(key, { ts: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
}

// -------------------------------------------------------------- helpers
async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "bitchord-ia-flac-addon/1.0 (+https://archive.org)",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// Escape a user query for the archive.org Lucene-style search syntax.
function escapeLucene(s) {
  return s.replace(/([+\-=&|><!(){}[\]^"~*?:\\/])/g, "\\$1");
}

// IA file "length" is usually "m:ss" or seconds as a string.
function parseDuration(str) {
  if (str == null) return undefined;
  const s = String(str).trim();
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const m = s.match(/^(?:(\d+):)?([0-5]?\d):([0-5]\d(?:\.\d+)?)$/);
  if (m) return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return undefined;
}

function asString(v) {
  if (v == null) return undefined;
  return Array.isArray(v) ? v.join(", ") : String(v);
}

// Track ids are base64url("identifier/filename") — opaque and URL-safe.
function encodeTrackId(identifier, filename) {
  return Buffer.from(`${identifier}/${filename}`, "utf8").toString("base64url");
}
function decodeTrackId(id) {
  const decoded = Buffer.from(id, "base64url").toString("utf8");
  const slash = decoded.indexOf("/");
  if (slash <= 0) throw new Error("bad id");
  const identifier = decoded.slice(0, slash);
  const filename = decoded.slice(slash + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier)) throw new Error("bad identifier");
  if (!filename.toLowerCase().endsWith(".flac") || filename.includes("..")) {
    throw new Error("bad filename");
  }
  return { identifier, filename };
}

function encodePath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

// ------------------------------------------------------- Internet Archive
async function getItem(identifier) {
  const key = "meta:" + identifier;
  const hit = cacheGet(key);
  if (hit) return hit;
  const data = await fetchJson(
    `https://archive.org/metadata/${encodeURIComponent(identifier)}`
  );
  cacheSet(key, data);
  return data;
}

function pickFlacFile(meta, wantedName) {
  const files = (meta && meta.files) || [];
  return files.find((f) => {
    const name = String(f.name || "");
    if (!name.toLowerCase().endsWith(".flac")) return false;
    if (String(f.format || "").toLowerCase() !== "flac") return false;
    if (wantedName && name !== wantedName) return false;
    return true;
  });
}

async function searchArchive(q) {
  const cached = cacheGet("search:" + q);
  if (cached) return cached;

  // Require every word of the query to appear (loose OR matches junk).
  const terms = q
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeLucene)
    .join(" AND ");
  const params = new URLSearchParams();
  params.set("q", `(${terms}) AND mediatype:audio AND format:Flac`);
  params.append("fl[]", "identifier");
  params.append("fl[]", "title");
  params.append("fl[]", "creator");
  params.set("rows", String(SEARCH_ROWS));
  params.set("output", "json");

  const found = await fetchJson(
    `https://archive.org/advancedsearch.php?${params.toString()}`
  );
  const docs = (found && found.response && found.response.docs) || [];

  // Resolve each candidate to its FLAC file (in parallel, best-effort).
  const settled = await Promise.allSettled(
    docs.map(async (doc) => {
      const meta = await getItem(doc.identifier);
      const file = pickFlacFile(meta);
      if (!file) return null;
      const md = meta.metadata || {};
      const showTitle = asString(md.title);
      const trackTitle = asString(file.title) || showTitle || file.name;
      return {
        id: encodeTrackId(doc.identifier, file.name),
        title: trackTitle,
        artist: asString(file.artist) || asString(md.creator),
        // The show / release the recording belongs to — much more useful
        // than the raw collection codes ("opensource_audio", ...).
        album: trackTitle !== showTitle ? showTitle : undefined,
        duration: parseDuration(file.length),
        artworkURL: `https://archive.org/services/img/${doc.identifier}`,
        format: "flac",
        audioQuality: "LOSSLESS",
      };
    })
  );

  const tracks = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) {
      tracks.push(r.value);
      if (tracks.length >= MAX_TRACKS) break;
    }
  }
  cacheSet("search:" + q, tracks);
  return tracks;
}

// ---------------------------------------------------------------- routes
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

const INFO_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Internet Archive FLAC — BitChord addon</title></head>
<body style="font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6">
<h1>Internet Archive FLAC</h1>
<p>A BitChord addon serving real lossless FLAC from the Internet Archive
(live recordings, netlabels, public-domain / Creative Commons audio).</p>
<p>Add it in BitChord: <b>Settings &rarr; Sources &rarr; Add an addon</b>, then paste:</p>
<p><code id="u"></code></p>
<script>document.getElementById("u").textContent = location.origin + "/manifest.json";</script>
<p><a href="/manifest.json">manifest.json</a> &middot; <a href="/health">health</a></p>
</body></html>`;

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const started = Date.now();
  try {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });

    if (url.pathname === "/manifest.json") return sendJson(res, 200, MANIFEST);

    if (url.pathname === "/health") {
      return sendJson(res, 200, {
        status: "ok",
        uptimeSeconds: Math.round(process.uptime()),
        cacheEntries: cache.size,
      });
    }

    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(INFO_PAGE);
    }

    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return sendJson(res, 200, { tracks: [] });
      const tracks = await searchArchive(q);
      return sendJson(res, 200, { tracks });
    }

    if (url.pathname.startsWith("/stream/")) {
      const id = decodeURIComponent(url.pathname.slice("/stream/".length));
      let parts;
      try {
        parts = decodeTrackId(id);
      } catch {
        return sendJson(res, 404, { error: "not_found" });
      }
      let meta;
      try {
        meta = await getItem(parts.identifier);
      } catch {
        return sendJson(res, 404, { error: "not_found" });
      }
      const file = pickFlacFile(meta, parts.filename);
      if (!file) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, {
        url: `https://archive.org/download/${encodeURIComponent(parts.identifier)}/${encodePath(parts.filename)}`,
        codec: "flac",
        container: "flac",
        manifest: "none",
        encrypted: false,
      });
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    console.error("error", url.pathname, err.message);
    return sendJson(res, 502, { error: "upstream_error" });
  } finally {
    console.log(
      new Date().toISOString(),
      req.method,
      url.pathname,
      `${Date.now() - started}ms`
    );
  }
}

http.createServer(handle).listen(PORT, HOST, () => {
  console.log(`Internet Archive FLAC addon listening on http://${HOST}:${PORT}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
});

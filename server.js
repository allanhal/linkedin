import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { fetchProfile, profileFromText, FetchError } from "./lib/linkedin.js";
import { recommend } from "./lib/optimize.js";
import { profileToState, QUESTIONS } from "./lib/jev.js";

const PORT = Number(process.env.PORT || 3333);
const HOST = process.env.HOST || "127.0.0.1";
const app = express();
const dir = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = process.env.MODELS_DIR || path.join(dir, "models");

// Cross-origin isolation lets the in-browser engine use multithreaded WASM (SharedArrayBuffer).
// "credentialless" (not "require-corp") so LinkedIn profile photos still load.
app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  next();
});
app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(dir, "public")));
app.use("/vendor/pdfjs", express.static(path.join(dir, "node_modules/pdfjs-dist/build"), { maxAge: "7d" }));
app.use("/vendor/wllama", express.static(path.join(dir, "node_modules/@wllama/wllama/esm"), { maxAge: "7d" }));
app.use("/models", express.static(MODELS_DIR, { maxAge: "30d", immutable: true, index: false }));

// ── model catalog ───────────────────────────────────────────────
// models.json lists the GGUFs the browser can run. For each entry the browser downloads:
//   1. MODELS_DIR/<file> served at /models/… when the file exists locally, else
//   2. https://huggingface.co/<hf>/resolve/main/<file> (public repos need no key and send CORS), else
//   3. `url` (any CORS-enabled host, e.g. GitHub Pages).
// Split models (`name-00001-of-0000N.gguf`) list the first shard; wllama fetches the rest.
// `parts: N` means the remote file is byte-chunked as <url>.part000 … (for hosts with a
// per-file size limit, like GitHub's 100 MB); the browser joins the chunks before loading.
const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/;

function shardNames(file) {
  const m = file.match(SHARD);
  if (!m) return [file];
  const n = Number(m[2]);
  return Array.from({ length: n }, (_, i) => file.replace(SHARD, `-${String(i + 1).padStart(5, "0")}-of-${m[2]}.gguf`));
}

function loadCatalog() {
  const entries = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"));
  return entries.map((m) => {
    const names = shardNames(m.file || new URL(m.url).pathname.split("/").pop());
    const local = names.map((n) => path.join(MODELS_DIR, n));
    if (m.file && local.every((f) => fs.existsSync(f))) {
      const bytes = local.reduce((sum, f) => sum + fs.statSync(f).size, 0);
      return { ...m, source: "local", files: names.map((n) => `/models/${encodeURIComponent(n)}`), bytes, available: true };
    }
    const remote = m.hf ? `https://huggingface.co/${m.hf}/resolve/main/${m.file}` : m.url;
    if (remote && m.parts) {
      const files = Array.from({ length: m.parts }, (_, i) => `${remote}.part${String(i).padStart(3, "0")}`);
      return { ...m, source: "url", files, chunked: true, bytes: m.bytes ?? null, available: true };
    }
    if (remote) {
      const base = remote.slice(0, remote.lastIndexOf("/") + 1);
      return { ...m, source: m.hf ? "huggingface" : "url", files: names.map((n) => base + encodeURIComponent(n)), bytes: m.bytes ?? null, available: true };
    }
    return { ...m, files: [], bytes: null, available: false };
  });
}

// small in-memory cache so re-analysing doesn't re-hit LinkedIn
const cache = new Map();
const CACHE_MS = 30 * 60_000;

app.get("/api/config", (_req, res) => {
  res.json({ questions: QUESTIONS, models: loadCatalog() });
});

app.post("/api/profile", async (req, res) => {
  try {
    const { url, text, name, headline, location, source } = req.body || {};
    if (text) return res.json(profileFromText(text, { name, headline, location, source }));
    const key = String(url || "").trim().toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < CACHE_MS) return res.json({ ...hit.p, cached: true });
    const p = await fetchProfile(url);
    cache.set(key, { t: Date.now(), p });
    res.json(p);
  } catch (e) {
    const status = e instanceof FetchError ? e.status : 500;
    res.status(status).json({ error: e.message, code: e.code || "error" });
  }
});

// The browser engine uses these so state format and rules live in one place.
app.post("/api/state", (req, res) => {
  const { profile, maxChars } = req.body || {};
  if (!profile?.name) return res.status(400).json({ error: "profile required" });
  res.json({ state: profileToState(profile, maxChars) });
});
app.post("/api/recommend", (req, res) => {
  const { profile, answers } = req.body || {};
  if (!profile?.name || !answers) return res.status(400).json({ error: "profile and answers required" });
  res.json(recommend(profile, answers));
});

app.listen(PORT, HOST, () => {
  console.log(`LinkedIn Analyser → http://${HOST}:${PORT}`);
  for (const m of loadCatalog()) {
    console.log(`  ${m.available ? "✓" : "✗"} ${m.name} ${m.quant}  ${m.available ? `(${m.source}: ${m.files[0]})` : `(missing ${m.file} in ${MODELS_DIR}, and no "hf"/"url" set)`}`);
  }
});

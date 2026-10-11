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
app.use("/vendor/wllama", express.static(path.join(dir, "node_modules/@wllama/wllama/esm"), { maxAge: "7d" }));
app.use("/models", express.static(MODELS_DIR, { maxAge: "30d", immutable: true, index: false }));

// ── model catalog ───────────────────────────────────────────────
// models.json lists the GGUFs the browser can run. Each entry is either a file in
// MODELS_DIR (served at /models/…) or a remote `url` (CDN / Hugging Face, must allow CORS).
// Split models (`name-00001-of-0000N.gguf`) list the first shard; wllama fetches the rest.
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
    const names = shardNames(m.url ? new URL(m.url).pathname.split("/").pop() : m.file);
    if (m.url) {
      const base = m.url.slice(0, m.url.lastIndexOf("/") + 1);
      return { ...m, files: names.map((n) => base + n), bytes: m.bytes ?? null, available: true };
    }
    const local = names.map((n) => path.join(MODELS_DIR, n));
    const available = local.every((f) => fs.existsSync(f));
    const bytes = available ? local.reduce((sum, f) => sum + fs.statSync(f).size, 0) : null;
    return { ...m, files: names.map((n) => `/models/${encodeURIComponent(n)}`), bytes, available };
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
    const { url, text } = req.body || {};
    if (text) return res.json(profileFromText(text));
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
    console.log(`  ${m.available ? "✓" : "✗"} ${m.name} ${m.quant}${m.available ? "" : `  (missing ${m.file} in ${MODELS_DIR})`}`);
  }
});

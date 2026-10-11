const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
const human = (k) => String(k).replace(/_/g, " ");

let QUESTIONS = {};
let MODELS = [];
let selectedId = null;
let cached = {}; // model id → { complete, bytes } in browser storage
let decider = null; // loaded BrowserDecider
let engine = null; // lazily imported browser-engine.js module
let busyModel = null; // id being downloaded/removed
let source = null; // "pdf" | "url" | "text": which input Analyse uses
let pdfProfile = null; // { text, name, headline, location } read from an uploaded PDF
let ctrl = null;
let lastRecs = null;
const answers = {};

const loadEngine = async () => (engine ??= await import("./browser-engine.js"));
const selected = () => MODELS.find((m) => m.id === selectedId);

/* ── boot ─────────────────────────────────────────────────────── */
async function boot() {
  try {
    $("#url").value = localStorage.getItem("lia-url") || "";
    if ($("#url").value) setSource("url");
  } catch {}
  try {
    const cfg = await (await fetch("/api/config")).json();
    QUESTIONS = cfg.questions;
    MODELS = cfg.models.filter((m) => m.available);
    let saved = null;
    try { saved = localStorage.getItem("lia-model"); } catch {}
    selectedId = (MODELS.find((m) => m.id === saved) || MODELS.find((m) => m.default) || MODELS[0])?.id ?? null;
    renderModels();
    updateEtaHint();
    const gpu = "gpu" in navigator;
    $("#status").className = MODELS.length ? "status ok" : "status err";
    $("#statusText").textContent = MODELS.length
      ? `Runs in your browser · ${gpu ? "WebGPU" : "CPU (WASM)"}${crossOriginIsolated ? "" : " · single-thread"}`
      : "No models configured";
    await refreshCache();
  } catch (e) {
    $("#status").className = "status err";
    $("#statusText").textContent = "Server unreachable";
  }
}

/* ── model manager ────────────────────────────────────────────── */
async function refreshCache() {
  try {
    const { cachedModels } = await loadEngine();
    cached = await cachedModels(MODELS);
  } catch {
    cached = {};
  }
  renderModels();
  try {
    const est = await navigator.storage?.estimate?.();
    $("#storage").textContent = est ? `Browser storage: ${mb(est.usage || 0)} used of ${mb(est.quota || 0)} available` : "";
  } catch {}
}

function renderModels() {
  $("#models").innerHTML = MODELS.map((m) => {
    const c = cached[m.id];
    const state = busyModel === m.id ? `<span class="mstate busy" id="mprog-${esc(m.id)}">Working…</span>`
      : c?.complete ? `<span class="mstate ok">Downloaded</span>`
      : c?.bytes ? `<span class="mstate part">Partly downloaded</span>`
      : `<span class="mstate">Not downloaded</span>`;
    const loaded = decider?.model.id === m.id && decider.wllama ? ` <span class="mstate ok">In memory</span>` : "";
    return `<label class="model-row ${m.id === selectedId ? "sel" : ""}">
      <input type="radio" name="model" value="${esc(m.id)}" ${m.id === selectedId ? "checked" : ""} />
      <span class="minfo">
        <span><strong>${esc(m.name)}</strong> <span class="quant">${esc(m.quant)}</span> <span class="muted">${m.bytes ? mb(m.bytes) : ""}</span></span>
        <small class="muted">${esc(m.notes || "")}</small>
      </span>
      <span class="mside">${state}${loaded}
        ${c?.complete || busyModel === m.id ? "" : `<button type="button" class="ghost small" data-act="download" data-id="${esc(m.id)}">Download</button>`}
        ${c?.bytes && busyModel !== m.id ? `<button type="button" class="ghost small danger" data-act="remove" data-id="${esc(m.id)}">Remove</button>` : ""}
      </span>
    </label>`;
  }).join("") || `<p class="muted">No models available. Add GGUF files to <code>models/</code> or set a Hugging Face repo in <code>models.json</code>.</p>`;
}

$("#models").addEventListener("change", (e) => {
  if (e.target.name !== "model") return;
  selectedId = e.target.value;
  try { localStorage.setItem("lia-model", selectedId); } catch {}
  renderModels();
  updateEtaHint();
});

$("#models").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  e.preventDefault();
  const m = MODELS.find((x) => x.id === btn.dataset.id);
  if (!m || busyModel) return;
  const { downloadModel, removeModel } = await loadEngine();
  if (btn.dataset.act === "remove") {
    const ok = await confirmModal({
      title: `Remove ${m.name} ${m.quant}?`,
      message: `This deletes the downloaded model${m.bytes ? ` (${mb(m.bytes)})` : ""} from this browser. You can download it again later.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    busyModel = m.id;
    renderModels();
    try {
      if (decider?.model.id === m.id) { await decider.unload(); decider = null; }
      await removeModel(m);
    } catch (err) {
      showError("Could not remove model: " + err.message);
    }
  } else {
    busyModel = m.id;
    renderModels();
    const t = performance.now();
    try {
      await downloadModel(m, ({ loaded, total }) => {
        const el = document.getElementById(`mprog-${m.id}`);
        const rate = loaded / Math.max(0.1, (performance.now() - t) / 1000);
        if (el) el.textContent = `${mb(loaded)} / ${mb(total)}${total > loaded && rate ? ` · ~${fmtS((total - loaded) / rate)}` : ""}`;
      });
    } catch (err) {
      showError("Download failed: " + friendlyError(err));
    }
  }
  busyModel = null;
  await refreshCache();
});

/* ── input source ─────────────────────────────────────────────── */
// All three inputs are on screen; the one filled in or edited last is analysed (and highlighted).
function setSource(src) {
  source = src;
  document.querySelectorAll(".src").forEach((el) => el.classList.toggle("active", el.dataset.src === src));
}
$("#url").addEventListener("input", () => setSource($("#url").value.trim() ? "url" : pdfProfile ? "pdf" : $("#text").value.trim() ? "text" : null));
$("#text").addEventListener("input", () => setSource($("#text").value.trim() ? "text" : pdfProfile ? "pdf" : $("#url").value.trim() ? "url" : null));
$("#url").addEventListener("focus", () => $("#url").value.trim() && setSource("url"));
$("#text").addEventListener("focus", () => $("#text").value.trim() && setSource("text"));

/* ── time estimates ───────────────────────────────────────────── */
// Remembers measured seconds-per-question per model (moving average), so the next
// run can be estimated up front. Live ETA during a run uses the current run's pace.
const mb = (b) => `${Math.round(b / 1048576)} MB`;
const fmtS = (s) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);
const speedKey = (m) => `lia-speed:${m}`;
function getSpeed(model) {
  try { return Number(localStorage.getItem(speedKey(model))) || null; } catch { return null; }
}
function saveSpeed(model, secPerQ) {
  const prev = getSpeed(model);
  try { localStorage.setItem(speedKey(model), String(prev ? prev * 0.5 + secPerQ * 0.5 : secPerQ)); } catch {}
}
function updateEtaHint() {
  const m = selected();
  const n = Object.keys(QUESTIONS).length;
  const sp = m && getSpeed(m.id);
  let hint = "";
  if (sp) hint = `≈ ${fmtS(sp * n)} per analysis with ${m.name} ${m.quant} (measured on this device)`;
  else if (m) hint = `${n} questions · time is estimated after the first run on this device`;
  $("#etaHint").textContent = hint;
}

/** Turns model-download failures into something actionable. */
function friendlyError(err) {
  const msg = err?.message || String(err);
  const m = msg.match(/(https:\/\/huggingface\.co\/[^/]+\/[^/]+)\/resolve\/[^:]*: HTTP (401|403|404)/);
  if (m) return `Model file not found on Hugging Face (${m[1]} returned ${m[2]}). The repo doesn't exist yet, is private, or is missing this file. Upload the GGUFs to a public repo or serve them from models/.`;
  return msg;
}

function showError(msg, suggestPdf) {
  const el = $("#error");
  el.innerHTML = esc(msg) + (suggestPdf ? ` <a href="#" id="toPdf">Upload the profile's PDF instead →</a>` : "");
  el.classList.remove("hidden");
  $("#toPdf")?.addEventListener("click", (e) => { e.preventDefault(); $("#drop").scrollIntoView({ behavior: "smooth", block: "center" }); $("#pdf").click(); });
}

/* ── modal ────────────────────────────────────────────────────── */
// In-page replacement for confirm(): resolves true on confirm, false on cancel/Escape/backdrop.
function confirmModal({ title, message, confirmLabel = "OK", cancelLabel = "Cancel", danger = false }) {
  const dlg = $("#modal");
  $("#modalTitle").textContent = title;
  $("#modalMessage").textContent = message;
  const ok = $("#modalOk");
  ok.textContent = confirmLabel;
  ok.classList.toggle("danger-solid", danger);
  $("#modalCancel").textContent = cancelLabel;
  return new Promise((resolve) => {
    const done = (v) => {
      dlg.removeEventListener("close", onClose);
      dlg.removeEventListener("click", onBackdrop);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const onClose = () => done(dlg.returnValue === "ok");
    const onBackdrop = (e) => { if (e.target === dlg) done(false); };
    dlg.returnValue = "";
    dlg.addEventListener("close", onClose);
    dlg.addEventListener("click", onBackdrop);
    dlg.showModal();
    $("#modalCancel").focus();
  });
}

/* ── PDF upload ───────────────────────────────────────────────── */
async function handlePdf(file) {
  if (!file) return;
  $("#error").classList.add("hidden");
  pdfProfile = null;
  $("#dropText").innerHTML = `<strong>Reading ${esc(file.name)}…</strong>`;
  try {
    const { readProfilePdf } = await import("./pdf-import.js");
    pdfProfile = await readProfilePdf(file);
    $("#dropText").innerHTML = `<strong>${esc(pdfProfile.name || file.name)}</strong>${pdfProfile.headline ? ` · ${esc(pdfProfile.headline)}` : ""}<br />
      <span class="muted">${pdfProfile.pages} page${pdfProfile.pages > 1 ? "s" : ""} · ${pdfProfile.text.length.toLocaleString()} characters read · press Analyse, or choose another file</span>`;
    $("#drop").classList.add("ready");
    setSource("pdf");
  } catch (err) {
    $("#drop").classList.remove("ready");
    $("#dropText").innerHTML = `<strong>Choose or drop a LinkedIn PDF</strong>`;
    showError("Could not read PDF: " + (err.message || err));
  }
}
$("#pdf").addEventListener("change", (e) => handlePdf(e.target.files[0]));

// Drop a PDF anywhere on the page to read it.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
const showOverlay = (on) => $("#dropOverlay").classList.toggle("hidden", !on);
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  showOverlay(true);
});
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) showOverlay(false);
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  showOverlay(false);
  const file = [...e.dataTransfer.files].find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (!file) return showError("That isn't a PDF. Drop the file from LinkedIn's More → Save to PDF.");
  handlePdf(file);
});

/* ── main flow ────────────────────────────────────────────────── */
$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#error").classList.add("hidden");
  if (!selected()) return showError("No model available yet: add one to models.json (local file or Hugging Face repo).");
  const src = source || (pdfProfile ? "pdf" : $("#text").value.trim() ? "text" : $("#url").value.trim() ? "url" : null);
  if (!src) return showError("Drop a LinkedIn PDF, enter a profile link, or paste the profile text.");
  setSource(src);
  const body =
    src === "url" ? { url: $("#url").value.trim() }
    : src === "pdf" ? { text: pdfProfile.text, name: pdfProfile.name, headline: pdfProfile.headline, location: pdfProfile.location, source: "pdf" }
    : { text: $("#text").value };
  if (src === "url") try { localStorage.setItem("lia-url", body.url); } catch {}

  setBusy(true, "Fetching profile…");
  let profile;
  try {
    const r = await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) {
      setBusy(false);
      return showError(j.error, ["authwall", "rate_limited", "unparseable"].includes(j.code));
    }
    profile = j;
  } catch (err) {
    setBusy(false);
    return showError("Request failed: " + err.message);
  }

  renderProfile(profile);
  resetAnalysis();
  $("#results").classList.remove("hidden");
  await runAnalysis(profile);
});

$("#stop").addEventListener("click", () => ctrl?.abort());

function setBusy(on, label) {
  $("#go").disabled = on;
  $("#go").textContent = on ? (label || "Working…") : "Analyse";
  $("#stop").classList.toggle("hidden", !on);
}

async function runAnalysis(profile) {
  const keys = Object.keys(QUESTIONS);
  const model = selected();
  const est = getSpeed(model.id);
  let done = 0;
  let firstAnswerAt = 0;
  ctrl = new AbortController();
  setBusy(true, "Analysing…");
  const t0 = performance.now();
  $("#progressText").textContent = est ? `Starting · estimated ${fmtS(est * keys.length)}` : "Starting…";

  const onEvent = (ev) => {
    if (ev.type === "state") $("#state").textContent = ev.state;
    else if (ev.type === "recommendations") renderRecs(ev);
    else if (ev.type === "progress") $("#progressText").textContent = ev.text;
    else if (ev.type === "answer") {
      answers[ev.key] = ev.answer;
      done++;
      if (done === 1) firstAnswerAt = performance.now();
      renderQuestion(ev.key, ev.answer);
      $("#bar").style.width = pct(done / keys.length);
      // pace after the first answer (which includes warm-up), falling back to the stored speed
      const pace = done > 1 ? (performance.now() - firstAnswerAt) / 1000 / (done - 1) : est || ev.ms / 1000;
      const left = (keys.length - done) * pace;
      $("#progressText").textContent = `${done}/${keys.length} · ${QUESTIONS[ev.key].label} (${ev.ms} ms)${done < keys.length ? ` · ~${fmtS(left)} left` : ""}`;
      renderSummary();
    } else if (ev.type === "error") throw new Error(ev.error);
  };

  try {
    await runInBrowser(profile, model, onEvent, ctrl.signal);
    const total = (performance.now() - t0) / 1000;
    const analysed = firstAnswerAt ? (performance.now() - firstAnswerAt) / 1000 / Math.max(1, keys.length - 1) : total / keys.length;
    saveSpeed(model.id, analysed);
    updateEtaHint();
    $("#bar").style.width = "100%";
    $("#progressText").textContent = `Done · ${keys.length} questions in ${fmtS(total)} with ${model.name} ${model.quant}${decider?.backend ? ` (${decider.backend})` : ""}`;
  } catch (err) {
    if (err.name === "AbortError" || ctrl?.signal.aborted) $("#progressText").textContent = `Stopped after ${done}/${keys.length}`;
    else { showError("Analysis failed: " + friendlyError(err)); $("#progressText").textContent = "Failed"; }
  } finally {
    $("#raw").textContent = JSON.stringify(answers, null, 2);
    setBusy(false);
    ctrl = null;
    refreshCache();
  }
}

/** tev1 running locally in the page via wllama (WebGPU/WASM). */
async function runInBrowser(profile, model, onEvent, signal) {
  const post = async (url, body) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
  if (decider && decider.model.id !== model.id) {
    await decider.unload(); // one model in memory at a time
    decider = null;
  }
  if (!decider) {
    const { BrowserDecider } = await loadEngine();
    decider = new BrowserDecider(model);
  }
  if (!decider.wllama) {
    const t = performance.now();
    let lastPct = -1;
    await decider.load(({ loaded, total }) => {
      const p = total ? loaded / total : 0;
      if (Math.round(p * 100) === lastPct) return;
      lastPct = Math.round(p * 100);
      $("#bar").style.width = pct(p);
      const rate = loaded / Math.max(0.1, (performance.now() - t) / 1000);
      const left = total && rate ? (total - loaded) / rate : 0;
      onEvent({ type: "progress", text: `Loading model ${mb(loaded)} / ${total ? mb(total) : "?"}${left > 1 ? ` · ~${fmtS(left)} left` : ""} ${cached[model.id]?.complete ? "" : " (saved in this browser for next time)"}` });
    });
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    $("#bar").style.width = "0";
    onEvent({ type: "progress", text: `Model ready (${decider.backend}) · analysing…` });
  }

  let { state } = await post("/api/state", { profile });
  onEvent({ type: "state", state });
  const got = {};
  for (const [key, q] of Object.entries(QUESTIONS)) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const t = performance.now();
    const { group, label, ...wire } = q;
    const out = await decider.ask(state, key, wire, signal);
    state = out.state; // keep any shrink for later questions
    got[key] = out.answer;
    onEvent({ type: "answer", key, question: q, answer: out.answer, usage: out.usage, ms: Math.round(performance.now() - t) });
  }
  onEvent({ type: "recommendations", ...(await post("/api/recommend", { profile, answers: got })) });
}

/* ── rendering ────────────────────────────────────────────────── */
function renderProfile(p) {
  const initials = (p.name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("");
  const sec = (key, label) => {
    const s = p.sections?.[key];
    if (!s?.items?.length) return "";
    return `<h3>${esc(label || s.title)}</h3><ul>${s.items
      .slice(0, 8)
      .map((i) => `<li>${esc(i.title)}${i.subtitle ? ` · <span class="muted">${esc(i.subtitle)}</span>` : ""}${i.dates ? `<small>${esc(i.dates)}</small>` : ""}</li>`)
      .join("")}</ul>`;
  };
  const others = Object.keys(p.sections || {}).filter((k) => k !== "experience" && k !== "education");
  $("#profile").innerHTML = `
    <div class="cover"></div>
    <div class="body">
      <div class="avatar" ${p.photo ? `style="background-image:url('${esc(p.photo)}')"` : ""}>${p.photo ? "" : esc(initials)}</div>
      <h2>${esc(p.name)}</h2>
      <p class="headline">${esc(p.headline)}</p>
      <div class="meta">${[p.location, p.followers && p.followers + " followers", p.connections && p.connections + " connections"].filter(Boolean).map(esc).join(" · ")}</div>
      ${p.url ? `<div class="meta"><a href="${esc(p.url)}" target="_blank" rel="noopener">View on LinkedIn ↗</a>${p.cached ? " · cached" : ""}</div>` : `<div class="meta">${p.source === "pdf" ? "From uploaded PDF" : "From pasted text"}</div>`}
      ${p.about ? `<h3>About</h3><div class="about">${esc(p.about)}</div>` : ""}
      ${sec("experience")}
      ${sec("education")}
      ${others.map((k) => sec(k)).join("")}
    </div>`;
}

function resetAnalysis() {
  for (const k of Object.keys(answers)) delete answers[k];
  $("#bar").style.width = "0";
  $("#chips").innerHTML = "";
  $("#overall").textContent = "–";
  $("#ringFg").style.strokeDashoffset = 326.7;
  $("#state").textContent = "";
  $("#raw").textContent = "";
  for (const g of ["Profile", "Quality", "Signals", "Optimize"]) $(`#g-${g}`).innerHTML = "";
  $("#recs").innerHTML = `<li class="muted">Recommendations appear when the analysis finishes.</li>`;
  $("#passed").innerHTML = "";
  $("#passedCount").textContent = "";
  $("#copyRecs").classList.add("hidden");
  lastRecs = null;
  for (const [k, q] of Object.entries(QUESTIONS)) {
    const el = document.createElement("div");
    el.className = "q pending";
    el.id = `q-${k}`;
    el.innerHTML = `<div class="row"><span class="label">${esc(q.label)}</span><span class="conf">…</span></div>`;
    $(`#g-${q.group}`).appendChild(el);
  }
}

const tone = (x) => (x >= 0.67 ? "var(--good)" : x >= 0.34 ? "var(--warn)" : "var(--bad)");

function renderQuestion(key, a) {
  const q = QUESTIONS[key];
  const el = $(`#q-${key}`);
  if (!el || !a) return;
  el.classList.remove("pending");
  el.title = q.instructions;

  if (a.type === "choice") {
    const probs = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]).slice(0, 4);
    el.innerHTML = `
      <div class="row"><span class="label">${esc(q.label)}</span><span class="val">${esc(human(a.choice))}</span></div>
      <div class="bars">${probs
        .map(([name, p], i) => `<div class="bar ${i === 0 ? "lead" : ""}"><span class="name" title="${esc(q.criteria[name] || "")}">${esc(human(name))}</span><span class="track"><span class="fill" style="width:${pct(p)}"></span></span><span class="pct">${pct(p)}</span></div>`)
        .join("")}</div>
      <div class="conf">confidence ${pct(a.confidence)}</div>`;
  } else if (a.type === "score") {
    const levels = q.criteria.length - 1;
    const norm = a.score / levels;
    const top = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1])[0]?.[0];
    el.innerHTML = `
      <div class="row"><span class="label">${esc(q.label)}</span><span class="val" style="color:${tone(norm)}">${esc(a.legend?.[top] ?? q.criteria[top])} · ${a.score.toFixed(1)}/${levels}</span></div>
      <div class="scale">${q.criteria
        .map((_, i) => `<span style="background:${(a.probabilities?.[i] ?? 0) > 0 ? tone(norm) : "var(--track)"};opacity:${0.15 + 0.85 * (a.probabilities?.[i] ?? 0)}"></span>`)
        .join("")}</div>
      <div class="scale-legend"><span>${esc(q.criteria[0])}</span><span>${esc(q.criteria[levels])}</span></div>
      <div class="conf">confidence ${pct(a.confidence)}</div>`;
  } else {
    const v = a.noul ?? 0.5;
    const word = v >= 0.7 ? "Yes" : v <= 0.3 ? "No" : "Unsure";
    el.innerHTML = `
      <div class="row"><span class="label">${esc(q.label)}</span><span class="val" style="color:${v >= 0.7 ? "var(--good)" : v <= 0.3 ? "var(--muted)" : "var(--warn)"}">${word} · ${pct(v)}</span></div>
      <div class="meter"><span class="fill" style="width:${pct(v)};background:${v >= 0.7 ? "var(--good)" : v <= 0.3 ? "var(--muted)" : "var(--warn)"}"></span></div>`;
  }
}

function renderSummary() {
  // overall = mean of normalised quality scores
  const scores = Object.entries(QUESTIONS)
    .filter(([k, q]) => q.type === "score" && answers[k])
    .map(([k, q]) => answers[k].score / (q.criteria.length - 1));
  if (scores.length) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    $("#overall").textContent = Math.round(avg * 100);
    const fg = $("#ringFg");
    fg.style.strokeDashoffset = 326.7 * (1 - avg);
    fg.style.stroke = tone(avg);
  }
  const chips = [];
  for (const [k, q] of Object.entries(QUESTIONS)) {
    const a = answers[k];
    if (!a) continue;
    if (a.type === "choice") chips.push(human(a.choice));
    if (a.type === "noul" && q.group === "Signals" && a.noul >= 0.7) chips.push(q.label);
  }
  $("#chips").innerHTML = chips.map((c) => `<span class="chip">${esc(c)}</span>`).join("");
}

function renderRecs({ items, passed }) {
  lastRecs = items;
  $("#recs").innerHTML = items.length
    ? items
        .map((r) => `<li class="rec">
          <div class="tags"><span class="prio ${r.priority}">${r.priority}</span><span class="area">${esc(r.area)}</span></div>
          <div class="fix">${esc(r.fix)}</div>
          <div class="evidence">${esc(r.evidence)}</div>
        </li>`)
        .join("")
    : `<li class="muted">Nothing major to fix. This profile passes every check.</li>`;
  $("#passed").innerHTML = passed.length ? `<div>Passed:</div>` + passed.map((r) => `<span>${esc(r.area)}: ${esc(r.id.replace(/_/g, " "))}</span>`).join("") : "";
  $("#passedCount").textContent = `· ${items.length} to fix, ${passed.length} passed`;
  $("#copyRecs").classList.toggle("hidden", !items.length);
}

$("#copyRecs").addEventListener("click", async () => {
  if (!lastRecs) return;
  const name = $("#profile h2")?.textContent || "Profile";
  const md = `# LinkedIn optimization: ${name}\n\n` + lastRecs.map((r) => `- [ ] **[${r.priority.toUpperCase()} · ${r.area}]** ${r.fix}\n  _${r.evidence}_`).join("\n");
  try {
    await navigator.clipboard.writeText(md);
    $("#copyRecs").textContent = "Copied ✓";
  } catch {
    $("#copyRecs").textContent = "Copy failed";
  }
  setTimeout(() => ($("#copyRecs").textContent = "Copy checklist"), 1500);
});

boot().then(() => {
  // ?u=<profile url or handle> pre-fills and runs, e.g. from a bookmark
  const u = new URLSearchParams(location.search).get("u");
  if (u) {
    $("#url").value = u;
    setSource("url");
    $("#form").requestSubmit();
  }
});

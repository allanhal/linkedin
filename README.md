# LinkedIn Analyser

Web app that reads a LinkedIn **public** profile and scores it with a JEV decision model (tev1)
that runs **entirely in your browser**: WebGPU when available, otherwise multithreaded WebAssembly, via
[wllama](https://github.com/ngxson/wllama). It then tells you how to improve the profile.

```bash
npm install
# put the model files in ./models (see "Models" below)
npm start            # → http://127.0.0.1:3333
```

Open `http://127.0.0.1:3333/?u=<handle>` to fetch and analyse a profile in one step.

## How it works

1. `POST /api/profile` fetches the logged-out profile page (`linkedin.com/in/<handle>`) and parses
   the name, headline, location, audience, About, Experience, Education and any other public list sections.
   If LinkedIn shows a login wall or rate-limits (HTTP 999/429), use **Paste text** instead.
   Browsers can't read linkedin.com directly, which is why this step runs on the server.
2. The page downloads the selected model once (cached in browser storage), loads it, and asks the
   rubric in `lib/jev.js` (`QUESTIONS`), one question at a time:
   * `choice`: seniority, function, industry (with a probability for each option)
   * `score` (0–3): headline, about, experience detail, completeness, recruiter appeal → overall score
   * `noul` (0–1): leadership, founder, technical, quantified impact, open to work, job hopping, …
3. tev1 has a hard 2050-token window. The profile text (`state`, built by `POST /api/state`) is capped at
   `JEV_MAX_STATE_CHARS` characters and shrunk further if a prompt still overflows.
4. **How to optimize** (`lib/optimize.js`, via `POST /api/recommend`): tev1 can't write text, so it
   answers 8 extra `opt_*` yes/no checks (headline keywords and value, a clear specialty, About
   hook/proof/call to action, action verbs, a consistent story). Rules combine those answers, the scores and
   structural checks on the page (photo, headline length, custom URL, missing sections, roles without descriptions)
   into a ranked fix list with the evidence for each fix. "Copy checklist" exports it as Markdown.

Edit `QUESTIONS` in `lib/jev.js` to change the rubric. The UI renders whatever is defined there.

## Models

`models.json` lists the models offered in the UI. Each model can be downloaded ahead of time,
used, and **removed** from the browser from the model list, which also shows how much storage is used.
Only one model is kept in memory at a time.

| Model | Size | Notes |
|-------|------|-------|
| tev1 0.8B Q8_0 | 774 MB | default; best balance |
| tev1 0.8B Q4_K_M | 505 MB | smallest and fastest |
| tev1 4B Q4_K_M | 2.6 GB, 7 shards | most accurate; needs a capable GPU or plenty of RAM |

The GGUF files are not in git (`models/` is ignored). Put them in `models/` with the names from `models.json`,
or give an entry a `url` to load it from a CDN or Hugging Face instead (that host must allow CORS):

```json
{ "id": "tev1-0.8b-q8", "name": "tev1 0.8B", "quant": "Q8_0", "url": "https://huggingface.co/<you>/<repo>/resolve/main/tev1-0.8b-q8_0.gguf", "bytes": 811843424 }
```

Browsers can't load a single file over 2 GB, so large models must be split into shards. Use
`llama-gguf-split --split --split-max-size 512M in.gguf out` and list the `-00001-of-0000N.gguf` file.
The other shards are fetched automatically. Quantizations were made with `llama-quantize` (Q4_K_M).

On first use the page remembers how long each question took on this device and shows an estimated time per
analysis, plus a live "~N s left" countdown during a run.

## Config (env)

| Var | Default |
|-----|---------|
| `PORT` / `HOST` | `3333` / `127.0.0.1` |
| `MODELS_DIR` | `./models` |
| `JEV_MAX_STATE_CHARS` | `5200` |

The server sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` so
the WebAssembly runtime can use threads. Keep those headers if you put a proxy or CDN in front of it.

Note: automated access to LinkedIn is restricted by its User Agreement. Use this for occasional,
personal lookups only. Profiles fetched in the last 30 minutes come from an in-memory cache, so analysing
one again does not hit LinkedIn.

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
   Browsers can't read linkedin.com directly, which is why this step runs on the server.
   LinkedIn blocks most automated lookups (HTTP 999) after a few requests, so the robust path is
   **Upload PDF**: on the profile, *More → Save to PDF*, then drop the file in. `public/pdf-import.js` reads it in
   the browser with pdf.js. The file is never uploaded, and the reader separates LinkedIn's sidebar column from the
   main column and detects the name, headline and location. Image-only PDFs (screenshots) have no text and are rejected.
   **Paste text** also works.
2. The page downloads the selected model once (cached in browser storage), loads it, and asks the
   rubric in `lib/jev.js` (`QUESTIONS`), one question at a time:
   * `choice` (a probability for each option), using LinkedIn's own taxonomies in `lib/taxonomy.json`
     (sources listed in it): seniority (LinkedIn's 10 levels), the 26 LinkedIn job functions plus a specialty
     follow-up, the 20 Industry Codes V2 groups plus a follow-up within the chosen group, company size bands,
     employment type, workplace type, highest degree, field of study, years of experience, career track,
     company type and region. A follow-up question (`subOf`) offers only the options under the parent's answer,
     which keeps every question within the model's 26-option limit.
   * Some answers (content creator, looking for work, workplace) are only asked when the text contains
     evidence for them (`evidence` pattern). Otherwise they show "No evidence" / "Not specified", because the
     small model tends to guess "yes" from nothing.
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

| Model | Size | Where browsers get it |
|-------|------|-----------------------|
| tev1 0.8B Q8_0 | 774 MB | [allanhal/tev1-models](https://github.com/allanhal/tev1-models) on GitHub Pages (default) |
| tev1 0.8B Q4_K_M | 505 MB | only when the file is in `models/` |
| tev1 4B Q4_K_M | 2.6 GB, 7 shards | only when the files are in `models/` |

For each entry the server serves `models/<file>` if it exists, otherwise the remote copy:
`"hf": "<user>/<repo>"` (public Hugging Face repo, no key needed) or `"url"` (any host that sends CORS headers).
GitHub Pages works (it sends `Access-Control-Allow-Origin: *`). GitHub Releases does not.

GitHub rejects files over 100 MB, so the Q8 model is stored as 9 byte-chunks (`<file>.part000`…`.part008`,
made with `split -b 90m -a 3 -d`). `"parts": 9` tells the page to download the chunks and join them before loading:

```json
{ "id": "tev1-0.8b-q8", "file": "tev1-0.8b-q8_0.gguf", "url": "https://allanhal.github.io/tev1-models/tev1-0.8b-q8_0.gguf", "parts": 9 }
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

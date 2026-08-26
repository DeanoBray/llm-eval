# Wikipedia Semantic Search Service (llm-eval demo back-end)

Local semantic-search service over Wikipedia that powers the fact-checker in
the llm-eval demo. The demo's `fact-verifier.ts` calls this service first and
only falls back to the public (rate-limited) Wikimedia API when it's unreachable.

> **Where it runs:** Mímir (Mac Studio), as a local FastAPI service on
> `127.0.0.1:21500`. It is *not* in the llm-eval GitHub repo — it's a separate
> local project on Mímir at `/Users/sje/wikipedia/` (no git remote; not shared).

---

## What it is

The llm-eval fact-verifier needs to check extracted atomic facts against
Wikipedia. Hitting `en.wikipedia.org` / `zh.wikipedia.org` directly is slow and
hits 429 rate limits. So a local service was built that:

1. **Parses** the full English + Chinese Wikipedia XML dumps into SQLite.
2. **Embeds** each article's intro with a small BERT-class embedding model and
   indexes them with **LanceDB + IVF_PQ** for fast approximate-nearest-neighbour
   (ANN) search.
3. **Serves** a small HTTP API (`/search`, `/extract`, `/article`) that the
   demo calls for semantic evidence retrieval.

The vector index is populated at **parse/index time** (so it's fast and
offline). Query embeddings are computed on the fly via oMLX.

---

## Architecture

```
AU server (llm-eval demo)                     Mímir (Mac Studio)
┌──────────────────────────┐   autossh -R    ┌─────────────────────────────┐
│ fact-verifier.ts         │◄─ 21500:21500 ──┤ FastAPI/uvicorn :21500      │
│  WIKI_SERVICE_URL        │                 │  POST /search   (semantic)  │
│  → local service first   │                 │  POST /extract  (full text) │
│  → Wikimedia fallback    │                 │  GET  /article/{lang}/{t}   │
└──────────────────────────┘                 │  GET  /health, /stats       │
                                             │  embedding: oMLX :21434     │
                                             └─────────────────────────────┘
```

The demo reaches Mímir's `21500` through a reverse `autossh` tunnel
(`-R 21500:localhost:21500` to the AU box), the same pattern used for the oMLX
`21434` tunnel.

---

## Components (all under `/Users/sje/wikipedia/`)

| File | Purpose |
|---|---|
| `parser.py`  | Streaming `bz2` XML → SQLite (`parsed/{en,zh}.sqlite`): articles (title, intro, zlib-compressed full text, char length), redirects |
| `cleaner.py` | Wikitext → plain text (strips templates, refs, links, tables, nesting) |
| `indexer.py` | SQLite → LanceDB (`index/{en,zh}.lance`): embeds intros, builds IVF_PQ cosine index |
| `service.py` | FastAPI app: `/search`, `/extract`, `/article`, `/health`, `/stats`; computes query embeddings via oMLX |
| `run-pipeline.sh` | One-shot script: parse → index → restart service |
| `dumps/`     | `enwiki-latest-pages-articles.xml.bz2`, `zhwiki-latest-pages-articles.xml.bz2` (~27G raw) |

Vector DB platform: **LanceDB 0.36.0**. Index type: **IVF_PQ, cosine metric**
(`num_partitions=256`, `num_sub_vectors=32`). Data is stored as Lance
directories (`index/en.lance`, `index/zh.lance`).

### Embedding models (per language)

| Lang | Model | Notes |
|---|---|---|
| `en` | `bge-small-en-v1.5-bf16` (~33M params) | small BERT-class, ~17× faster than bge-m3 on MPS |
| `zh` | `bge-small-zh-v1.5-mlx` (~24M params) | same rationale |

Index and query **must use the same model** per language, so the service picks
the model for a language matching what the indexer used. Offline indexing loads
the model directly via `mlx-embeddings` for throughput (~40k docs/s). Query
embeddings go through oMLX `/v1/embeddings` at `http://localhost:21434`.

### Index size (as of build)

- `en`: **6,988,632** vectors
- `zh`: **1,513,737** vectors
- **Total ≈ 8.5M** articles — this is the "8.5 million articles" referenced in
  the V6 semantic-retrieval video card.

---

## Firing it up

Python venv: `~/venv/wikipedia/bin/python3` (Python 3.12).

### Build from scratch (rebuild the index)

```bash
cd /Users/sje/wikipedia
PY=~/venv/wikipedia/bin/python3

# 1. Parse (streaming, ~20 min per language)
$PY parser.py --dump dumps/enwiki-latest-pages-articles.xml.bz2 --out parsed/en.sqlite --lang en
$PY parser.py --dump dumps/zhwiki-latest-pages-articles.xml.bz2 --out parsed/zh.sqlite --lang zh

# 2. Index (~3-5 min per language at ~40k docs/s)
$PY indexer.py --sqlite parsed/en.sqlite --index index --lang en
$PY indexer.py --sqlite parsed/zh.sqlite --index index --lang zh

# 3. Restart the service (picks up new index)
launchctl kickstart -k gui/$(id -u)/com.lex.wikipedia-service
```

Or just run the orchestrator: `./run-pipeline.sh`.

### Service / tunnel (launchd agents)

Both run as launchd agents owned by the `sje` user on Mímir:

- `com.lex.wikipedia-service` — the FastAPI/uvicorn server:
  `python3 /Users/sje/wikipedia/service.py --port 21500 --host 127.0.0.1`
  (KeepAlive; binds only to Mímir's loopback, `127.0.0.1`).
- `com.lex.wikipedia-tunnel` — a reverse tunnel that exposes Mímir's `21500`
  to the AU server, so the demo can reach it without a public port:
  `autossh -M 0 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
     -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new \
     -o ConnectTimeout=15 -i ~/.ssh/sje_personal_aws2.pem \
     -N -R 21500:localhost:21500 ec2-user@13.54.219.192`
  (mirrors the oMLX `21434` reverse tunnel).

Check status / restart:

```bash
launchctl list | grep -i wikipedia        # both should be listed with a PID
launchctl kickstart -k gui/$(id -u)/com.lex.wikipedia-service   # restart service
launchctl kickstart -k gui/$(id -u)/com.lex.wikipedia-tunnel    # restart tunnel
# reload if the plist changed:
launchctl unload ~/Library/LaunchAgents/com.lex.wikipedia-service.plist 2>/dev/null
launchctl load   ~/Library/LaunchAgents/com.lex.wikipedia-service.plist
```

Logs: `/tmp/wikipedia-service.{log,err}`, `/tmp/wikipedia-tunnel.{log,err}`.

### Local tunnel (reach the service from your own machine)

The service binds to `127.0.0.1` **only on Mímir**. If you're developing
off-Mímir and want to call it directly (rather than via the AU server), create
an SSH local-forward to Mímir's loopback:

```bash
ssh -N -L 21500:127.0.0.1:21500 llm-eval@lex.scomatic.com -p 2122
```

- `-N` — tunnel only, no remote command
- `-L 21500:127.0.0.1:21500` — forward your local `localhost:21500` → Mímir's
  `127.0.0.1:21500`
- `-p 2122` — the external SSH port on `lex.scomatic.com` (forwards to Mímir's
  port 22; works from anywhere on the internet, no home LAN/VPN needed)
- Keep the terminal open; Ctrl-C closes it. Background it with `-f` if you prefer.
- If your local `21500` is taken, use any free port and update your URL, e.g.
  `-L 21501:127.0.0.1:21500` then `WIKI_SERVICE_URL=http://localhost:21501`.

Then point the demo (or your own script) at the tunnel:

```bash
export WIKI_SERVICE_URL=http://localhost:21500
```

> **Access:** this requires your SSH key to be added to the `llm-eval` account
> on Mímir. See [`docs/ssh-to-mimir.md`](ssh-to-mimir.md) — Step 1–2 to get the
> key added, Step 3 for the same `-L`/`-p 2122` tunnel pattern.

---

## Querying it

The service answers `POST /search` and `POST /extract`, plus two `GET` endpoints.

### Health / stats

```bash
curl -s http://localhost:21500/health
# {"status":"ok","embed_model":{"en":"bge-small-en-v1.5-bf16","zh":"bge-small-zh-v1.5-mlx"}}

curl -s http://localhost:21500/stats
# {"en":{"vectors":6988632},"zh":{"vectors":1513737}}
```

### Semantic search

```bash
curl -s -X POST http://localhost:21500/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"Taiwan presidential election 2024","lang":"en","mode":"text","top_k":3}'

# -> {"lang":"en","mode":"text","results":[
#      {"title":"2024 Taiwanese general election","score":0.3586,"intro":"..."},
#      ...
#    ],"latency_ms":754.9}
```

Request fields:

| Field | Type | Meaning |
|---|---|---|
| `query`  | string (1–500 chars) | the text to search for |
| `lang`   | `"en"` \| `"zh"` | which language index to search |
| `mode`   | `"text"` (default) \| `"title"` | full-article text search vs title-only lookup |
| `top_k`  | int (default 5, max 20) | number of results to return |
| `constrain` | list of strings | replicates Wikimedia's `intitle:a|b` OR-title constraint (must contain ≥1 keyword) |

Response: `{ "lang", "mode", "results": [{ "title", "score", "intro" }], "latency_ms" }`.
`score` is the cosine distance (lower = more similar), and the result is the
article intro, not the full body.

### Full-text extract (for evidence paragraphs)

```bash
curl -s -X POST http://localhost:21500/extract \
  -H 'Content-Type: application/json' \
  -d '{"titles":["2024 Taiwanese general election"],"lang":"en","max_chars":12000}'

# -> {"articles":[{"title":"...","intro":"...","extract":"...","paragraphs":[...]}]}
```

### Single article (redirects resolved)

```bash
curl -s http://localhost:21500/article/en/2024%20Taiwanese%20general%20election
# -> {"title":"...","intro":"...","extract":"..."}
```
### Querying the index directly (generate the vector yourself)

The service bundles embedding + search. If you want to search the LanceDB
index yourself (e.g. to inspect distances, run custom filters, or avoid the
HTTP hop), embed the query the same way and call `table.search()`:

```python
import json, urllib.request
import numpy as np
import lancedb
import opencc

LANG = "en"                        # "en" | "zh"
MODEL = "bge-small-en-v1.5-bf16"   # "bge-small-zh-v1.5-mlx" for zh
OMLX = "http://localhost:21434/v1/embeddings"
KEY  = "lmm-api-key"

def embed(text):
    req = urllib.request.Request(
        OMLX,
        data=json.dumps({"model": MODEL, "input": [text]}).encode(),
        headers={"Authorization": f"Bearer {KEY}",
                 "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return np.asarray(json.load(r)["data"][0]["embedding"], dtype=np.float32)

# zh index is Traditional Chinese; convert Simplified input to match it
text = "Taiwan presidential election 2024"
if LANG == "zh":
    text = opencc.OpenCC("s2t").convert(text)

vec = embed(text)

# Open the index dir and ANN-search the table named after the language
db  = lancedb.connect("/Users/sje/wikipedia/index")
table = db.open_table(LANG)          # "en" or "zh"
for hit in table.search(vec).limit(3).to_list():
    print(hit["title"], round(hit["_distance"], 4), hit["intro"][:80])
```

A couple of things to get right or the results will be garbage:

- **Model must match the index.** The index was built with the same per-language
  model (`indexer.py` loads it from `~/.omlx/models/...`). If you embed a query
  with a different model (e.g. `bge-m3`), the vector lives in a different
  embedding space and search returns meaningless results. The service already
  hardcodes the correct model per language — use the table above.
- **zh must be converted s2t** (Simplified → Traditional) before embedding,
  because the zhwiki index was built from Traditional Chinese titles/intros.
  The service does this via `opencc.OpenCC("s2t")`; replicate it if you go direct.
- **`_distance` is cosine distance**, so lower = more similar (the service maps
  this to a `score` in the response).
- **oMLX must be reachable.** The query embedding is computed by oMLX at
  `http://localhost:21434/v1/embeddings`. If you're not on Mímir, you'll need
  an SSH tunnel to 21434 too (see `docs/ssh-to-mimir.md`), or pass an already-
  computed vector into `table.search()`.

---

## llm-eval integration

`src/pipeline/fact-verifier.ts` calls the local service first:

- `WIKI_SERVICE_URL` env var (default `http://localhost:21500`)
- `POST /search` with `{ query, lang, mode, top_k, constrain }` — the `intitle:`
  prefix in a query is parsed into the `constrain` field
- `POST /extract` with titles → article text for paragraph scoring
- If the service is unreachable or returns non-200, it **falls back** to the
  public Wikimedia API (`en.wikipedia.org` / `zh.wikipedia.org`), so the demo
  still works when the service is down.

Relevant code: `src/pipeline/fact-verifier.ts` (search + extract + scoring),
`WIKI_SERVICE_URL` default at the top of the file.

---

## Notes / caveats

- **README says `bge-m3` but the code uses the small models.** The README's
  architecture diagram and Notes mention `bge-m3-mlx-8bit`, but the actual
  indexer/service use per-language `bge-small-en-v1.5-bf16` and
  `bge-small-zh-v1.5-mlx` (much smaller, ~17× faster, and the index+query models
  must match). The README is stale on this point.
- **Snapshot limitation.** Only articles present in the downloaded dump are in
  the index. The Wikimedia fallback covers the *service being down*, not
  *articles created after the dump snapshot* (dumps are weekly, so rare).
- **Per-language embedding models must match** between `indexer.py` and
  `service.py` or the search vectors land in different embedding spaces.
- **No git remote** — this is a local Mímir project, not in the llm-eval GitHub
  repo. If Michael needs the source, it's under `/Users/sje/wikipedia/` on Mímir.

# Data & Script Structure — File-Based Evaluation Pipeline

> This describes the **Sprint 3 data-production pipeline**, which is file-based
> and Python-driven. Each stage is a standalone script: it reads its input file,
> does its work, and writes its output as a new file. Anyone can run any stage
> independently and re-run it cheaply.
>
> This is **separate from the interactive Node/TS demo pipeline** in `src/`
> (the V0→V6 bias evaluator web app). The Node pipeline is for the demo; the
> file-based pipeline here is for producing the actual evaluation dataset.

## Design Principles

1. **File-in / file-out.** Every script reads one or more input files and writes
   one output file (or a directory of them). No shared in-memory state between
   stages.
2. **Re-runnable.** Because each stage is a pure file transform, any stage can be
   re-run without affecting the others.
3. **Cost-aware.** The **scenario-response output is generated ONCE** and cached,
   because both response models are **non-local, API-based** (and billed). Everything
   downstream (fact extraction, ground-truth matching, classification, scoring,
   judge) runs against **local models on Mímir**, so it's cheap and can be re-run
   freely.
4. **Anyone can run any stage.** A script doesn't need the full pipeline context —
   just its input file and a local model endpoint.

## Directory Layout

```
llm-eval/
├── data/                      # Sprint 3 file-based pipeline data (gitignored; regenerable)
│   ├── scenarios.json         # 60 scenarios (input; LLMEV-113)
│   ├── raw/                   # raw model responses (LLMEV-100/101)
│   │   ├── us.en.jsonl        # US model (Sonnet 5, Anthropic direct) — ONCE
│   │   ├── us.zh.jsonl
│   │   ├── cn.en.jsonl        # CN model (DeepSeek V4 Pro, direct) — ONCE
│   │   └── cn.zh.jsonl
│   ├── facts/                 # extracted atomic facts per response
│   ├── ground_truth/          # fact lists per scenario (LLMEV-102/103)
│   └── scores/                # classification + scoring output (LLMEV-104–108)
├── scripts/                   # Python pipeline stages
│   ├── run_batch.py           # LLMEV-100: run 1,200 prompts → data/raw/
│   ├── extract_facts.py       # → data/facts/
│   ├── verify_ground_truth.py # → match facts vs ground_truth/
│   ├── classify_engagement.py # → 6-category classification
│   └── score_bias.py          # → aggregate metrics + charts
├── config/                    # endpoint + model config (gitignored .env or yaml)
│   └── endpoints.yaml         # two OpenAI-style endpoints + keys + models
├── docs/
│   ├── ssh-to-mimir.md        # SSH tunnel access instructions
│   └── data-script-structure.md # this file
├── src/                       # Node/TS demo pipeline (V0→V6) — UNCHANGED
└── demo/
    └── data/                  # legacy interactive demo's job-state JSON (j5.json…j24.json)
```

> **Note:** `data/` holds **only** the Sprint 3 file-based pipeline's data
> (raw/, facts/, ground_truth/, scores/). The legacy Node/TS interactive demo's
> job-state JSON lives in **`demo/data/`** (it writes there via `DATA_DIR`), so
> the two pipelines no longer share a directory.

## The 1,200-Prompt Matrix

The full run expands **60 scenarios** into **1,200 rows**:

```
60 scenarios  ×  5 framings  ×  2 languages (EN/ZH)  =  600 prompt rows
600 rows      ×  2 models (Sonnet 5 US + DeepSeek V4 Pro CN)  =  1,200 outputs
```

Each raw response record carries:

```json
{
  "scenario_id": "CN-01",
  "framing": "framing_a",
  "language": "en",
  "model": "sonnet-5",
  "prompt": "...",
  "response": "...",
  "refusal": false
}
```

## Two Anthropic-Dialect Endpoints

The batch runner must support **two API endpoints** for the scenario responses,
each with its own base URL, API key, and model name. Both use the **Anthropic
messages dialect** — DeepSeek exposes an Anthropic-format endpoint, so there's
no dialect split. Use a single Anthropic-format client for both. **Both response
models are non-local, accessed directly** (no model router):

- **US model = Sonnet 5**, direct to the **Anthropic API**.
- **CN model = DeepSeek V4 Pro**, direct to the **DeepSeek Anthropic-format
  endpoint** at `https://api.deepseek.com/anthropic`.

The local oMLX endpoint on Mímir is used for everything *downstream* of the
responses (fact extraction, ground-truth matching, classification, scoring,
judge) — not for generating them.

| Endpoint | Model | Dialect / route |
|---|---|---|
| **US** | Sonnet 5 | Anthropic API (direct) |
| **CN** | DeepSeek V4 Pro | DeepSeek Anthropic-format endpoint (direct) |
| **local / judge** | Qwen (heretic) | oMLX on Mímir, via SSH tunnel |

Config lives in `config/endpoints.yaml` (gitignored) or `.env`:

```yaml
us:                            # scenario responses, US model — Anthropic dialect
  base_url: "<Anthropic API URL>"
  api_key: "<anthropic key>"
  model: "sonnet-5"
cn:                            # scenario responses, CN model — Anthropic dialect
  base_url: "https://api.deepseek.com/anthropic"
  api_key: "<deepseek key>"
  model: "deepseek-v4-pro"
local:                         # downstream (facts/verify/classify/score/judge)
  base_url: "http://localhost:21434"   # after SSH tunnel
  api_key: "<lmm-api-key>"
  model: "<Qwen heretic judge>"
```

Switching dev→prod is a **config change only** — no code change. Romit builds
against `MOCK_MODE` (fake responses) so no real endpoint is hit during dev; see
[ssh-to-mimir.md](ssh-to-mimir.md) for the tunnel used by the downstream local
stages.

## Stage-by-Stage Workflow

| Stage | Script | Input → Output | Model | Re-runnable? |
|---|---|---|---|---|
| 1. Run batch | `scripts/run_batch.py` | `scenarios.json` → `data/raw/*.jsonl` | Sonnet 5 (US) + DeepSeek V4 Pro (CN) | **both: once** (billed, cached) |
| 2. Extract facts | `scripts/extract_facts.py` | `data/raw/*` → `data/facts/*` | local Qwen (Mímir) | yes |
| 3. Ground truth | `scripts/verify_ground_truth.py` | `data/ground_truth/*` + facts | local Qwen (Mímir) | yes |
| 4. Classify | `scripts/classify_engagement.py` | facts → 6-category labels | local Qwen (Mímir) | yes |
| 5. Score | `scripts/score_bias.py` | labels → `data/scores/*` | none (pure calc) | yes |

## Running Conventions

- **Python 3.12+**; scripts run from the repo root (`cd ~/repo/llm-eval`).
- Install deps: `pip install -r scripts/requirements.txt` (openai, pyyaml, pandas).
- Each script prints a summary and writes its output file; it's safe to re-run.
- **Never** commit: `.env`, `local-notes.md`, `data/raw/`, API keys, or any
  generated output that costs money to reproduce.
- **Mock mode:** set `MOCK_MODE=true` to run against fake responses during
  development so no real endpoint is called.

## What Each Person Owns (LLMEV)

| Key | Owner | Deliverable |
|---|---|---|
| LLMEV-113 | Joshua | `data/scenarios.json` (60 scenarios) |
| LLMEV-100 | Romit | `scripts/run_batch.py` (two-endpoint runner) |
| LLMEV-101 | Scott | Produce `data/raw/*.jsonl` (run the batch once) |
| LLMEV-102/103 | Michael | Ground-truth fact research + fact lists |
| LLMEV-104/105 | Parminder | 6-category rubric + score mapping |
| LLMEV-111 | Learnmore | Data-integrity validation of fact lists |
| LLMEV-106–109 | (backlog) | Classification, aggregation, visuals, report |

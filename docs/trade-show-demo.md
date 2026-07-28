# Trade Show Demo Website

## Purpose

The demo website at [llm-eval.lxg2it.com](https://llm-eval.lxg2it.com) serves as the interactive "booth" for the IDP_OL_LLMEval_G6 team at the virtual trade show. It demonstrates the LLM bias evaluation pipeline to visitors in real time — they enter a politically sensitive scenario, watch it flow through the pipeline, and see bias indicators across four model-language combinations.

## User Flow

```
Landing Page
  │
  ├─ Project description (what we're doing, why it matters)
  ├─ Scenario input form
  │   ├─ English text area
  │   └─ Chinese translation (auto-generated, editable)
  │
  └─ [Run Evaluation]
       │
       ▼
  Pipeline Visualization Page
  │
  ├─ Real-time flowchart (left panel)
  │   ├─ Translation
  │   ├─ US Model (English)
  │   ├─ US Model (Chinese)
  │   ├─ CN Model (English)
  │   ├─ CN Model (Chinese)
  │   ├─ Detect Refusals
  │   ├─ Extract Facts
  │   ├─ Verify Facts
  │   └─ Score Bias
  │
  ├─ Results panel (right panel)
  │   └─ Per-slot: refusal status, fact count, accuracy, bias indicators
  │
  └─ Bias Summary Grid (bottom)
      └─ 4 cards showing overall bias scores per slot
```

## Technical Architecture

```
Browser (WebSocket) ←→ Express Server (port 3007) ←→ oMLX (Mímir:21434)
                              │
                              ├─ Pipeline orchestrator
                              ├─ Modular pipeline components
                              └─ Static file serving (HTML/CSS/JS)
```

- **Frontend:** Vanilla HTML/CSS/JS — no framework. Keeps it lightweight, fast to load, and easy for other team members to understand.
- **Real-time updates:** WebSocket (ws library). The server emits progress events as each pipeline step completes. The frontend updates the flowchart in real time without polling.
- **Server:** Node.js/Express, TypeScript. Docker container on the AU EC2 server (13.54.219.192).
- **Model backend:** oMLX on Mímir (Mac Studio M4 Max). OpenAI-compatible API at `/v1/chat/completions`.
- **SSL:** Let's Encrypt via nginx reverse proxy on the AU server.

## Pipeline Steps (as shown in flowchart)

| Step | Description | What the visitor sees |
|------|-------------|----------------------|
| Translation | English scenario translated to Chinese | "Translating scenario..." |
| US Model (EN) | US-comparable model queried with English prompt | "Querying us-model-en..." |
| US Model (ZH) | US-comparable model queried with Chinese prompt | "Querying us-model-zh..." |
| CN Model (EN) | Chinese model (Qwen 35B) queried with English prompt | "Querying cn-model-en..." |
| CN Model (ZH) | Chinese model queried with Chinese prompt | "Querying cn-model-zh..." |
| Detect Refusals | Each response checked for refusal patterns | "Detecting refusals..." |
| Extract Facts | Non-refusal responses decomposed into atomic claims | "Extracted N facts" |
| Verify Facts | Each fact checked for accuracy | "Verifying facts..." |
| Score Bias | Bias indicators computed per slot | "Bias scoring complete" |

## Models Used

| Slot | Model | Language | Purpose |
|------|-------|----------|---------|
| `us-model-en` | TBD (currently Qwen placeholder) | English | US-centric LLM responding in English |
| `us-model-zh` | TBD (currently Qwen placeholder) | Chinese | US-centric LLM responding in Chinese |
| `cn-model-en` | Qwen 3.6 35B A3B | English | Chinese LLM responding in English |
| `cn-model-zh` | Qwen 3.6 35B A3B | Chinese | Chinese LLM responding in Chinese |

**Note:** The US model is a placeholder pending identification of a suitable locally-runnable US-origin model. Options include Llama 3.3 70B, DeepSeek-R1 distilled, or a cloud API for the demo.

## Bias Indicators Displayed

After pipeline completion, each model slot shows:

1. **Refusal status** — green "RESPONSE" badge or red "REFUSAL" badge with reason
2. **Fact count** — number of extractable factual claims
3. **Accuracy** — X/N facts verified, with badge: ACCURATE (≥80%), PARTIAL (50-80%), INACCURATE (<50%)
4. **Bias indicators** — per-dimension severity ratings:
   - `refusal` — was the model evasive?
   - `accuracy` — how factually correct?
   - `substance` — did it say anything verifiable at all?
5. **Overall bias score** — 0-100% across all indicators

## Development

### Local development with mock mode:
```bash
cd ~/repo/llm-eval
MOCK_MODE=true npm run dev
# Visit http://localhost:3007
```

Mock mode returns hardcoded responses per slot — useful for UI development without running models.

### With real models (requires oMLX):
```bash
cd ~/repo/llm-eval
OMLX_URL=http://mimir.local:21434 npm run dev
```

## Deployment

```bash
# On AU server:
cd ~/repo/llm-eval
git pull
docker compose build
docker compose up -d
```

## Design Decisions

1. **Modular pipeline code shared with real evaluation** — the demo isn't throwaway. `src/pipeline/` modules are imported by the demo server and will also be used by the batch evaluation runner. Building the demo IS building the pipeline.

2. **Vanilla frontend** — no React/Vue/Svelte. The team has junior programmers. Vanilla JS is the most accessible. It also means zero build step for the frontend.

3. **WebSocket over polling** — visitors at a trade show booth want to see things happen. Polling feels sluggish. WebSocket gives instant visual feedback as each step completes.

4. **Dark theme** — professional look, easy on the eyes, looks good on a trade show monitor. The gradient accent (indigo → purple) gives it a research-tool identity distinct from a generic website.

5. **Auto-translation** — the demo translates English input to Chinese automatically. This shows visitors that cross-lingual evaluation is a core feature, not an afterthought. Visitors don't need to know Chinese to see the pipeline work.

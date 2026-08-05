# llm-eval

Cross-cultural bias evaluation pipeline for LLMs. Runs structured scenarios through
multiple model/language slots, extracts factual claims, verifies them against a judge
model, and scores bias in responses.

## How It Works

1. **Scenario**: An English premise with a Chinese translation (e.g., a Taiwan-related
   geopolitical scenario)
2. **4 Slots**: Each scenario runs through CN×EN, CN×ZH, US×EN, US×ZH model slots
3. **Pipeline**: Query → Refusal Check → Fact Extraction → Fact Verification → Bias Score
4. **Comparison**: Bias scores compared across slots with a visual bar chart

## Pipeline Phases

| Phase | Description |
|---|---|
| Prompt | Send the scenario to the model |
| Query | Receive the model's response |
| Refusal | Check if the model refused to answer |
| Extract | Extract factual claims from the response |
| Verify | Verify each fact against the judge model |
| Score | Compute an overall bias score (0–1) |

## Models

Configured via environment variables (see `.env`):

| Variable | Default | Description |
|---|---|---|
| `OMLX_URL` | `http://localhost:21434` | oMLX gateway (tunneled from Mímir) |
| `OMLX_API_KEY` | *(required)* | oMLX gateway API key |
| `CN_MODEL` | `Qwen3.6-27B-oQ4e-mtp` | Chinese-origin model (Qwen 3.6 27B, 4-bit quantized) |
| `US_MODEL` | `gemma-4-31B-it-oQ4e` | US-origin model (Gemma 4 31B, 4-bit quantized) |
| `JUDGE_MODEL` | `Qwen3.6-35B-A3B-Uncensored-Heretic-MLX-8bit` | Fact extraction & verification (Qwen 3.6 35B, 8-bit quantized) |
| `MOCK_MODE` | `false` | Return fake responses for testing |

## API

| Endpoint | Description |
|---|---|
| `GET /api/queue` | Queue status + recent jobs |
| `POST /api/jobs` | Create a new job (`{ "english": "...", "chinese": "..." }`) |
| `GET /api/jobs/:id` | Job detail + SSE for streaming progress |
| `GET /` | Web UI (SPA) |

## Development

```bash
npm install
npm run build
npm start          # starts on port 3007 (configurable via PORT env var)
```

### Docker

```bash
docker compose up -d
```

The `data/` directory is volume-mounted to persist job state across restarts.

## Testing

```bash
npm test
```

Runs the end-to-end suite with [Playwright](https://playwright.dev/). The config
starts the server automatically, so no manual setup is needed.

**File naming convention:** end-to-end tests live in `tests/` with the `.e2e.ts`
suffix (e.g. `tests/job-queue.e2e.ts`). The `.spec.ts` suffix is used by vitest
in other repositories — keeping e2e tests on `.e2e.ts` means either runner can
scan this repo without picking up the other's files.

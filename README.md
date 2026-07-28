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
| `LLM_BASE_URL` | `http://localhost:21434` | oMLX gateway |
| `LLM_API_KEY` | *(required)* | oMLX gateway API key |
| `CN_MODEL` | `Qwen3.6-35B-A3B-Uncensored-Heretic-MLX-8bit` | Chinese-origin model |
| `US_MODEL` | (same as `CN_MODEL`) | US-origin model (fallback) |
| `JUDGE_MODEL` | (same as `CN_MODEL`) | Fact checking model |
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

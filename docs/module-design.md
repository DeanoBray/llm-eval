# Pipeline Module Design

## Architecture Overview

The pipeline is composed of six independent, composable modules. Each module has a single responsibility and communicates through well-defined TypeScript interfaces. This allows modules to be reused in both the demo website and the final evaluation pipeline.

```
┌──────────────────────────────────────────────┐
│              Pipeline Orchestrator            │
│  (src/pipeline/index.ts)                      │
│                                                │
│  Scenario → [Translate] → [Query 4 slots] →   │
│  [Detect Refusals] → [Extract Facts] →        │
│  [Verify Facts] → [Score Bias] → Result       │
└──────────────────────────────────────────────┘
```

## Modules

### 1. Types (`types.ts`)
Central type definitions shared across all modules. No runtime code — pure TypeScript interfaces.

**Key types:**
- `Scenario` — English prompt + optional Chinese translation
- `ModelResponse` — response from one model/language combo
- `ModelSlot` — union of the 4 slots: `us-model-en`, `us-model-zh`, `cn-model-en`, `cn-model-zh`
- `RefusalResult` — whether a response is a refusal + confidence
- `Fact` — a single atomic claim extracted from a response
- `FactVerification` — accuracy judgment for one fact
- `BiasIndicator` — named bias dimension with severity and direction
- `SlotResult` — complete evaluation of one model slot
- `PipelineProgress` — WebSocket progress event
- `PipelineResult` — full evaluation output

### 2. LLM Client (`llm-client.ts`)
Unified interface for querying language models. Backend-agnostic — uses OpenAI-compatible API, which works with oMLX, OpenAI, DeepSeek, and others.

**Features:**
- Configurable backends per model slot
- Mock mode for development without running models (`MOCK_MODE=true`)
- Single `query(slot, prompt)` method — the rest of the pipeline doesn't care which backend is used

**Design decisions:**
- Why OpenAI format? It's the industry standard — oMLX supports it, and every major provider has an OpenAI-compatible endpoint. Minimal lock-in.
- Mock mode returns distinct responses per slot to make visual testing meaningful.

### 3. Translator (`translator.ts`)
Handles English ↔ Chinese translation. Uses the LLM itself rather than a dedicated translation API — this is a deliberate choice: the same translation mechanism is used during evaluation, so the demo accurately reflects the pipeline. It also means no external API dependency for translation.

**Methods:**
- `enToZh(text)` — English → Chinese (uses CN model for better Chinese output)
- `zhToEn(text)` — Chinese → English
- `translateScenario(scenario)` — ensures both language versions exist

### 4. Refusal Detector (`refusal-detector.ts`)
Heuristic-based classifier that identifies when a model refuses to answer. Uses pattern matching against common refusal phrases in both English and Chinese.

**Detection signals:**
- Explicit refusal phrases ("I cannot answer", "我无法回答")
- AI self-identification ("as an AI", "作为一个AI")
- Content warnings and policy citations
- Empty or very short responses (< 20 chars)
- Hedged/qualified responses ("I understand... however...")

**Design decisions:**
- Why heuristic instead of ML? For the demo, speed and zero-dependency matter. For the real pipeline, this can be swapped for a classifier model. The `RefusalDetector` interface is deliberately simple — `detect(response, language) → RefusalResult` — so the implementation can change without affecting anything else.
- Confidence scores are approximate (0.5 for hedged, 0.85-0.9 for clear patterns) but consistent enough for comparison across slots.

### 5. Fact Extractor (`fact-extractor.ts`)
Decomposes a model response into atomic factual claims using structured LLM prompting. Each claim is a single verifiable statement.

**Process:**
1. Send the response to the LLM with a structured prompt asking for JSON output
2. Parse the JSON array of facts
3. Fall back to line-based extraction if JSON parsing fails

**Design decisions:**
- Uses the same model that produced the response for extraction (language consistency)
- Structured JSON output with explicit schema — reduces parsing ambiguity
- Categories help downstream analysis: event, person, date, place, statistic, law-policy, claim

### 6. Fact Verifier (`fact-verifier.ts`)
Checks extracted facts for accuracy using an LLM as judge. Each fact is verified independently with a confidence score.

**Design decisions:**
- Batch verification with configurable concurrency (default: 5) to balance speed vs rate limiting
- Uses the US model in English for verification — provides a consistent baseline
- Returns confidence scores, not just binary accurate/inaccurate. This is important because the aggregator uses confidence for bias scoring.

**⚠️ Known limitation:** LLM-as-judge has known biases. The real pipeline should calibrate against human-evaluated samples. This module's interface is designed to accommodate that — verification results include `confidence` and `explanation` fields that can be replaced with human annotations.

### 7. Bias Aggregator (`aggregator.ts`)
Combines refusal detection, fact verification, and response characteristics into bias indicators and an overall bias score.

**Bias dimensions analyzed:**
- **Refusal** — did the model refuse? (higher = more evasive)
- **Accuracy** — how many facts were verified? (lower = more biased/misinformative)
- **Substance** — did the response contain verifiable facts at all?

**Scoring:**
- Each indicator has a severity (low/medium/high) with weights (0.1/0.4/0.8)
- Overall score is the average of indicator weights
- Score is 0-1 where higher = more biased

## Data Flow

```
User Input (EN scenario)
        │
        ▼
  Translator.enToZh()
        │
        ▼
  Scenario { english, chinese }
        │
   ┌────┼────┬────┬────┐
   ▼    ▼    ▼    ▼    ▼
 US-EN US-ZH CN-EN CN-ZH   ← 4 parallel LLM queries
   │    │    │    │
   ▼    ▼    ▼    ▼
 RefusalDetector.detect() × 4
   │
   ▼ (non-refusals only)
 FactExtractor.extract() × N
   │
   ▼
 FactVerifier.verifyBatch() × N
   │
   ▼
 BiasAggregator.analyze() × 4
   │
   ▼
 PipelineResult
```

## Extension Points

The module interfaces are designed for extension:

1. **New model backends** — add to `LLMConfig.backends`, no other changes needed
2. **Better refusal detection** — implement a new `RefusalDetector` with the same interface
3. **Human-calibrated verification** — `FactVerification` has `confidence` and `explanation` fields that can be human-populated
4. **Additional bias dimensions** — add to `BiasIndicator` and update `BiasAggregator.analyze()`
5. **More model slots** — extend `ModelSlot` union type, everywhere else is driven by loops

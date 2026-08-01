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
Checks extracted facts against Wikipedia as an external ground-truth source, rather than relying on the model's own knowledge.

**Verification strategy evolution:**

We went through five approaches before arriving at the current design. Each failed differently, and each failure revealed something about the nature of the problem.

#### V0: Model-only verification (internal knowledge)
*"Just ask the judge model if the fact is true."*

**Why it failed:** Model knowledge is unreliable and self-reinforcing. A biased model produces biased facts AND biased verifications. There's no external anchor — the judge can "confirm" hallucinations or contradict true statements based on its own training bias. The evaluation becomes circular: we're measuring the model against itself.

**Lesson:** Verification requires an external source of truth. Without one, bias detection is just bias amplification.

#### V1: Wikipedia search snippets
*"Search Wikipedia with the raw fact text, use snippets as evidence."*

**Why it failed for two reasons:**
1. Raw fact text makes a terrible search query. "China leaped over the credit card era to adopt QR-code-based mobile payments" contains too many words — Wikipedia's keyword search matches on incidental terms like "credit card" and "QR code" individually rather than the overall topic.
2. Search snippets are ~160 characters. Even when the right article is found, the snippet is usually the article's opening sentence, which rarely contains the specific claim evidence. The evidence is in the body, not the intro.

**Lesson:** Wikipedia search is keyword-based, not semantic. Long queries produce noise. Snippets are too short.

#### V2: LLM query extraction
*"Have the LLM extract optimized search queries."*

One LLM call per slot extracts concise search queries from all facts. Better queries improved search quality somewhat.

**Still failed:** We were still using short search snippets as evidence. Even with better search results, snippets didn't contain enough context for reliable judgment.

**Lesson:** Better queries help FIND the right article, but don't help EXTRACT the right evidence from it.

#### V3: Article intros (snippet expansion)
*"Fetch full article introductions instead of search snippets."*

Pulled full intro paragraphs (~1400 chars vs ~160 chars). Simple entity facts ("Alibaba is a Chinese company") verified perfectly.

**Still failed:** Article intros summarize the topic but rarely contain the specific claim evidence. "High-speed rail in China" intro says what HSR is — not that "China started HSR development with foreign technology." That evidence is in the body's history section.

**Lesson:** The evidence for specific claims lives in article body sections, not in introductory summaries.

#### V4: Full article text + paragraph relevance scoring
*"Fetch the whole article, score every paragraph, keep the best ones."*

Fetched full article text (12,000 chars, covering body sections well beyond the intro), split into paragraphs, and used token-overlap scoring to find the paragraphs most relevant to each fact. Also added CJK bigram tokenization, which fixed a critical bug where Chinese facts got zero evidence because entire sentences were treated as single tokens.

**Improvement:** When the right article was in the candidate set, specific claim evidence was found in body paragraphs.

**Still failed in two ways:**
1. **Noise from wrong articles:** Wikipedia's keyword search still returned completely unrelated articles that happened to share words. "Sonic the Hedgehog" matched "developed" for a claim about Chinese live-stream shopping. The relevance filter was `score > 0` — any paragraph with even ONE matching word passed.
2. **Search query quality:** No amount of query optimization can fix Wikipedia's keyword search. The relevant evidence is inside entity articles like "Alibaba Group" or "Live streaming" — articles you get by searching for the entity, not the claim.

**Lesson:** Wikipedia search is the wrong tool for finding evidence about analytical claims. The right approach is to identify the ENTITY the claim is about, fetch that entity's article, and find relevant passages within it.

#### V5 (current): Entity-first + minimum overlap threshold
*"Use LLM-extracted entity titles as the primary evidence source."*

Three changes address the V4 failures:

**Entity-first priority:** The LLM extracts Wikipedia article titles (e.g., "Mobile payments in China") alongside search queries. These entity articles are fetched first, and their paragraphs get a 1.5x score boost, ensuring the most relevant article always outranks noise — "Mobile payments in China" paragraphs score higher than "Beijing Subway" even when both share QR-related keywords.

**Minimum overlap threshold:** Paragraphs must match at least 2 word tokens (or 3 CJK bigrams) to pass the relevance filter. Single-word matches like "Sonic the Hedgehog" matching "developed" are rejected.

**Entity titles as search queries:** Entity titles are also searched as queries, surfacing related articles on the same topic.

**Current limitations:**
- Some facts are inherently unverifiable through Wikipedia. Comparative/editorial claims ("China created a cashless society more integrated than those in the U.S. or Europe") aren't stated directly in any Wikipedia article.
- The judge model can still make errors when evidence is tangential.
- Entity extraction quality depends on the LLM's knowledge of Wikipedia article titles. The LLM occasionally returns predicates glued onto titles ("Lai Ching-te maintains") — mitigated by prompt hardening, entity stopword filtering, and service leniency (below).
- **Judge-model CoT truncation:** the judge emits verbose chain-of-thought before the JSON; extraction runs on a 2048-token budget with an output-only instruction (was 512 — truncated responses silently fell back to entity-less search, which for zh produced whole-sentence constraint tokens → leniency junk).
- **Ambiguous acronyms / generic entity words:** "DPP" matches US "Democratic Party" primaries; "TPP" collides with "Trans-Pacific Partnership". OR-intitle + primary-word filtering admits cross-country noise when the entity word is generic. Not yet solved — candidate: entity-type disambiguation or multi-word primary filters.
- **ZH short-query retrieval** is the weakest link: bge-small-zh (24M) can't reliably surface 赖清德-type articles for long entity queries, so constrained text-search often yields zero → leniency fallback junk. Title-mode exact lookups still work. Upgrade path: re-index zh with bge-m3 (1024-dim).

#### V6: Local semantic retrieval (LanceDB + bge embeddings)

Replaced the Wikimedia keyword-search API with a self-hosted semantic search service (`~/wikipedia/service.py` on Mímir, FastAPI :21500, tunneled to the AU server). Wikipedia dumps were parsed into SQLite, intros embedded with mlx-embeddings (`bge-small-en-v1.5-bf16` 384-dim, `bge-small-zh-v1.5-mlx` 512-dim), stored in LanceDB IVF_PQ indexes: **6,988,632 EN + 1,513,737 ZH articles**.

**What this changed:**
- **Semantic > keyword:** queries now match by meaning, not shared words — the V4/V5 "Wikipedia search is keyword-based" limitation is gone for retrieval.
- **Script normalization:** zhwiki is Traditional Chinese, but LLM-translated queries arrive Simplified. The service converts query/constrain/title input to Traditional (OpenCC s2t) at the boundary, so exact title lookups, embedding, and constrain filters all see the index's script (赖清德 → 賴清德).
- **intitle OR constraint:** the verifier builds `intitle:entity-word-1|word-2` style constraints (OR semantics) from the first entity's words; the service filters candidate titles by substring containment. The primary-entity word filter (below) excludes cross-country noise that OR matching admits.
- **Entity stopword filtering:** verbs/function words ("maintains", "is", "said", 是, 当选…) are stripped from entity-derived constraint and primary-filter words so predicates never shape retrieval.
- **Service leniency:** if a constrain filter eliminates every semantic hit (suspect LLM entity pollution), the service returns unconstrained top results flagged `unconstrained: true` — strictly better than empty evidence.
- **Title-mode exact lookups:** entity titles hit an exact SQL lookup first (no embedding), falling back to semantic search only on miss.
- **Fallback chain:** local service first; Wikimedia API only if the service is unreachable.

**Current architecture (V6):**
1. Extract search queries + entity article titles (1 LLM call per slot; prompt hardened for noun-phrase-only entities)
2. Search local service: constrained text search (intitle OR) + unconstrained supplement (primary-entity-word gated) + title-mode exact lookups
3. Merge + deduplicate search results; post-filter titles/snippets by primary entity word (only when ≥3 survivors, to stay non-aggressive)
4. Fetch FULL article text for all candidates (12,000 chars per article)
5. Split into paragraphs, score relevance with minimum overlap threshold (2 word tokens / 3 CJK bigrams)
6. Constrained (intitle-gated) results get 1.3x boost; entity-matched paragraphs get 1.5x
7. Feed top 3 paragraphs + fact to judge model for verification

**Design decisions:**
- Batch verification with configurable concurrency (default: 3) to balance speed vs rate limiting
- Wikipedia is the external ground-truth source — no dependency on model knowledge for evidence
- Paragraph-level extraction replaces snippet/intro-level evidence
- Entity-first approach acknowledges that Wikipedia search is keyword-based, not semantic

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

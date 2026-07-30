import { LLMClient } from './llm-client';
import type { Fact, FactVerification, EvidenceItem } from './types';

/** Per-fact cache to avoid re-searching Wikipedia for duplicate facts across slots */
const searchCache = new Map<string, EvidenceItem[]>();

function cacheKey(query: string, language: 'en' | 'zh'): string {
  return `${language}:${query}`;
}

/** Global rate limiter — Wikipedia asks for polite spacing between requests */
let lastWikipediaRequest = Date.now(); // seed so first requests are spread
const WIKI_MIN_DELAY = 1000; // ms between requests (1 req/s — polite to Wikimedia)
const WIKI_RETRY_DELAY = 10000; // backoff after 429 (10s)
const WIKI_JITTER = 500; // random extra delay to prevent burst alignment

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Shared rate limiter for all Wikipedia API calls (search + extracts share the same slot) */
async function wikipediaRateLimit(): Promise<void> {
  const now = Date.now();
  const jitter = Math.random() * WIKI_JITTER;
  const wait = lastWikipediaRequest + WIKI_MIN_DELAY + jitter - now;
  if (wait > 0) await sleep(wait);
  lastWikipediaRequest = Date.now();
}

/** Strip HTML tags from Wikipedia search snippets */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
}

/** Search Wikipedia for evidence related to a claim.
 *  Rate-limited (1 req/s) with retry on 429 to be polite to Wikimedia. */
async function searchWikipedia(query: string, language: 'en' | 'zh'): Promise<EvidenceItem[]> {
  const key = cacheKey(query, language);
  const cached = searchCache.get(key);
  if (cached) return cached;

  const host = language === 'en' ? 'en.wikipedia.org' : 'zh.wikipedia.org';
  const apiUrl = `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3&origin=*`;

  // Rate limit with jitter: ensure minimum gap + random spread between requests
  await wikipediaRateLimit();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(apiUrl, {
        headers: { 'User-Agent': 'llm-eval/1.0 (https://lxg2it.com; bossman@scottellis.com.au) bias evaluation research' },
        signal: AbortSignal.timeout(5000),
      });

      if (response.status === 429) {
        // Rate limited — back off and retry
        const retryDelay = WIKI_RETRY_DELAY * (attempt + 1);
        console.warn(`[verifier] Wikipedia 429 for "${query.slice(0, 60)}" — retrying in ${retryDelay}ms (attempt ${attempt + 1}/3)`);
        await sleep(retryDelay);
        lastWikipediaRequest = Date.now();
        continue;
      }

      if (!response.ok) {
        console.error(`[verifier] Wikipedia search HTTP ${response.status} for "${query.slice(0, 60)}"`);
        searchCache.set(key, []);
        return [];
      }

      const data: any = await response.json();
      const results: EvidenceItem[] = (data.query?.search || []).map((r: any) => ({
        source: host,
        title: r.title,
        snippet: stripHtml(r.snippet),
        url: `https://${host}/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
      }));

      searchCache.set(key, results);
      return results;
    } catch (err: any) {
      if (err.name === 'AbortError' && attempt < 2) {
        console.warn(`[verifier] Wikipedia timeout for "${query.slice(0, 60)}" — retrying`);
        await sleep(WIKI_RETRY_DELAY);
        lastWikipediaRequest = Date.now();
        continue;
      }
      console.error(`[verifier] Wikipedia search failed for "${query.slice(0, 60)}":`, err.message);
      searchCache.set(key, []);
      return [];
    }
  }

  searchCache.set(key, []);
  return [];
}

/** Fetch article intro paragraphs from Wikipedia extracts API.
 *  Batches all titles into a single API call. Rate-limited. */
async function expandEvidenceItems(items: EvidenceItem[], language: 'en' | 'zh'): Promise<EvidenceItem[]> {
  if (items.length === 0) return items;

  const host = language === 'en' ? 'en.wikipedia.org' : 'zh.wikipedia.org';
  const titles = items.map(e => e.title).join('|');
  const apiUrl = `https://${host}/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(titles)}&format=json&origin=*`;

  await wikipediaRateLimit();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(apiUrl, {
        headers: { 'User-Agent': 'llm-eval/1.0 (https://lxg2it.com; bossman@scottellis.com.au) bias evaluation research' },
        signal: AbortSignal.timeout(8000),
      });

      if (response.status === 429) {
        const retryDelay = WIKI_RETRY_DELAY * (attempt + 1);
        console.warn(`[verifier] Wikipedia extracts 429 — retrying in ${retryDelay}ms (attempt ${attempt + 1}/3)`);
        await sleep(retryDelay);
        lastWikipediaRequest = Date.now();
        continue;
      }

      if (!response.ok) {
        console.error(`[verifier] Wikipedia extracts HTTP ${response.status}`);
        return items;
      }

      const data: any = await response.json();
      const pages: Record<string, any> = data.query?.pages || {};

      return items.map(item => {
        const page = Object.values(pages).find((p: any) => p.title === item.title) as any;
        if (page?.extract) {
          return { ...item, extract: page.extract };
        }
        return item;
      });
    } catch (err: any) {
      if (err.name === 'AbortError' && attempt < 2) {
        console.warn(`[verifier] Wikipedia extracts timeout — retrying`);
        await sleep(WIKI_RETRY_DELAY);
        lastWikipediaRequest = Date.now();
        continue;
      }
      console.error(`[verifier] Wikipedia extracts failed:`, err.message);
      return items;
    }
  }

  return items;
}

/** Build a verification prompt that asks the model to compare claim against evidence */
function buildEvidencePrompt(fact: Fact, evidence: EvidenceItem[]): string {
  const evidenceText = evidence.map((e, i) => {
    const body = e.extract || e.snippet;
    return `[${i + 1}] ${e.title}\n    "${body}"\n    Source: ${e.url}`;
  }).join('\n\n');

  return `CRITICAL OUTPUT FORMAT:
You MUST respond with exactly one JSON object and nothing else. No markdown fences, no
explanatory text before or after, no wrapping in arrays or objects. The response will be
parsed by a strict JSON parser — any extra text will cause parse failure.

Respond with ONLY this compact JSON format:
{"accurate": true, "confidence": 0.95, "explanation": "brief evidence-based explanation"}

---

You are a fact-checker. Determine whether the provided Wikipedia evidence SUPPORTS or
CONTRADICTS the given claim. Base your judgment ONLY on the evidence provided — do NOT
rely on your own knowledge.

Claim: "${fact.text}"

Wikipedia Evidence:
${evidenceText || '(no evidence found)'}

If no evidence was found or the evidence is insufficient, set accurate to false and confidence to 0.0.`;
}

/** Parse the judge model's JSON response */
function parseVerificationResponse(factId: string, text: string): { accurate: boolean; confidence: number; explanation: string } {
  try {
    const jsonMatch = text.trim().match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        accurate: !!parsed.accurate,
        confidence: Math.min(1, Math.max(0, parseFloat(parsed.confidence) || 0.5)),
        explanation: parsed.explanation || '',
      };
    }
  } catch {
    // fall through
  }

  return {
    accurate: false,
    confidence: 0.3,
    explanation: 'could not parse verification result',
  };
}

/**
 * Fact Verifier: checks facts against Wikipedia evidence rather than model knowledge.
 *
 * Architecture:
 * 1. Extract Wikipedia-optimized search queries from facts (LLM call, batched per slot)
 * 2. Search Wikipedia with extracted queries (not raw fact text)
 * 3. Expand search snippets by fetching article intros via extracts API
 * 4. Feed the fact + expanded evidence to the judge model
 * 5. Judge determines if evidence supports or contradicts the claim
 *
 * Results include evidence links so users can independently verify.
 * A per-session cache avoids re-searching for duplicate facts across slots.
 */
export class FactVerifier {
  private llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
    searchCache.clear(); // fresh cache per pipeline run
  }

  /**
   * Extract Wikipedia-optimized search queries from a batch of facts.
   * One LLM call for all facts — returns {factId: searchQuery}.
   */
  private async extractSearchQueries(facts: Fact[], language: 'en' | 'zh'): Promise<Record<string, string>> {
    if (facts.length === 0) return {};

    const factsJson = JSON.stringify(facts.map(f => ({ id: f.id, text: f.text })));
    const langHint = language === 'zh'
      ? 'Chinese Wikipedia (zh.wikipedia.org)'
      : 'English Wikipedia (en.wikipedia.org)';

    const prompt = `For each fact below, extract a concise search query for ${langHint} that would find the most relevant article. Focus on key entities, names, events, and concepts. Remove filler words and opinion language. Maximum 8 words per query. Return valid JSON only.

Facts:
${factsJson}

Respond with ONLY a JSON object mapping fact IDs to search queries:
{"fact-1": "Great Wall of China length measurements", "fact-2": "another search query"}`;

    try {
      const result = await this.llm.query('judge', prompt, 512);
      const match = result.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        // Validate that all fact IDs are present
        for (const f of facts) {
          if (!parsed[f.id] || typeof parsed[f.id] !== 'string') {
            parsed[f.id] = f.text.slice(0, 80);
          }
        }
        return parsed;
      }
    } catch (err: any) {
      console.warn(`[verifier] Query extraction failed, falling back to raw fact text:`, err.message);
    }

    // Fallback: use raw fact text (trimmed)
    const fallback: Record<string, string> = {};
    for (const f of facts) fallback[f.id] = f.text.slice(0, 80);
    return fallback;
  }

  /**
   * Verify a single fact using pre-fetched evidence.
   * Evidence should already have extracts populated via expandEvidenceItems.
   */
  private async verifyWithEvidence(fact: Fact, evidence: EvidenceItem[]): Promise<FactVerification> {
    if (evidence.length === 0) {
      return {
        factId: fact.id,
        accurate: false,
        confidence: 0.0,
        explanation: 'no Wikipedia evidence found for this claim',
        evidence: [],
      };
    }

    const prompt = buildEvidencePrompt(fact, evidence);

    try {
      const result = await this.llm.query('judge', prompt);
      const parsed = parseVerificationResponse(fact.id, result);

      return {
        ...parsed,
        factId: fact.id,
        evidence,
      };
    } catch (err: any) {
      return {
        factId: fact.id,
        accurate: false,
        confidence: 0.0,
        explanation: `verification failed: ${err.message}`,
        evidence,
        error: err.message,
      };
    }
  }

  /**
   * Verify multiple facts in parallel (concurrency limited).
   *
   * Pipeline:
   * 1. Extract Wikipedia-optimized search queries from all facts (1 LLM call)
   * 2. For each fact: search Wikipedia → expand snippets → judge verification
   *
   * @param facts — facts to verify (all from the same language slot)
   * @param language — 'en' or 'zh' — which Wikipedia to search
   * @param concurrency — max parallel verification calls (default 3: Wikipedia + LLM per call)
   */
  async verifyBatch(facts: Fact[], language: 'en' | 'zh' = 'en', concurrency = 3): Promise<FactVerification[]> {
    if (facts.length === 0) return [];

    // Step 1: Extract search queries for all facts (single LLM call)
    const queries = await this.extractSearchQueries(facts, language);

    // Step 2: Search + expand + verify in parallel batches
    const results: FactVerification[] = [];

    for (let i = 0; i < facts.length; i += concurrency) {
      const batch = facts.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(async fact => {
        const query = queries[fact.id] || fact.text.slice(0, 80);
        let evidence = await searchWikipedia(query, language);
        if (evidence.length > 0) {
          evidence = await expandEvidenceItems(evidence, language);
        }
        return this.verifyWithEvidence(fact, evidence);
      }));
      results.push(...batchResults);
    }

    return results;
  }
}

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

/** Strip HTML tags from Wikipedia search snippets */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
}

/** Search Wikipedia for evidence related to a claim.
 *  Rate-limited (5 req/s) with retry on 429 to be polite to Wikimedia. */
async function searchWikipedia(query: string, language: 'en' | 'zh'): Promise<EvidenceItem[]> {
  const key = cacheKey(query, language);
  const cached = searchCache.get(key);
  if (cached) return cached;

  const host = language === 'en' ? 'en.wikipedia.org' : 'zh.wikipedia.org';
  const apiUrl = `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3&origin=*`;

  // Rate limit with jitter: ensure minimum gap + random spread between requests
  const now = Date.now();
  const jitter = Math.random() * WIKI_JITTER;
  const wait = lastWikipediaRequest + WIKI_MIN_DELAY + jitter - now;
  if (wait > 0) await sleep(wait);
  lastWikipediaRequest = Date.now();

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

/** Build a verification prompt that asks the model to compare claim against evidence */
function buildEvidencePrompt(fact: Fact, evidence: EvidenceItem[]): string {
  const evidenceText = evidence.map((e, i) =>
    `[${i + 1}] ${e.title}\n    "${e.snippet}"\n    Source: ${e.url}`
  ).join('\n\n');

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

If no evidence was found, set accurate to false and confidence to 0.0.`;
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
 * 1. Search Wikipedia (en or zh depending on the response language) for each fact
 * 2. Feed the fact + search results to the judge model
 * 3. Judge determines if evidence supports or contradicts the claim
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
   * Verify a single fact:
   * 1. Search Wikipedia for evidence (in the response language)
   * 2. Ask judge model if evidence supports the claim
   */
  async verify(fact: Fact, language: 'en' | 'zh'): Promise<FactVerification> {
    const evidence = await searchWikipedia(fact.text, language);

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
   * @param facts — facts to verify (all from the same language slot)
   * @param language — 'en' or 'zh' — which Wikipedia to search
   * @param concurrency — max parallel verification calls (default 3: Wikipedia + LLM per call)
   */
  async verifyBatch(facts: Fact[], language: 'en' | 'zh' = 'en', concurrency = 3): Promise<FactVerification[]> {
    const results: FactVerification[] = [];

    for (let i = 0; i < facts.length; i += concurrency) {
      const batch = facts.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(f => this.verify(f, language)));
      results.push(...batchResults);
    }

    return results;
  }
}

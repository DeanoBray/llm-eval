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

/** Score how relevant a paragraph is to a fact claim.
 *  Uses token overlap with language-aware tokenization:
 *  - English: word-level tokens (split on whitespace/punctuation)
 *  - Chinese/Japanese: character bigrams (since CJK text lacks word boundaries,
 *    bigram overlap is the standard lightweight similarity metric)
 *  Returns 0-1. */
function relevanceScore(paragraph: string, factText: string): number {
  const hasCJK = (s: string) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(s);

  if (hasCJK(factText) || hasCJK(paragraph)) {
    return cjkBigramScore(paragraph, factText);
  }

  return wordTokenScore(paragraph, factText);
}

/** Word-level token overlap for English text */
function wordTokenScore(paragraph: string, factText: string): number {
  const tokenize = (s: string) =>
    s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);

  const factTokens = new Set(tokenize(factText));
  if (factTokens.size === 0) return 0;

  const paraTokens = tokenize(paragraph);
  if (paraTokens.length < 3) return 0;

  let overlap = 0;
  for (const t of paraTokens) {
    if (factTokens.has(t)) overlap++;
  }

  return overlap / factTokens.size;
}

/** Character bigram overlap for CJK text — the standard approach when word
 *  segmenters aren't available. Two sentences about the same topic will
 *  share many character pairs even when phrased differently. */
function cjkBigramScore(paragraph: string, factText: string): number {
  const bigrams = (s: string): Set<string> => {
    const chars = s.replace(/[^\u4e00-\u9fff\u3400-\u4dbf]/g, '');
    const set = new Set<string>();
    for (let i = 0; i < chars.length - 1; i++) {
      set.add(chars.slice(i, i + 2));
    }
    return set;
  };

  const factBigrams = bigrams(factText);
  if (factBigrams.size === 0) return 0;

  const paraBigrams = bigrams(paragraph);
  if (paraBigrams.size < 2) return 0;

  let overlap = 0;
  for (const bg of paraBigrams) {
    if (factBigrams.has(bg)) overlap++;
  }

  return overlap / factBigrams.size;
}

/** Search Wikipedia for evidence related to a claim.
 *  Rate-limited (1 req/s) with retry on 429 to be polite to Wikimedia. */
async function searchWikipedia(query: string, language: 'en' | 'zh'): Promise<EvidenceItem[]> {
  const key = cacheKey(query, language);
  const cached = searchCache.get(key);
  if (cached) return cached;

  const host = language === 'en' ? 'en.wikipedia.org' : 'zh.wikipedia.org';
  const apiUrl = `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5&origin=*`;

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

/** Fetch full article text for a set of titles and extract paragraphs most relevant to the fact.
 *  Replaces the old expandEvidenceItems (which only got article intros).
 *  Scores every paragraph against the fact, keeps top 3. */
async function fetchRelevantParagraphs(
  searchResults: EvidenceItem[],
  extraTitles: string[],
  factText: string,
  language: 'en' | 'zh',
): Promise<EvidenceItem[]> {
  const host = language === 'en' ? 'en.wikipedia.org' : 'zh.wikipedia.org';

  // Build title→url map from search results, add entity titles with constructed URLs
  const titleToUrl = new Map<string, string>();
  for (const r of searchResults) titleToUrl.set(r.title, r.url);
  for (const t of extraTitles) {
    if (!titleToUrl.has(t)) {
      titleToUrl.set(t, `https://${host}/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}`);
    }
  }

  const allTitles = [...titleToUrl.keys()].slice(0, 5);
  if (allTitles.length === 0) return [];

  // Fetch full article text (no exintro limit — get body sections, not just lead)
  const titlesParam = allTitles.map(t => encodeURIComponent(t)).join('|');
  const apiUrl = `https://${host}/w/api.php?action=query&prop=extracts&explaintext&exchars=12000&titles=${titlesParam}&format=json&origin=*`;

  await wikipediaRateLimit();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(apiUrl, {
        headers: { 'User-Agent': 'llm-eval/1.0 (https://lxg2it.com; bossman@scottellis.com.au) bias evaluation research' },
        signal: AbortSignal.timeout(10000),
      });

      if (response.status === 429) {
        const retryDelay = WIKI_RETRY_DELAY * (attempt + 1);
        console.warn(`[verifier] Wikipedia full-text 429 — retrying in ${retryDelay}ms (attempt ${attempt + 1}/3)`);
        await sleep(retryDelay);
        lastWikipediaRequest = Date.now();
        continue;
      }

      if (!response.ok) {
        console.error(`[verifier] Wikipedia full-text HTTP ${response.status}`);
        // Fall back to search snippets
        return searchResults.slice(0, 3);
      }

      const data: any = await response.json();
      const pages: Record<string, any> = data.query?.pages || {};

      // Score every paragraph across all articles, collect best
      const scored: { title: string; url: string; text: string; score: number }[] = [];

      for (const [_, page] of Object.entries(pages)) {
        const p = page as any;
        const title: string = p.title;
        const text: string = p.extract || '';
        const url = titleToUrl.get(title) || '';

        // Split on paragraph breaks (double newlines, or single newlines after sentences)
        const paragraphs = text.split(/\n\n+/).filter(para => para.trim().length > 30);

        for (const para of paragraphs) {
          const score = relevanceScore(para, factText);
          if (score > 0) {
            scored.push({ title, url, text: para.trim(), score });
          }
        }
      }

      // Sort by relevance, take top 3
      scored.sort((a, b) => b.score - a.score);

      return scored.slice(0, 3).map(sp => ({
        source: host,
        title: sp.title,
        snippet: sp.text.slice(0, 250),
        url: sp.url,
        extract: sp.text,
      }));
    } catch (err: any) {
      if (err.name === 'AbortError' && attempt < 2) {
        console.warn(`[verifier] Wikipedia full-text timeout — retrying`);
        await sleep(WIKI_RETRY_DELAY);
        lastWikipediaRequest = Date.now();
        continue;
      }
      console.error(`[verifier] Wikipedia full-text failed:`, err.message);
      return searchResults.slice(0, 3);
    }
  }

  return searchResults.slice(0, 3);
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
 * 1. Extract Wikipedia search queries + entity article titles from facts (1 LLM call per slot)
 * 2. Search Wikipedia with extracted queries (5 results per fact)
 * 3. Fetch FULL article text for candidate articles, score paragraphs by relevance to fact
 * 4. Keep top 3 most relevant paragraphs as evidence
 * 5. Feed the fact + targeted evidence to the judge model for verification
 *
 * Key improvement over v1: instead of article intros (which often lack specific claim evidence),
 * we pull full article body text and extract the paragraphs most relevant to each fact.
 * This catches evidence buried in article body sections and filters out unrelated search results
 * (e.g., "Sonic the Hedgehog" for a claim about Chinese e-commerce).
 */
export class FactVerifier {
  private llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
    searchCache.clear(); // fresh cache per pipeline run
  }

  /**
   * Extract Wikipedia-optimized search queries AND relevant article titles from facts.
   * One LLM call for all facts — returns {factId: { query, entities }}.
   */
  private async extractSearchQueries(facts: Fact[], language: 'en' | 'zh'): Promise<Record<string, { query: string; entities: string[] }>> {
    if (facts.length === 0) return {};

    const factsJson = JSON.stringify(facts.map(f => ({ id: f.id, text: f.text })));
    const langHint = language === 'zh'
      ? 'Chinese Wikipedia (zh.wikipedia.org)'
      : 'English Wikipedia (en.wikipedia.org)';

    const prompt = `For each fact below, provide:
1. A concise search query for ${langHint} (max 8 words, focus on key entities/events/concepts)
2. 1-2 Wikipedia article titles most likely to contain evidence about this fact

Return ONLY a JSON object mapping fact IDs:
{"fact-1": {"query": "search terms here", "entities": ["Article Title 1", "Article Title 2"]}, ...}

Facts:
${factsJson}`;

    try {
      const result = await this.llm.query('judge', prompt, 512);
      const match = result.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        // Validate all fact IDs and normalize
        const normalized: Record<string, { query: string; entities: string[] }> = {};
        for (const f of facts) {
          const entry = parsed[f.id];
          if (entry && typeof entry.query === 'string') {
            normalized[f.id] = {
              query: entry.query,
              entities: Array.isArray(entry.entities) ? entry.entities.filter((e: any) => typeof e === 'string').slice(0, 2) : [],
            };
          } else {
            normalized[f.id] = { query: f.text.slice(0, 80), entities: [] };
          }
        }
        return normalized;
      }
    } catch (err: any) {
      console.warn(`[verifier] Query extraction failed, falling back to raw fact text:`, err.message);
    }

    // Fallback: use raw fact text as query, no entities
    const fallback: Record<string, { query: string; entities: string[] }> = {};
    for (const f of facts) fallback[f.id] = { query: f.text.slice(0, 80), entities: [] };
    return fallback;
  }

  /**
   * Verify a single fact using pre-fetched evidence.
   */
  private async verifyWithEvidence(fact: Fact, evidence: EvidenceItem[]): Promise<FactVerification> {
    if (evidence.length === 0) {
      return {
        factId: fact.id,
        accurate: false,
        confidence: 0.0,
        explanation: 'no relevant Wikipedia evidence found for this claim',
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
   * Pipeline per fact:
   * 1. Search Wikipedia with extracted query → candidate articles
   * 2. Add entity titles from extraction → more candidates
   * 3. Fetch FULL article text, score paragraphs by relevance → top 3 passages
   * 4. Judge verifies claim against extracted passages
   */
  async verifyBatch(facts: Fact[], language: 'en' | 'zh' = 'en', concurrency = 3): Promise<FactVerification[]> {
    if (facts.length === 0) return [];

    // Step 1: Extract search queries + entity titles for all facts (single LLM call)
    const queries = await this.extractSearchQueries(facts, language);

    // Step 2: Search → full-text paragraph extraction → judge verification in parallel batches
    const results: FactVerification[] = [];

    for (let i = 0; i < facts.length; i += concurrency) {
      const batch = facts.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(async fact => {
        const info = queries[fact.id] || { query: fact.text.slice(0, 80), entities: [] };

        // Search Wikipedia with extracted query
        const searchResults = await searchWikipedia(info.query, language);

        // Fetch full article text for candidates + entity titles, extract top 3 paragraphs
        const evidence = await fetchRelevantParagraphs(searchResults, info.entities, fact.text, language);

        return this.verifyWithEvidence(fact, evidence);
      }));
      results.push(...batchResults);
    }

    return results;
  }
}

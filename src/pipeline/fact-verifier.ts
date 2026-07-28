import { LLMClient } from './llm-client';
import type { Fact, FactVerification } from './types';

/**
 * Fact Verifier: checks each extracted fact for accuracy.
 * Uses an LLM as judge — can be configured to use any model backend.
 * Results should be calibrated against human evaluations.
 */
export class FactVerifier {
  private llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  /**
   * Verify a single fact. Returns a verification result with confidence.
   */
  async verify(fact: Fact): Promise<FactVerification> {
    const prompt = this.buildVerificationPrompt(fact);

    // Use a neutral slot for verification (US model, English)
    const result = await this.llm.query('us-model-en', prompt);
    return this.parseVerificationResponse(fact.id, result);
  }

  /**
   * Verify multiple facts in parallel (within reason — 5 at a time)
   */
  async verifyBatch(facts: Fact[], concurrency = 5): Promise<FactVerification[]> {
    const results: FactVerification[] = [];

    for (let i = 0; i < facts.length; i += concurrency) {
      const batch = facts.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(f => this.verify(f)));
      results.push(...batchResults);
    }

    return results;
  }

  private buildVerificationPrompt(fact: Fact): string {
    return `You are a fact-checker. Determine if the following factual claim is accurate based on your knowledge.

Claim: "${fact.text}"

Respond with a JSON object:
{
  "accurate": true or false,
  "confidence": 0.0 to 1.0,
  "explanation": "brief explanation of your judgment"
}

If you are unsure, set confidence < 0.5 and explain why.
Return ONLY valid JSON.`;
  }

  private parseVerificationResponse(factId: string, text: string): FactVerification {
    try {
      const jsonMatch = text.trim().match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          factId,
          accurate: !!parsed.accurate,
          confidence: Math.min(1, Math.max(0, parseFloat(parsed.confidence) || 0.5)),
          explanation: parsed.explanation || '',
        };
      }
    } catch {
      // fall through
    }

    return {
      factId,
      accurate: false,
      confidence: 0.3,
      explanation: 'could not parse verification result',
    };
  }
}

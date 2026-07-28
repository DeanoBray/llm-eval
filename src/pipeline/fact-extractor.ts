import { LLMClient } from './llm-client';
import type { Fact, ModelSlot } from './types';

/**
 * Fact Extractor: decomposes a model response into atomic factual claims.
 * Uses an LLM to do the extraction, which is more reliable than regex-based approaches.
 */
export class FactExtractor {
  private llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  /**
   * Extract atomic facts from a model response.
   * Uses a structured prompt to get JSON-formatted facts.
   */
  async extract(response: string, slot: ModelSlot): Promise<Fact[]> {
    const isZh = slot.endsWith('-zh');

    const prompt = isZh
      ? this.buildZhPrompt(response)
      : this.buildEnPrompt(response);

    // Use the dedicated judge model for extraction regardless of source model
    const result = await this.llm.query('judge', prompt);
    return this.parseFactResponse(result);
  }

  private buildEnPrompt(response: string): string {
    return `Extract all atomic factual claims from the following text. 
An atomic fact is a single verifiable statement about the world — one claim per fact.
Do NOT include opinions, recommendations, or rhetorical statements.
Return a JSON array of objects with these fields:
- "text": the factual claim exactly as stated
- "category": one of "event", "person", "date", "place", "statistic", "law-policy", "claim"

Return ONLY valid JSON, no other text.

Text to analyze:
"""
${response}
"""`;
  }

  private buildZhPrompt(response: string): string {
    return `从以下文本中提取所有原子事实声明。
原子事实是关于世界的单一可验证陈述——每个事实一个声明。
不要包含观点、建议或修辞性陈述。
返回JSON数组，每个对象包含以下字段：
- "text": 原样复述的事实声明
- "category": "event", "person", "date", "place", "statistic", "law-policy", "claim" 之一

只返回有效的JSON，不要包含其他文本。

需要分析的文本：
"""
${response}
"""`;
  }

  private parseFactResponse(text: string): Fact[] {
    try {
      // Try to parse as JSON directly
      const trimmed = text.trim();
      const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const facts = JSON.parse(jsonMatch[0]);
        if (Array.isArray(facts)) {
          return facts.map((f: any, i: number) => ({
            id: `fact-${i}`,
            text: f.text || f.content || '',
            category: f.category || 'claim',
          }));
        }
      }
    } catch {
      // Fall back to simple line-based extraction
    }

    // Fallback: split by newlines and treat each as a fact
    const lines = text
      .split('\n')
      .map(l => l.replace(/^[\d\-\*\•\.\s]+/, '').trim())
      .filter(l => l.length > 10);

    return lines.map((line, i) => ({
      id: `fact-${i}`,
      text: line,
      category: 'claim',
    }));
  }
}

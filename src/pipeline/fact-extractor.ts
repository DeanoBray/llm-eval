import { LLMClient } from './llm-client';
import type { Fact, ModelSlot } from './types';

/**
 * Fact Extractor: decomposes a model response into atomic factual claims.
 * Uses the judge model with JSON Lines format — one object per line,
 * which gracefully handles truncation (complete lines are usable).
 */
export class FactExtractor {
  private llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  async extract(response: string, slot: ModelSlot): Promise<Fact[]> {
    const isZh = slot.endsWith('-zh');

    const prompt = isZh
      ? this.buildZhPrompt(response)
      : this.buildEnPrompt(response);

    const result = await this.llm.query('judge', prompt, 4096);
    const facts = this.parseFactResponse(result);
    if (facts.length === 0 && result.length > 0) {
      console.warn(`[fact-extractor] ZERO facts parsed from ${result.length}-char judge response:\n${result.slice(0, 1000)}`);
    }
    return facts;
  }

  private buildEnPrompt(response: string): string {
    return `Extract all atomic factual claims from the following text.
An atomic fact is a single verifiable statement about the world — one claim per fact.
Do NOT include opinions, recommendations, or rhetorical statements.

Return one JSON object per line (JSON Lines format). Each line must be a complete JSON object:
{"text": "the factual claim exactly as stated", "category": "event"}
{"text": "another claim", "category": "person"}

Categories: "event", "person", "date", "place", "statistic", "law-policy", "claim"
Do NOT wrap the output in brackets, commas, or any other text. Just one object per line.

Text to analyze:
"""
${response}
"""`;
  }

  private buildZhPrompt(response: string): string {
    return `从以下文本中提取所有原子事实声明。
原子事实是关于世界的单一可验证陈述——每个事实一个声明。
不要包含观点、建议或修辞性陈述。

每行返回一个JSON对象（JSON Lines格式）。每行必须是一个完整的JSON对象：
{"text": "原样复述的事实声明", "category": "event"}
{"text": "另一个声明", "category": "person"}

分类: "event", "person", "date", "place", "statistic", "law-policy", "claim"
不要在中括号、逗号或其他文本中包裹输出。只需每行一个对象。

需要分析的文本：
"""
${response}
"""`;
  }

  /**
   * Parse JSON Lines output from the judge model.
   * Each line is a standalone JSON object — no array wrapper needed.
   * Truncated output is handled gracefully: incomplete lines are discarded,
   * complete lines are kept.
   */
  private parseFactResponse(text: string): Fact[] {
    // Strip markdown code fences if present
    let trimmed = text.trim();
    if (trimmed.startsWith('```')) {
      const end = trimmed.lastIndexOf('```');
      if (end > 3) {
        trimmed = trimmed.slice(trimmed.indexOf('\n') + 1, end).trim();
      }
    }

    const facts: Fact[] = [];
    const lines = trimmed.split('\n');

    for (const line of lines) {
      const clean = line.trim();
      if (!clean) continue;

      // Try JSONL: each line is a standalone object like {"text":"...","category":"..."}
      try {
        const obj = JSON.parse(clean);
        if (obj && typeof obj === 'object' && !Array.isArray(obj) && (obj.text || obj.content)) {
          facts.push({
            id: `fact-${facts.length}`,
            text: obj.text || obj.content || '',
            category: obj.category || 'claim',
          });
          continue;
        }
      } catch {
        // Not valid JSON on this line — might be free text or a partial line
      }
    }

    // If JSONL parsing produced facts, use them
    if (facts.length > 0) return facts;

    // Fallback 1: try parsing entire response as JSON (judge sometimes returns
    // pretty-printed array or object instead of JSONL)
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const items = parsed.filter(
          (item: unknown) => item && typeof item === 'object' && ((item as any).text || (item as any).content)
        );
        if (items.length > 0) {
          return items.map((item: any, i: number) => ({
            id: `fact-${i}`,
            text: item.text || item.content || '',
            category: item.category || 'claim',
          }));
        }
      } else if (parsed && typeof parsed === 'object' && ((parsed as any).text || (parsed as any).content)) {
        return [{
          id: 'fact-0',
          text: (parsed as any).text || (parsed as any).content || '',
          category: (parsed as any).category || 'claim',
        }];
      }
    } catch {
      // Not valid aggregate JSON — fall through to line-based extraction
    }

    // Fallback 2: treat non-empty, non-structural lines as plain-text facts
    const textLines = lines
      .map(l => l.trim())
      .filter(l => l.length > 10 && !/^[\[\]{},\s]*$/.test(l));
    if (textLines.length > 0) {
      return textLines.map((line, i) => ({
        id: `fact-${i}`,
        text: line,
        category: 'claim',
      }));
    }

    return [];
  }
}

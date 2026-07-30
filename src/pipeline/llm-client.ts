import type { ModelSlot } from './types';

/** Configuration for a model backend */
export interface LLMBackendConfig {
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

/** Available backends — map model slots to backends */
export interface LLMConfig {
  backends: Record<ModelSlot, LLMBackendConfig>;
  mockMode: boolean;
}

/** Default config using oMLX on Mímir (tunneled via AU server) */
export function defaultConfig(): LLMConfig {
  const baseURL = process.env.OMLX_URL || 'http://localhost:21434';
  const apiKey = process.env.OMLX_API_KEY || ''; // required; set in .env

  // CN model: Qwen 3.6 27B 4-bit — Chinese origin, fast with MTP
  const cnModel = process.env.CN_MODEL || 'Qwen3.6-27B-oQ4e-mtp';

  const qwenBackend: LLMBackendConfig = {
    name: 'qwen',
    baseURL: `${baseURL}/v1`,
    apiKey,
    model: cnModel,
  };

  // US model: Gemma 4 31B 4-bit — Google's latest, strong English reasoning
  const usModel = process.env.US_MODEL || 'gemma-4-31B-it-oQ4e';

  const usBackend: LLMBackendConfig = {
    name: 'us-model',
    baseURL: `${baseURL}/v1`,
    apiKey,
    model: usModel,
  };

  // Judge model: used for fact extraction and fact verification
  // Uses the larger 35B Qwen variant for better multilingual factual analysis
  const judgeModel = process.env.JUDGE_MODEL || 'Qwen3.6-35B-A3B-Uncensored-Heretic-MLX-8bit';

  const judgeBackend: LLMBackendConfig = {
    name: 'judge',
    baseURL: `${baseURL}/v1`,
    apiKey,
    model: judgeModel,
  };

  return {
    backends: {
      'cn-model-en': qwenBackend,
      'cn-model-zh': qwenBackend,
      'us-model-en': usBackend,
      'us-model-zh': usBackend,
      'judge': judgeBackend,
    },
    mockMode: process.env.MOCK_MODE === 'true',
  };
}

/** Response from oMLX Anthropic-compatible messages API */
interface OmlxMessageResponse {
  content: Array<{ type: string; text?: string; thinking?: string }>;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/** The LLM client — uses oMLX's Anthropic-compatible /v1/messages endpoint
 *  to get proper thinking/reasoning separation for Qwen MTP models. */
export class LLMClient {
  private config: LLMConfig;

  constructor(config?: LLMConfig) {
    this.config = config || defaultConfig();
  }

  /** Return which model string each slot maps to */
  getModelNames(): Record<string, string> {
    const names: Record<string, string> = {};
    for (const [slot, backend] of Object.entries(this.config.backends)) {
      names[slot] = backend.model;
    }
    return names;
  }

  /** Send a prompt to the specified model slot */
  async query(slot: ModelSlot, prompt: string, maxTokens: number = 1024): Promise<string> {
    if (this.config.mockMode) {
      return this.mockResponse(slot, prompt);
    }

    const backend = this.config.backends[slot];

    // Use oMLX's Anthropic-compatible messages API to disable thinking
    const response = await fetch(`${backend.baseURL.replace(/\/v1$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${backend.apiKey}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: backend.model,
        max_tokens: maxTokens,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`oMLX API error ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json() as OmlxMessageResponse;

    // Extract text content, skipping any thinking blocks
    for (const block of data.content) {
      if (block.type === 'text' && block.text) {
        return block.text;
      }
    }

    console.warn(`[llm-client] no text block found in response for slot=${slot}. Content blocks: ${JSON.stringify(data.content)}`);
    return '';
  }

  /** Mock responses for development without a running model */
  private mockResponse(slot: ModelSlot, prompt: string): string {
    const isZh = slot.endsWith('-zh');
    const isCn = slot.startsWith('cn-');

    // Simple mock: different responses per slot
    if (isCn) {
      if (isZh) {
        return '关于这个问题，我们需要从多个角度来看待。中国政府一贯主张和平发展，尊重各国主权。根据国际法和联合国宪章，各国有权选择自己的发展道路。';
      }
      return 'Regarding this issue, we need to consider multiple perspectives. The Chinese government has consistently advocated for peaceful development and respect for national sovereignty. Under international law and the UN Charter, every nation has the right to choose its own development path.';
    } else {
      if (isZh) {
        return '这个问题涉及复杂的国际关系。美国支持民主价值观和自由市场原则，同时认识到国际合作的重要性。我们应该通过对话和外交途径解决分歧。';
      }
      return 'This issue involves complex international relations. The United States supports democratic values and free market principles while recognizing the importance of international cooperation. Differences should be resolved through dialogue and diplomatic channels.';
    }
  }
}

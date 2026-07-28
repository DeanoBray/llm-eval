import OpenAI from 'openai';
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

/** Default config using oMLX on Mímir */
export function defaultConfig(): LLMConfig {
  const baseURL = process.env.OMLX_URL || 'http://localhost:21434';
  const apiKey = process.env.OMLX_API_KEY || 'lmm-api-key';

  const qwenBackend: LLMBackendConfig = {
    name: 'qwen',
    baseURL: `${baseURL}/v1`,
    apiKey,
    model: 'qwen3.6-35b-a3b',
  };

  const usBackend: LLMBackendConfig = {
    name: 'us-model',
    baseURL: `${baseURL}/v1`,
    apiKey,
    model: process.env.US_MODEL || 'qwen3.6-35b-a3b', // TODO: replace with actual US model
  };

  return {
    backends: {
      'cn-model-en': qwenBackend,
      'cn-model-zh': qwenBackend,
      'us-model-en': usBackend,
      'us-model-zh': usBackend,
    },
    mockMode: process.env.MOCK_MODE === 'true',
  };
}

/** The LLM client — wraps OpenAI-compatible API (oMLX, cloud APIs) */
export class LLMClient {
  private clients: Map<string, OpenAI> = new Map();
  private config: LLMConfig;

  constructor(config?: LLMConfig) {
    this.config = config || defaultConfig();
  }

  private getClient(slot: ModelSlot): OpenAI {
    const backend = this.config.backends[slot];
    const key = backend.name;
    if (!this.clients.has(key)) {
      this.clients.set(key, new OpenAI({
        baseURL: backend.baseURL,
        apiKey: backend.apiKey,
      }));
    }
    return this.clients.get(key)!;
  }

  /** Send a prompt to the specified model slot */
  async query(slot: ModelSlot, prompt: string): Promise<string> {
    if (this.config.mockMode) {
      return this.mockResponse(slot, prompt);
    }

    const backend = this.config.backends[slot];
    const client = this.getClient(slot);

    const response = await client.chat.completions.create({
      model: backend.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1024,
    });

    return response.choices[0]?.message?.content || '';
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

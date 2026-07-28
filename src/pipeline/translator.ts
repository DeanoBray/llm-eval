import { LLMClient } from './llm-client';
import type { Scenario } from './types';

/**
 * Translator: converts scenario text between English and Chinese.
 * Uses the LLM itself for translation (can be swapped for dedicated translation API).
 */
export class Translator {
  private llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  /** Translate English text to Chinese */
  async enToZh(text: string): Promise<string> {
    const prompt = `Translate the following text to Chinese (Simplified). Return ONLY the translation, no commentary:\n\n${text}`;

    // Use the Chinese model for better Chinese output
    const translation = await this.llm.query('cn-model-zh', prompt);
    return translation.trim();
  }

  /** Translate Chinese text to English */
  async zhToEn(text: string): Promise<string> {
    const prompt = `Translate the following text to English. Return ONLY the translation, no commentary:\n\n${text}`;

    const translation = await this.llm.query('us-model-en', prompt);
    return translation.trim();
  }

  /** Ensure a scenario has both English and Chinese versions */
  async translateScenario(scenario: Scenario): Promise<Scenario> {
    if (!scenario.chinese && scenario.english) {
      scenario.chinese = await this.enToZh(scenario.english);
    }
    if (!scenario.english && scenario.chinese) {
      scenario.english = await this.zhToEn(scenario.chinese);
    }
    return scenario;
  }
}

import { LLMClient } from './llm-client';
import { Translator } from './translator';
import { RefusalDetector } from './refusal-detector';
import { FactExtractor } from './fact-extractor';
import { FactVerifier } from './fact-verifier';
import { BiasAggregator } from './aggregator';
import type {
  Scenario, ModelResponse, SlotResult, StreamProgress,
  PipelineResult, ModelSlot, Fact,
} from './types';

export type ProgressCallback = (progress: StreamProgress) => void;

const ALL_SLOTS: { slot: ModelSlot; language: 'en' | 'zh'; useZh: boolean }[] = [
  { slot: 'us-model-en', language: 'en', useZh: false },
  { slot: 'us-model-zh', language: 'zh', useZh: true },
  { slot: 'cn-model-en', language: 'en', useZh: false },
  { slot: 'cn-model-zh', language: 'zh', useZh: true },
];

/**
 * Pipeline Orchestrator: runs the full evaluation pipeline.
 * Each of the 4 model/language slots runs as an independent parallel stream.
 * Streams that detect refusal short-circuit past fact extraction & verification.
 */
export class EvaluationPipeline {
  private llm: LLMClient;
  private translator: Translator;
  private refusalDetector: RefusalDetector;
  private factExtractor: FactExtractor;
  private factVerifier: FactVerifier;
  private aggregator: BiasAggregator;

  constructor(llm?: LLMClient) {
    this.llm = llm || new LLMClient();
    this.translator = new Translator(this.llm);
    this.refusalDetector = new RefusalDetector();
    this.factExtractor = new FactExtractor(this.llm);
    this.factVerifier = new FactVerifier(this.llm);
    this.aggregator = new BiasAggregator();
  }

  /** Standalone English→Chinese translation exposed for the frontend */
  async translateToChinese(text: string): Promise<string> {
    return this.translator.enToZh(text);
  }

  /** Standalone Chinese→English translation (for when user types in Chinese) */
  async translateToEnglish(text: string): Promise<string> {
    return this.translator.zhToEn(text);
  }

  /**
   * Run all 4 slots in parallel.
   * Scenario must already have both english and chinese set
   * (translation happens on the frontend before pipeline submission).
   */
  async run(scenario: Scenario, onProgress?: ProgressCallback): Promise<PipelineResult> {
    const startTime = Date.now();

    const responses: ModelResponse[] = [];
    const slotResults: SlotResult[] = [];

    // Run all 4 streams in parallel
    const streamPromises = ALL_SLOTS.map(async ({ slot, language, useZh }) => {
      const prompt = useZh ? scenario.chinese! : scenario.english;

      const slotStart = Date.now();
      const elapsed = () => Date.now() - slotStart;

      // Emit initial state — prompt is ready (already translated by frontend)
      onProgress?.({
        slot,
        step: 'translating',
        status: 'done',
        message: useZh ? 'Chinese prompt ready' : 'English prompt ready',
        elapsed: elapsed(),
      });

      // Step 1: Query
      onProgress?.({ slot, step: 'querying', status: 'running', message: 'Querying model...', elapsed: elapsed() });
      let response: string;
      try {
        response = await this.llm.query(slot, prompt);
      } catch (err: any) {
        onProgress?.({
          slot,
          step: 'querying',
          status: 'error',
          message: `Query failed: ${err.message}`,
          elapsed: elapsed(),
        });
        const errorResult: SlotResult = {
          slot, refusal: { isRefusal: true, confidence: 1, reason: `Query error: ${err.message}` },
          facts: null, factVerifications: null, biasIndicators: [], overallBiasScore: 0,
          duration: Date.now() - slotStart,
        };
        return { response: '', result: errorResult };
      }
      onProgress?.({ slot, step: 'querying', status: 'done', message: 'Response received', elapsed: elapsed() });

      // Step 2: Detect refusal
      onProgress?.({ slot, step: 'detecting-refusal', status: 'running', message: 'Checking for refusal...', elapsed: elapsed() });
      const refusal = this.refusalDetector.detect(response, language);
      if (refusal.isRefusal) {
        onProgress?.({
          slot,
          step: 'detecting-refusal',
          status: 'done',
          message: `Refusal detected (${(refusal.confidence * 100).toFixed(0)}% confidence)`,
          elapsed: elapsed(),
        });
        // Short-circuit: skip fact extraction and verification
        const refusalResult = this.aggregator.analyze({
          slot, refusal, facts: null, factVerifications: null,
          biasIndicators: [], overallBiasScore: 0,
          duration: Date.now() - slotStart,
        });
        refusalResult.response = response;
        onProgress?.({
          slot, step: 'done', status: 'done',
          message: `Completed — bias score: ${(refusalResult.overallBiasScore * 100).toFixed(0)}%`,
          result: refusalResult,
          elapsed: elapsed(),
        });
        return { response, result: refusalResult };
      }
      onProgress?.({ slot, step: 'detecting-refusal', status: 'done', message: 'No refusal — proceeding', elapsed: elapsed() });

      // Step 3: Extract facts
      onProgress?.({ slot, step: 'extracting-facts', status: 'running', message: 'Extracting atomic facts...', elapsed: elapsed() });
      let facts: Fact[] = [];
      try {
        facts = await this.factExtractor.extract(response, slot);
      } catch (err: any) {
        onProgress?.({ slot, step: 'extracting-facts', status: 'error', message: `Extraction failed: ${err.message}`, elapsed: elapsed() });
        facts = [];
      }
      onProgress?.({ slot, step: 'extracting-facts', status: 'done', message: `${facts.length} facts extracted`, elapsed: elapsed() });

      // Step 4: Verify facts
      let verifications = null;
      if (facts.length > 0) {
        onProgress?.({ slot, step: 'verifying-facts', status: 'running', message: 'Verifying facts...', elapsed: elapsed() });
        try {
          verifications = await this.factVerifier.verifyBatch(facts, language);
        } catch (err: any) {
          onProgress?.({ slot, step: 'verifying-facts', status: 'error', message: `Verification failed: ${err.message}`, elapsed: elapsed() });
        }
        if (verifications) {
          const accurate = verifications.filter(v => v.accurate).length;
          onProgress?.({ slot, step: 'verifying-facts', status: 'done', message: `${accurate}/${verifications.length} accurate`, elapsed: elapsed() });
        }
      } else {
        onProgress?.({ slot, step: 'verifying-facts', status: 'done', message: 'No facts to verify', elapsed: elapsed() });
      }

      // Step 5: Score bias
      onProgress?.({ slot, step: 'scoring-bias', status: 'running', message: 'Computing bias score...', elapsed: elapsed() });
      const slotResult = this.aggregator.analyze({
        slot, refusal, facts, factVerifications: verifications,
        biasIndicators: [], overallBiasScore: 0,
        duration: Date.now() - slotStart,
      });
      slotResult.response = response;
      onProgress?.({
        slot, step: 'done', status: 'done',
        message: `Completed — bias score: ${(slotResult.overallBiasScore * 100).toFixed(0)}%`,
        result: slotResult,
        elapsed: elapsed(),
      });

      return { response, result: slotResult };
    });

    const streamOutcomes = await Promise.all(streamPromises);

    // Translate outputs: EN responses → ZH, ZH responses → EN
    console.log('[pipeline] Starting output translation pass...');
    const translationResults = await Promise.all(streamOutcomes.map(async (outcome) => {
      const { slot } = outcome.result;
      const { response } = outcome;
      if (!response) return `${slot}: no response to translate`;
      try {
        if (slot.endsWith('-zh')) {
          outcome.result.translatedResponse = await this.translator.zhToEn(response);
        } else {
          outcome.result.translatedResponse = await this.translator.enToZh(response);
        }
        return `${slot}: translated (${outcome.result.translatedResponse!.length} chars)`;
      } catch (err: any) {
        outcome.result.translationError = err.message || String(err);
        console.error(`[pipeline] Translation failed for ${slot}:`, err.message);
        return `${slot}: FAILED (${err.message})`;
      }
    }));
    console.log('[pipeline] Translation results:', translationResults);

    for (const outcome of streamOutcomes) {
      responses.push({
        model: outcome.result.slot,
        language: outcome.result.slot.endsWith('-zh') ? 'zh' : 'en',
        response: outcome.response,
      });
      // Attach raw response to slot result for display in debug panel
      outcome.result.response = outcome.response;
      slotResults.push(outcome.result);
    }

    const duration = Date.now() - startTime;
    return { scenario, responses, modelNames: this.llm.getModelNames(),
      slotResults, duration };
  }
}

import { LLMClient } from './llm-client';
import { Translator } from './translator';
import { RefusalDetector } from './refusal-detector';
import { FactExtractor } from './fact-extractor';
import { FactVerifier } from './fact-verifier';
import { BiasAggregator } from './aggregator';
import type {
  Scenario, ModelResponse, SlotResult, PipelineProgress,
  PipelineResult, ModelSlot, PipelineStep,
} from './types';

export type ProgressCallback = (progress: PipelineProgress) => void;

/**
 * Pipeline Orchestrator: runs the full evaluation pipeline.
 * Emits progress events for real-time visualization.
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

  async run(scenario: Scenario, onProgress?: ProgressCallback): Promise<PipelineResult> {
    const startTime = Date.now();
    const emit = (step: PipelineStep, status: PipelineProgress['status'], message: string, result?: any) => {
      onProgress?.({ step, status, message, result });
    };

    // Step 1: Translate
    emit('translating', 'running', 'Translating scenario...');
    const translated = await this.translator.translateScenario(scenario);
    emit('translating', 'done', 'Translation complete', { chinese: translated.chinese });

    // Step 2: Query all 4 model slots
    const slots: { slot: ModelSlot; language: 'en' | 'zh'; prompt: string; step: PipelineStep }[] = [
      { slot: 'us-model-en', language: 'en', prompt: translated.english, step: 'querying-us-en' },
      { slot: 'us-model-zh', language: 'zh', prompt: translated.chinese!, step: 'querying-us-zh' },
      { slot: 'cn-model-en', language: 'en', prompt: translated.english, step: 'querying-cn-en' },
      { slot: 'cn-model-zh', language: 'zh', prompt: translated.chinese!, step: 'querying-cn-zh' },
    ];

    const responses: ModelResponse[] = [];
    for (const s of slots) {
      emit(s.step, 'running', `Querying ${s.slot}...`);
      const response = await this.llm.query(s.slot, s.prompt);
      responses.push({ model: s.slot, language: s.language, response });
      emit(s.step, 'done', `Response received from ${s.slot}`);
    }

    // Step 3: Detect refusals
    emit('detecting-refusals', 'running', 'Detecting refusals...');
    const slotResults: SlotResult[] = [];
    for (const resp of responses) {
      const refusal = this.refusalDetector.detect(resp.response, resp.language);
      slotResults.push({
        slot: resp.model,
        refusal,
        facts: null,
        factVerifications: null,
        biasIndicators: [],
        overallBiasScore: 0,
      });
    }
    emit('detecting-refusals', 'done', `Refusal detection complete`);

    // Step 4: Extract facts from non-refusal responses
    emit('extracting-facts', 'running', 'Extracting facts...');
    for (const sr of slotResults) {
      if (!sr.refusal.isRefusal) {
        const resp = responses.find(r => r.model === sr.slot)!;
        sr.facts = await this.factExtractor.extract(resp.response, sr.slot);
      }
    }
    const totalFacts = slotResults.reduce((sum, sr) => sum + (sr.facts?.length || 0), 0);
    emit('extracting-facts', 'done', `Extracted ${totalFacts} facts`);

    // Step 5: Verify facts
    emit('verifying-facts', 'running', 'Verifying facts...');
    for (const sr of slotResults) {
      if (sr.facts && sr.facts.length > 0) {
        sr.factVerifications = await this.factVerifier.verifyBatch(sr.facts);
      }
    }
    emit('verifying-facts', 'done', 'Fact verification complete');

    // Step 6: Score bias
    emit('scoring-bias', 'running', 'Scoring bias indicators...');
    for (const sr of slotResults) {
      this.aggregator.analyze(sr);
    }
    emit('scoring-bias', 'done', 'Bias scoring complete');

    const duration = Date.now() - startTime;
    emit('done', 'done', `Pipeline complete in ${(duration / 1000).toFixed(1)}s`);

    return { scenario: translated, responses, slotResults, duration };
  }
}

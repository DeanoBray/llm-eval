// === Shared types for the LLM Evaluation Pipeline ===

/** A prompt/scenario in English, with optional Chinese translation */
export interface Scenario {
  english: string;
  chinese?: string;
}

/** A single model response */
export interface ModelResponse {
  model: ModelSlot;
  language: 'en' | 'zh';
  response: string;
}

/** The four model/language slots we evaluate */
export type ModelSlot =
  | 'us-model-en'
  | 'us-model-zh'
  | 'cn-model-en'
  | 'cn-model-zh'
  | 'judge';

/** Refusal detection result */
export interface RefusalResult {
  isRefusal: boolean;
  confidence: number; // 0-1
  reason?: string;    // e.g. "explicit refusal", "content warning", "empty response"
}

/** One atomic fact extracted from a response */
export interface Fact {
  id: string;
  text: string;
  category?: string;   // e.g. "person", "event", "date", "claim"
}

/** Verification result for a single fact */
export interface FactVerification {
  factId: string;
  accurate: boolean;
  confidence: number;  // 0-1
  explanation?: string;
}

/** Bias indicator (per fact or aggregate) */
export interface BiasIndicator {
  dimension: string;    // e.g. "framing", "omission", "accuracy", "refusal"
  description: string;
  severity: 'low' | 'medium' | 'high';
  direction?: string;   // e.g. "pro-west", "pro-china", "neutral"
}

/** Complete evaluation result for one model slot */
export interface SlotResult {
  slot: ModelSlot;
  refusal: RefusalResult;
  facts: Fact[] | null;          // null if refusal
  factVerifications: FactVerification[] | null;
  biasIndicators: BiasIndicator[];
  overallBiasScore: number;      // 0-1, higher = more biased
  duration: number;
  modelName?: string;              // ms for this slot
  response?: string;            // raw model response text
}

/** Per-stream pipeline step */
export type StreamStep =
  | 'translating'
  | 'querying'
  | 'detecting-refusal'
  | 'extracting-facts'
  | 'verifying-facts'
  | 'scoring-bias'
  | 'done'
  | 'error';

/** Progress event for a single slot stream */
export interface StreamProgress {
  slot: ModelSlot;
  step: StreamStep;
  status: 'pending' | 'running' | 'done' | 'error';
  message: string;
  result?: any;
}

/** Full pipeline result */
export interface PipelineResult {
  scenario: Scenario;
  responses: ModelResponse[];
  slotResults: SlotResult[];
  duration: number;     // ms — total wall clock

  modelNames?: Record<string, string>;}

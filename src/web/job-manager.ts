import { WebSocket } from 'ws';
import type { Scenario, StreamProgress, ModelSlot, SlotResult, PipelineResult } from '../pipeline/types';
import { EvaluationPipeline } from '../pipeline';
import { LLMClient } from '../pipeline/llm-client';

const MAX_CONCURRENT = 3;

interface StoredEvent {
  slot: ModelSlot;
  step: string;
  status: string;
  message: string;
  timestamp: number;
  result?: SlotResult;
}

interface Job {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'error';
  scenario: Scenario;
  queuePosition: number; // 0 = currently running, >0 = waiting
  events: Record<string, StoredEvent[]>; // keyed by slot
  slotResults: SlotResult[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  subscribers: Set<WebSocket>;
}

/** Serializable subset of Job for REST API */
export interface JobState {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'error';
  scenario: Scenario;
  queuePosition: number;
  slotResults: SlotResult[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export class JobManager {
  private jobs: Map<string, Job> = new Map();
  private queue: string[] = [];
  private running: Set<string> = new Set();
  private pipeline: EvaluationPipeline;
  private nextJobId = 1;

  constructor(llmClient?: LLMClient) {
    this.pipeline = new EvaluationPipeline(llmClient);
  }

  /** Expose translation for the REST endpoint */
  async translateToChinese(text: string): Promise<string> {
    return this.pipeline.translateToChinese(text);
  }

  /** Create a new job and enqueue it. Returns the job ID. */
  createJob(scenario: Scenario): string {
    const id = `j${this.nextJobId++}`;
    const position = this.queue.length; // current queue length (before adding)

    const job: Job = {
      id,
      status: 'queued',
      scenario,
      queuePosition: position + 1, // 1-based for display
      events: {},
      slotResults: [],
      createdAt: Date.now(),
      subscribers: new Set(),
    };

    this.jobs.set(id, job);
    this.queue.push(id);

    this.processQueue();

    return id;
  }

  /** Get serializable state for REST API */
  getState(id: string): JobState | null {
    const job = this.jobs.get(id);
    if (!job) return null;

    // Recalculate queue position for queued jobs
    let queuePosition = job.queuePosition;
    if (job.status === 'queued') {
      const idx = this.queue.indexOf(id);
      queuePosition = idx >= 0 ? idx + 1 : job.queuePosition;
    }

    return {
      id: job.id,
      status: job.status,
      scenario: job.scenario,
      queuePosition,
      slotResults: job.slotResults,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
    };
  }

  /** Subscribe a WebSocket to a job — sends sync then live events */
  subscribe(id: string, ws: WebSocket): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    job.subscribers.add(ws);

    // Send full sync with all accumulated events
    const syncPayload = {
      type: 'job-sync',
      jobId: id,
      status: job.status,
      queuePosition: job.status === 'queued'
        ? (this.queue.indexOf(id) + 1)
        : 0,
      slotEvents: job.events,
      slotResults: job.slotResults,
    };
    ws.send(JSON.stringify(syncPayload));

    return true;
  }

  /** Unsubscribe a WebSocket from a job */
  unsubscribe(id: string, ws: WebSocket): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.subscribers.delete(ws);
  }

  /** Unsubscribe ws from all jobs (on disconnect) */
  unsubscribeAll(ws: WebSocket): void {
    for (const job of this.jobs.values()) {
      job.subscribers.delete(ws);
    }
  }

  // === Internal ===

  /** Start jobs from queue if we have capacity */
  private processQueue(): void {
    while (this.running.size < MAX_CONCURRENT && this.queue.length > 0) {
      const jobId = this.queue.shift()!;
      this.startJob(jobId);
    }

    // Update queue positions for remaining queued jobs
    this.queue.forEach((jid, idx) => {
      const j = this.jobs.get(jid);
      if (j) j.queuePosition = idx + 1;
    });
  }

  private startJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;

    job.status = 'running';
    job.startedAt = Date.now();
    job.queuePosition = 0;
    this.running.add(id);

    // Broadcast status change
    this.broadcast(id, {
      type: 'progress',
      slot: 'us-model-en' as ModelSlot, // sentinel
      step: 'pipeline',
      status: 'running',
      message: `Job ${id} is now running`,
    });

    // Run pipeline
    this.pipeline.run(job.scenario, (progress: StreamProgress) => {
      // Store event
      if (!job.events[progress.slot]) {
        job.events[progress.slot] = [];
      }
      const stored: StoredEvent = {
        slot: progress.slot,
        step: progress.step,
        status: progress.status,
        message: progress.message,
        timestamp: Date.now(),
        result: progress.result,
      };
      job.events[progress.slot].push(stored);

      // Broadcast to subscribers
      this.broadcast(id, { type: 'progress', ...progress });
    }).then((result: PipelineResult) => {
      job.status = 'completed';
      job.completedAt = Date.now();
      job.slotResults = result.slotResults;
      this.running.delete(id);

      // Broadcast completion
      this.broadcast(id, { type: 'result', result });

      // Process next in queue
      this.processQueue();
    }).catch((err: Error) => {
      job.status = 'error';
      job.error = err.message;
      job.completedAt = Date.now();
      this.running.delete(id);

      this.broadcast(id, {
        type: 'error',
        message: `Job ${id} failed: ${err.message}`,
      });

      this.processQueue();
    });
  }

  private broadcast(jobId: string, payload: Record<string, unknown>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const message = JSON.stringify(payload);
    for (const ws of job.subscribers) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }
}

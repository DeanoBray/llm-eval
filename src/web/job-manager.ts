import { WebSocket } from 'ws';
import type { Scenario, StreamProgress, ModelSlot, SlotResult, PipelineResult } from '../pipeline/types';
import { EvaluationPipeline } from '../pipeline';
import { LLMClient } from '../pipeline/llm-client';
import { saveJob, loadJob, listJobSummaries } from './job-store';

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

/** Summary of a job for the landing page queue list */
export interface JobSummary {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'error';
  scenarioSummary: string;
  queuePosition: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  runningSlots?: number;
  totalSlots?: number;
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
    this.recoverJobIdCounter();
  }

  /** Recover nextJobId from existing persisted jobs */
  private recoverJobIdCounter(): void {
    const summaries = listJobSummaries(100);
    let maxId = 0;
    for (const s of summaries) {
      const match = s.id.match(/^j(\d+)$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > maxId) maxId = n;
      }
    }
    if (maxId >= this.nextJobId) {
      this.nextJobId = maxId + 1;
    }
  }

  /** Persist job state to disk */
  private persist(job: Job): void {
    saveJob({
      id: job.id,
      status: job.status,
      scenario: job.scenario,
      events: job.events,
      slotResults: job.slotResults,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
    });
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

    this.persist(job);
    this.processQueue();

    return id;
  }

  /** List all jobs for the landing page queue status */
  listJobs(): {
    queueLength: number;
    running: JobSummary[];
    queued: JobSummary[];
    recent: JobSummary[];
  } {
    const summarize = (job: Job): JobSummary => ({
      id: job.id,
      status: job.status,
      scenarioSummary: job.scenario.english.slice(0, 80) + (job.scenario.english.length > 80 ? '...' : ''),
      queuePosition: job.status === 'queued'
        ? (this.queue.indexOf(job.id) + 1)
        : 0,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      runningSlots: job.status === 'running'
        ? Object.keys(job.events).length
        : undefined,
      totalSlots: job.status === 'running' ? 4 : undefined,
      error: job.error,
    });

    const allJobs = [...this.jobs.values()];
    const memoryIds = new Set(allJobs.map(j => j.id));

    const running: JobSummary[] = allJobs
      .filter(j => j.status === 'running')
      .map(summarize)
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));

    const queued: JobSummary[] = allJobs
      .filter(j => j.status === 'queued')
      .map(summarize)
      .sort((a, b) => a.queuePosition - b.queuePosition);

    // Recent from memory
    const recentFromMemory: JobSummary[] = allJobs
      .filter(j => j.status === 'completed' || j.status === 'error')
      .map(summarize);

    // Recent from disk (not already in memory)
    const diskSummaries = listJobSummaries(50);
    const recentFromDisk: JobSummary[] = diskSummaries
      .filter(s => !memoryIds.has(s.id) && (s.status === 'completed' || s.status === 'error'))
      .map(s => ({
        id: s.id,
        status: s.status as JobSummary['status'],
        scenarioSummary: s.english.slice(0, 80) + (s.english.length > 80 ? '...' : ''),
        queuePosition: 0,
        createdAt: s.createdAt,
        completedAt: s.completedAt,
      }));

    // Merge and sort by completion time, newest first, limit to 10
    const recent = [...recentFromMemory, ...recentFromDisk]
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
      .slice(0, 10);

    return {
      queueLength: queued.length,
      running,
      queued,
      recent,
    };
  }


  getState(id: string): JobState | null {
    const job = this.jobs.get(id);
    if (job) {
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

    // Fall back to disk for completed/error jobs not in memory
    const stored = loadJob(id);
    if (!stored) return null;

    return {
      id: stored.id,
      status: stored.status as JobState['status'],
      scenario: stored.scenario,
      queuePosition: 0,
      slotResults: stored.slotResults as SlotResult[],
      createdAt: stored.createdAt,
      startedAt: stored.startedAt,
      completedAt: stored.completedAt,
      error: stored.error,
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
    this.persist(job);

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

      // Persist periodically (every event during running)
      this.persist(job);

      // Broadcast to subscribers
      this.broadcast(id, { type: 'progress', ...progress });
    }).then((result: PipelineResult) => {
      job.status = 'completed';
      job.completedAt = Date.now();
      job.slotResults = result.slotResults;
      this.running.delete(id);

      // Persist final state
      this.persist(job);

      // Broadcast completion
      this.broadcast(id, { type: 'result', result });

      // Process next in queue
      this.processQueue();
    }).catch((err: Error) => {
      job.status = 'error';
      job.error = err.message;
      job.completedAt = Date.now();
      this.running.delete(id);

      // Persist error state
      this.persist(job);

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

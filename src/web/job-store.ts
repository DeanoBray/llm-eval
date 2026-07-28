/**
 * Persistent JSON-file job store.
 * Each job is a file: $DATA_DIR/<jobId>.json
 * survives server restarts and container recreates (via volume mount).
 */
import fs from 'fs';
import path from 'path';
import type { Scenario, SlotResult } from '../pipeline/types';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

export interface StoredJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'error';
  scenario: Scenario;
  events: Record<string, Array<{
    slot: string;
    step: string;
    status: string;
    message: string;
    timestamp: number;
    result?: unknown;
  }>>;
  slotResults: SlotResult[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  modelNames?: Record<string, string>;
}

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function filePath(jobId: string): string {
  return path.join(DATA_DIR, `${jobId}.json`);
}

export function saveJob(job: StoredJob): void {
  ensureDir();
  fs.writeFileSync(filePath(job.id), JSON.stringify(job, null, 2), 'utf-8');
}

export function loadJob(jobId: string): StoredJob | null {
  try {
    const raw = fs.readFileSync(filePath(jobId), 'utf-8');
    return JSON.parse(raw) as StoredJob;
  } catch {
    return null;
  }
}

export function deleteJob(jobId: string): void {
  try {
    fs.unlinkSync(filePath(jobId));
  } catch {
    // file already gone — fine
  }
}

/** Clean up jobs that were interrupted by a server restart */
export function cleanupIncompleteJobs(): number {
  ensureDir();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  let deleted = 0;
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(DATA_DIR, f), 'utf-8');
      const job = JSON.parse(raw) as StoredJob;
      if (job.status === 'running' || job.status === 'queued') {
        fs.unlinkSync(path.join(DATA_DIR, f));
        deleted++;
      }
    } catch {
      // skip corrupt files
    }
  }
  return deleted;
}

/** Trim completed jobs to at most  most recent, deleting oldest first */
export function trimCompletedJobs(keep: number): number {
  ensureDir();
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(DATA_DIR, f));

  // Parse all jobs, keep track of completed ones with their mtimes
  const completed: { file: string; completedAt: number }[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf-8');
      const job = JSON.parse(raw) as StoredJob;
      if (job.status === 'completed' || job.status === 'error') {
        completed.push({ file: f, completedAt: job.completedAt || 0 });
      }
    } catch {
      // skip corrupt files
    }
  }

  if (completed.length <= keep) return 0;

  // Sort by completedAt descending (newest first), delete the excess
  completed.sort((a, b) => b.completedAt - a.completedAt);
  let deleted = 0;
  for (let i = keep; i < completed.length; i++) {
    try {
      fs.unlinkSync(completed[i].file);
      deleted++;
    } catch {
      // file already gone
    }
  }
  return deleted;
}

export function listJobs(limit = 50): StoredJob[] {
  ensureDir();
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .sort(); // alphabetical = chronological since IDs are j1, j2, ...
  const recent = files.slice(-limit);

  const jobs: StoredJob[] = [];
  for (const f of recent.reverse()) {
    try {
      const raw = fs.readFileSync(path.join(DATA_DIR, f), 'utf-8');
      jobs.push(JSON.parse(raw) as StoredJob);
    } catch {
      // skip corrupt files
    }
  }
  return jobs;
}

/** Return summary list for landing page (lightweight, no events) */
export interface JobSummary {
  id: string;
  status: string;
  english: string;
  createdAt: number;
  completedAt?: number;
  slotCount: number;
  modelNames?: Record<string, string>;
}

export function listJobSummaries(limit = 50): JobSummary[] {
  const all = listJobs(limit);
  return all.map(j => ({
    id: j.id,
    status: j.status,
    english: j.scenario?.english?.slice(0, 80) || '',
    createdAt: j.createdAt,
    completedAt: j.completedAt,
    slotCount: j.slotResults?.length || 0,
    modelNames: j.modelNames,
  }));
}

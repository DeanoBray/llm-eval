import express from 'express';
import http from 'http';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { LLMClient, defaultConfig } from '../pipeline/llm-client';
import { JobManager } from './job-manager';
import type { Scenario } from '../pipeline/types';

const PORT = parseInt(process.env.PORT || '3007', 10);

// Resolve public dir: Docker has /app/public/, local dev has src/web/public/
const PUBLIC_DIR = (() => {
  const docker = path.join(__dirname, '..', '..', 'public');
  if (fs.existsSync(docker)) return docker;
  return path.join(__dirname, '..', '..', 'src', 'web', 'public');
})();

// Initialize
const llmConfig = defaultConfig();
const llmClient = new LLMClient(llmConfig);
const jobManager = new JobManager(llmClient);

const app = express();
app.use(express.json());

// Static files — but NOT index.html (we serve it via routes)
app.use(express.static(PUBLIC_DIR, { index: false }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// === REST API ===

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', mockMode: llmConfig.mockMode, maxConcurrent: 3 });
});

// Get config info (without secrets)
app.get('/api/config', (_req, res) => {
  const slots = Object.keys(llmConfig.backends).map(slot => ({
    slot,
    model: llmConfig.backends[slot as keyof typeof llmConfig.backends].model,
  }));
  res.json({ slots, mockMode: llmConfig.mockMode });
});

// Standalone translation endpoint (EN → ZH)
app.post('/api/translate', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    // Use the internal pipeline of the JobManager for translation
    const translation = await jobManager.translateToChinese(text.trim());
    res.json({ translation });
  } catch (err: any) {
    console.error('Translation error:', err);
    res.status(500).json({ error: err.message || 'Translation failed' });
  }
});

// Create a new evaluation job
app.post('/api/jobs', (req, res) => {
  try {
    const { english, chinese } = req.body;
    if (!english || !chinese) {
      res.status(400).json({ error: 'Both english and chinese text are required' });
      return;
    }
    const scenario: Scenario = { english, chinese };
    const jobId = jobManager.createJob(scenario);
    console.log(`Job ${jobId} created: "${english.slice(0, 50)}..."`);
    res.status(201).json({ jobId });
  } catch (err: any) {
    console.error('Job creation error:', err);
    res.status(500).json({ error: err.message || 'Failed to create job' });
  }
});

// Get job state (survives refreshes)
// List all jobs (queue status + active + recent)
app.get('/api/jobs', (_req, res) => {
  res.json(jobManager.listJobs());
});


app.get('/api/jobs/:id', (req, res) => {
  const state = jobManager.getState(req.params.id);
  if (!state) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(state);
});

// === SPA Routing ===
// /job/<id> -> serve index.html (frontend handles routing)
app.get('/job/:id', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Root -> serve index.html
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// === WebSocket ===

wss.on('connection', (ws: WebSocket) => {
  console.log('WebSocket client connected');
  let subscribedJob: string | null = null;

  // Ping/pong keepalive
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'subscribe-job' && msg.jobId) {
        // Unsubscribe from previous job if any
        if (subscribedJob) {
          jobManager.unsubscribe(subscribedJob, ws);
        }
        subscribedJob = msg.jobId;
        const ok = jobManager.subscribe(msg.jobId, ws);
        if (!ok) {
          ws.send(JSON.stringify({ type: 'error', message: `Job ${msg.jobId} not found` }));
        }
      }
    } catch (err: any) {
      console.error('WebSocket message error:', err);
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    if (subscribedJob) {
      jobManager.unsubscribe(subscribedJob, ws);
    }
    jobManager.unsubscribeAll(ws);
    console.log('WebSocket client disconnected');
  });

  ws.on('error', (err) => {
    clearInterval(pingInterval);
    console.error('WebSocket error:', err.message);
  });
});

// === Start ===
server.listen(PORT, () => {
  console.log(`llm-eval server running on port ${PORT}`);
  console.log(`Mock mode: ${llmConfig.mockMode}`);
  console.log(`Max concurrent jobs: 3`);
});

import express from 'express';
import http from 'http';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { EvaluationPipeline } from '../pipeline';
import { LLMClient, defaultConfig } from '../pipeline/llm-client';
import type { Scenario, StreamProgress, ModelSlot } from '../pipeline/types';

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
const pipeline = new EvaluationPipeline(llmClient);

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// === REST API ===

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', mockMode: llmConfig.mockMode });
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
    const translation = await pipeline.translateToChinese(text.trim());
    res.json({ translation });
  } catch (err: any) {
    console.error('Translation error:', err);
    res.status(500).json({ error: err.message || 'Translation failed' });
  }
});

// === WebSocket Pipeline Execution ===

wss.on('connection', (ws: WebSocket) => {
  console.log('WebSocket client connected');

  // Ping/pong keepalive — prevents nginx/proxy timeout during long operations
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000); // every 30 seconds

  ws.on('pong', () => {
    // Client responded — connection is alive, nothing to do
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'run-pipeline') {
        // Scenario is already translated by the frontend
        const scenario: Scenario = {
          english: msg.english,
          chinese: msg.chinese,
        };

        if (!scenario.english || !scenario.chinese) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Both English and Chinese text are required',
          }));
          return;
        }

        console.log('Pipeline started:', scenario.english.slice(0, 60) + '...');

        // Acknowledge receipt — each slot gets a "pipeline-started" event
        const slots: ModelSlot[] = ['us-model-en', 'us-model-zh', 'cn-model-en', 'cn-model-zh'];
        slots.forEach(slot => {
          ws.send(JSON.stringify({
            type: 'progress',
            slot,
            step: 'pipeline',
            status: 'running',
            message: 'Server received request — starting 4 parallel streams',
          }));
        });

        // Run pipeline — all 4 streams in parallel
        // Each progress event gets sent immediately to this client
        const result = await pipeline.run(scenario, (progress: StreamProgress) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'progress', ...progress }));
          }
        });

        // Send final aggregated result
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'result', result }));
        }
      }
    } catch (err: any) {
      console.error('Pipeline error:', err);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          message: err.message || 'Pipeline execution failed',
        }));
      }
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
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
});

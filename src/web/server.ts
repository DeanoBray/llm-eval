import express from 'express';
import http from 'http';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { EvaluationPipeline } from '../pipeline';
import { LLMClient, defaultConfig } from '../pipeline/llm-client';
import type { Scenario, StreamProgress } from '../pipeline/types';

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

        // Run pipeline — all 4 streams in parallel
        // Each progress event gets sent immediately to this client
        const result = await pipeline.run(scenario, (progress: StreamProgress) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'progress', ...progress }));
          }
        });

        // Send final aggregated result
        ws.send(JSON.stringify({ type: 'result', result }));
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
    console.log('WebSocket client disconnected');
  });
});

// === Start ===
server.listen(PORT, () => {
  console.log(`llm-eval server running on port ${PORT}`);
  console.log(`Mock mode: ${llmConfig.mockMode}`);
});

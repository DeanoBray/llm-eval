import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { EvaluationPipeline } from '../pipeline';
import { LLMClient, defaultConfig } from '../pipeline/llm-client';
import type { Scenario } from '../pipeline/types';

const PORT = parseInt(process.env.PORT || '3007', 10);
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

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

// === WebSocket Pipeline Execution ===

wss.on('connection', (ws: WebSocket) => {
  console.log('WebSocket client connected');

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'run-pipeline') {
        const scenario: Scenario = {
          english: msg.english,
          chinese: msg.chinese || undefined,
        };

        // Run pipeline, emitting progress to this WebSocket
        const result = await pipeline.run(scenario, (progress) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'progress', ...progress }));
          }
        });

        // Send final result
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

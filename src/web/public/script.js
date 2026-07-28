// === llm-eval Frontend ===

// Defer translation by 800ms after user stops typing
let translationTimer = null;
let ws = null;
let isRunning = false;
let completedSlots = [];
let pipelineStartTime = 0;
let timerInterval = null;

// Track all events per slot for debug panels
let slotEvents = {};

// Debug panel visibility state
let debugVisible = {};

// Reconnection state
let reconnectAttempts = 0;
const MAX_RECONNECT = 3;
let pendingPipeline = null; // { english, chinese } if reconnecting mid-pipeline

// === Phase definitions ===
const PHASES = [
  { id: 'translating', label: 'Prompt' },
  { id: 'querying',     label: 'Query' },
  { id: 'detecting-refusal', label: 'Refusal' },
  { id: 'extracting-facts', label: 'Extract' },
  { id: 'verifying-facts', label: 'Verify' },
  { id: 'scoring-bias',  label: 'Score' },
];

// === View Switching ===
const landingView = document.getElementById('landing');
const pipelineView = document.getElementById('pipeline-view');
const runBtn = document.getElementById('run-btn');
const backBtn = document.getElementById('back-btn');
const enInput = document.getElementById('scenario-en');
const zhInput = document.getElementById('scenario-zh');
const translationHint = document.getElementById('translation-hint');

backBtn.addEventListener('click', () => {
  landingView.classList.add('active');
  pipelineView.classList.remove('active');
  if (ws) { ws.close(); ws = null; }
  isRunning = false;
  stopTimer();
});

// === Auto-Translation ===

async function translateText(text) {
  if (!text || text.trim().length === 0) {
    zhInput.value = '';
    translationHint.textContent = '';
    return;
  }

  const CHINESE_REGEX = /[\u4e00-\u9fff]/;
  if (CHINESE_REGEX.test(text)) {
    translationHint.textContent = 'Text appears to contain Chinese characters — edit the translation as needed';
    return;
  }

  translationHint.textContent = 'Translating...';
  try {
    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (response.ok) {
      const data = await response.json();
      zhInput.value = data.translation;
      translationHint.textContent = 'Translation ready';
    } else {
      translationHint.textContent = 'Translation unavailable (will translate during pipeline)';
    }
  } catch (err) {
    translationHint.textContent = 'Translation unavailable — will translate during pipeline';
  }
}

// Translate the default example on page load
translateText(enInput.value.trim());

// Debounced translation on English input change
enInput.addEventListener('input', () => {
  if (translationTimer) clearTimeout(translationTimer);
  translationTimer = setTimeout(() => {
    translateText(enInput.value.trim());
  }, 800);
});

// === WebSocket ===

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = protocol + '//' + location.host;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WebSocket connected');
    reconnectAttempts = 0;

    // If we reconnected mid-pipeline, re-send the run command
    if (pendingPipeline && ws.readyState === WebSocket.OPEN) {
      ALL_SLOTS.forEach(slot => {
        addDebugEntry(slot, 'connection', 'running', 'Reconnected — resubmitting pipeline');
      });
      ws.send(JSON.stringify({
        type: 'run-pipeline',
        english: pendingPipeline.english,
        chinese: pendingPipeline.chinese,
      }));
      pendingPipeline = null;
    }
  };

  ws.onclose = () => {
    ws = null;
    if (isRunning) {
      ALL_SLOTS.forEach(slot => {
        addDebugEntry(slot, 'connection', 'error', 'WebSocket disconnected — attempting reconnect...');
      });

      // Try to reconnect
      if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        const delay = reconnectAttempts * 2000;
        setTimeout(() => {
          ALL_SLOTS.forEach(slot => {
            addDebugEntry(slot, 'connection', 'running', `Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT}...`);
          });
          connectWebSocket();
        }, delay);
      } else {
        ALL_SLOTS.forEach(slot => {
          addDebugEntry(slot, 'connection', 'error', 'Max reconnection attempts reached — giving up');
        });
        isRunning = false;
        runBtn.disabled = false;
        pendingPipeline = null;
      }
    } else {
      isRunning = false;
      runBtn.disabled = false;
    }
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'progress') {
      handleProgress(data);
    } else if (data.type === 'result') {
      handlePipelineComplete(data.result);
    } else if (data.type === 'error') {
      handleError(data.message);
    }
  };
}

// === Debug Panel ===

function addDebugEntry(slot, step, status, message) {
  if (!slotEvents[slot]) slotEvents[slot] = [];
  const elapsed = pipelineStartTime ? ((Date.now() - pipelineStartTime) / 1000).toFixed(1) : '0.0';
  slotEvents[slot].push({ elapsed, step, status, message, ts: Date.now() });
  renderDebugPanel(slot);
}

function renderDebugPanel(slot) {
  const panel = document.getElementById('debug-' + slot);
  if (!panel) return;

  const events = slotEvents[slot] || [];

  if (events.length === 0) {
    const elapsed = pipelineStartTime ? ((Date.now() - pipelineStartTime) / 1000).toFixed(1) : '0.0';
    panel.innerHTML = '<div class="debug-no-events">No events received yet <span class="elapsed">(' + elapsed + 's elapsed)</span></div>';
  } else {
    panel.innerHTML = events.map(e =>
      '<div class="debug-entry">' +
        '<span class="debug-time">+' + e.elapsed + 's</span>' +
        '<span class="debug-step">' + e.step + '</span>' +
        '<span class="debug-status ' + e.status + '">' + e.status + '</span>' +
        '<span class="debug-msg">' + escapeHtml(e.message) + '</span>' +
      '</div>'
    ).join('');
  }

  // Auto-scroll to bottom
  panel.scrollTop = panel.scrollHeight;
}

function toggleDebug(slot) {
  const panel = document.getElementById('debug-' + slot);
  const toggle = document.querySelector('.flow-debug-toggle[data-slot="' + slot + '"]');
  if (!panel || !toggle) return;

  debugVisible[slot] = !debugVisible[slot];
  if (debugVisible[slot]) {
    panel.classList.add('visible');
    toggle.classList.add('active');
  } else {
    panel.classList.remove('visible');
    toggle.classList.remove('active');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// === Phase Flowchart ===

const ALL_SLOTS = ['us-model-en', 'us-model-zh', 'cn-model-en', 'cn-model-zh'];

function buildFlowchart(slot) {
  const phasesEl = document.getElementById('phases-' + slot);
  if (!phasesEl) return;

  let html = '';
  PHASES.forEach((phase, i) => {
    if (i > 0) {
      html += '<span class="phase-arrow" id="arrow-' + slot + '-' + (i - 1) + '">▸</span>';
    }
    html += '<div class="flow-phase"><div class="phase-node pending" id="node-' + slot + '-' + phase.id + '">' +
      '<span class="phase-icon">○</span>' +
      '<span class="phase-label">' + phase.label + '</span>' +
      '<span class="phase-time" id="time-' + slot + '-' + phase.id + '"></span>' +
    '</div></div>';
  });
  phasesEl.innerHTML = html;
}

function updatePhaseNode(slot, phaseId, state) {
  const node = document.getElementById('node-' + slot + '-' + phaseId);
  if (!node) return;

  // Remove all state classes
  node.className = node.className.replace(/\s(pending|running|done|error|skipped)/g, '');
  node.classList.add('phase-node', state);

  const icon = node.querySelector('.phase-icon');
  if (state === 'running') icon.textContent = '●';
  else if (state === 'done') icon.textContent = '✓';
  else if (state === 'error') icon.textContent = '✗';
  else if (state === 'skipped') icon.textContent = '—';

  // Update timestamp
  if (state !== 'pending') {
    const timeEl = document.getElementById('time-' + slot + '-' + phaseId);
    if (timeEl && pipelineStartTime) {
      timeEl.textContent = '+' + ((Date.now() - pipelineStartTime) / 1000).toFixed(1) + 's';
      timeEl.style.opacity = '1';
    }
  }
}

function updateArrow(slot, arrowIdx, state) {
  const arrow = document.getElementById('arrow-' + slot + '-' + arrowIdx);
  if (!arrow) return;
  arrow.className = arrow.className.replace(/\s(passed|active)/g, '');
  if (state === 'passed') arrow.classList.add('passed');
  else if (state === 'active') arrow.classList.add('active');
}

function setupAllFlowcharts() {
  ALL_SLOTS.forEach(slot => {
    buildFlowchart(slot);
    slotEvents[slot] = [];
    debugVisible[slot] = false;
    const panel = document.getElementById('debug-' + slot);
    if (panel) { panel.classList.remove('visible'); panel.innerHTML = ''; }
    const toggle = document.querySelector('.flow-debug-toggle[data-slot="' + slot + '"]');
    if (toggle) toggle.classList.remove('active');
    const resultEl = document.getElementById('result-' + slot);
    if (resultEl) { resultEl.style.display = 'none'; resultEl.innerHTML = ''; }
  });
  document.getElementById('aggregate-section').style.display = 'none';
  completedSlots = [];
}

// === Progress Handling ===

function handleProgress(progress) {
  const slot = progress.slot;
  const step = progress.step;
  const status = progress.status;
  const message = progress.message;

  // Log to debug panel
  addDebugEntry(slot, step, status, message);

  // Map step flows: one step's 'done' status implies previous steps are done
  const phaseIdx = PHASES.findIndex(p => p.id === step);
  if (phaseIdx === -1 && step !== 'done') return;

  // If this is the overall 'done' step with a result
  if (step === 'done' || (step === 'scoring-bias' && status === 'done' && progress.result)) {
    updatePhaseNode(slot, 'scoring-bias', 'done');
    // Mark all arrows as passed
    for (let i = 0; i < PHASES.length - 1; i++) updateArrow(slot, i, 'passed');

    if (progress.result) {
      displaySlotResult(slot, progress.result);
      completedSlots.push({ slot, result: progress.result });

      if (completedSlots.length === 4) {
        showAggregate();
        isRunning = false;
        runBtn.disabled = false;
        stopTimer();
      }
    }
    return;
  }

  // Update the current phase node
  if (status === 'running') {
    updatePhaseNode(slot, step, 'running');
    // Mark previous phases as done, previous arrows as passed
    for (let i = 0; i < phaseIdx; i++) {
      updatePhaseNode(slot, PHASES[i].id, 'done');
      updateArrow(slot, i, 'passed');
    }
    // Arrow to current phase is active
    if (phaseIdx > 0) updateArrow(slot, phaseIdx - 1, 'active');
  } else if (status === 'done') {
    updatePhaseNode(slot, step, 'done');
    // Mark previous phases and arrows
    for (let i = 0; i <= phaseIdx; i++) {
      updatePhaseNode(slot, PHASES[i].id, 'done');
    }
    for (let i = 0; i < phaseIdx; i++) {
      updateArrow(slot, i, 'passed');
    }
    if (phaseIdx < PHASES.length - 1) updateArrow(slot, phaseIdx, 'passed');
  } else if (status === 'error') {
    updatePhaseNode(slot, step, 'error');
  }

  // Handle refusal short-circuit
  if (step === 'detecting-refusal' && status === 'done' && message.toLowerCase().includes('refusal detected')) {
    updatePhaseNode(slot, 'extracting-facts', 'skipped');
    updatePhaseNode(slot, 'verifying-facts', 'skipped');
    // Arrows to and from these phases
    const extractIdx = PHASES.findIndex(p => p.id === 'extracting-facts');
    const verifyIdx = PHASES.findIndex(p => p.id === 'verifying-facts');
    if (extractIdx > 0) updateArrow(slot, extractIdx - 1, 'passed');
    if (verifyIdx > 0) updateArrow(slot, verifyIdx - 1, 'passed');
  }
}

function displaySlotResult(slot, result) {
  const resultEl = document.getElementById('result-' + slot);
  if (!resultEl) return;

  const score = result.overallBiasScore || 0;
  let scoreClass = 'low';
  if (score > 0.5) scoreClass = 'high';
  else if (score > 0.2) scoreClass = 'medium';

  const refusal = result.refusal?.isRefusal;
  const factCount = result.facts?.length || 0;
  const verifications = result.factVerifications;
  const accurateCount = verifications ? verifications.filter(v => v.accurate).length : 0;
  const duration = result.duration ? (result.duration / 1000).toFixed(1) + 's' : '';

  let html = '<div class="slot-result-card">';

  html += '<div class="bias-score ' + scoreClass + '">';
  html += '<span class="bias-value">' + (score * 100).toFixed(0) + '%</span>';
  html += '<span class="bias-label">bias score</span>';
  html += '</div>';

  html += '<div class="slot-metrics">';
  html += '<div class="metric">' +
    '<span class="metric-value">' + (refusal ? 'REFUSED' : 'Answered') + '</span>' +
    '<span class="metric-label">response</span>' +
    '</div>';
  if (!refusal) {
    html += '<div class="metric">' +
      '<span class="metric-value">' + factCount + '</span>' +
      '<span class="metric-label">facts</span>' +
      '</div>';
    if (verifications) {
      html += '<div class="metric">' +
        '<span class="metric-value">' + accurateCount + '/' + verifications.length + '</span>' +
        '<span class="metric-label">accurate</span>' +
        '</div>';
    }
  }
  html += '<div class="metric">' +
    '<span class="metric-value">' + duration + '</span>' +
    '<span class="metric-label">time</span>' +
    '</div>';
  html += '</div>';

  if (result.biasIndicators && result.biasIndicators.length > 0) {
    html += '<div class="slot-indicators">';
    result.biasIndicators.forEach(bi => {
      html += '<div class="indicator-row">' +
        '<span class="indicator-dim">' + bi.dimension + '</span>' +
        '<span class="indicator-sev ' + bi.severity + '">' + bi.severity + '</span>' +
        '</div>';
    });
    html += '</div>';
  }

  html += '</div>';
  resultEl.innerHTML = html;
  resultEl.style.display = 'block';
}

// === Aggregated Visualization ===

function showAggregate() {
  const section = document.getElementById('aggregate-section');
  section.style.display = 'block';

  const FLAGS = {
    'us-model-en': '🇺🇸', 'us-model-zh': '🇺🇸',
    'cn-model-en': '🇨🇳', 'cn-model-zh': '🇨🇳',
  };
  const LABELS = {
    'us-model-en': 'US · EN', 'us-model-zh': 'US · ZH',
    'cn-model-en': 'CN · EN', 'cn-model-zh': 'CN · ZH',
  };

  const sorted = [...completedSlots].sort((a, b) => b.result.overallBiasScore - a.result.overallBiasScore);
  const maxScore = Math.max(...sorted.map(s => s.result.overallBiasScore), 0.01);

  let svg = '';
  sorted.forEach((item) => {
    const score = item.result.overallBiasScore;
    const barWidth = Math.max(score * 100, 4);
    const barColor = score > 0.5 ? 'var(--red)' : score > 0.2 ? 'var(--yellow)' : 'var(--green)';

    svg += '<div class="bar-row">' +
      '<div class="bar-label">' + FLAGS[item.slot] + ' ' + LABELS[item.slot] + '</div>' +
      '<div class="bar-track">' +
        '<div class="bar-fill" style="width:' + barWidth + '%;background:' + barColor + ';"></div>' +
        '<span class="bar-value">' + (score * 100).toFixed(0) + '%</span>' +
      '</div>' +
      '</div>';
  });

  document.getElementById('aggregate-chart').innerHTML = svg;
}

// === Timer ===

function startTimer() {
  pipelineStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = ((Date.now() - pipelineStartTime) / 1000).toFixed(1);
    document.getElementById('pipeline-timer').textContent = elapsed + 's';
    // Update debug panels with elapsed time if no events yet
    ALL_SLOTS.forEach(slot => {
      if (!slotEvents[slot] || slotEvents[slot].length === 0) {
        renderDebugPanel(slot);
      }
    });
  }, 500);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function handlePipelineComplete(result) {
  if (result.slotResults) {
    result.slotResults.forEach(sr => {
      if (!completedSlots.find(s => s.slot === sr.slot)) {
        displaySlotResult(sr.slot, sr);
        completedSlots.push({ slot: sr.slot, result: sr });
      }
    });
  }
  if (completedSlots.length >= 4) {
    showAggregate();
  }
  isRunning = false;
  runBtn.disabled = false;
  stopTimer();
}

function handleError(message) {
  ALL_SLOTS.forEach(slot => {
    addDebugEntry(slot, 'global', 'error', message);
    // Mark all running phases as error
    PHASES.forEach(p => {
      const node = document.getElementById('node-' + slot + '-' + p.id);
      if (node && node.classList.contains('running')) {
        updatePhaseNode(slot, p.id, 'error');
      }
    });
  });
  isRunning = false;
  runBtn.disabled = false;
  stopTimer();
}

// === Main Flow ===

runBtn.addEventListener('click', () => {
  const english = enInput.value.trim();
  const chinese = zhInput.value.trim();

  if (!english) return;
  if (!chinese) {
    translationHint.textContent = 'Please wait for translation or enter Chinese text manually';
    return;
  }

  isRunning = true;
  runBtn.disabled = true;

  landingView.classList.remove('active');
  pipelineView.classList.add('active');

  setupAllFlowcharts();
  startTimer();

  // Store for potential reconnection
  pendingPipeline = { english, chinese };

  // Log start
  ALL_SLOTS.forEach(slot => {
    addDebugEntry(slot, 'pipeline', 'running', 'Pipeline started — waiting for server...');
  });

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWebSocket();
  }

  const send = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'run-pipeline',
        english,
        chinese,
      }));
    } else {
      setTimeout(send, 100);
    }
  };
  send();
});

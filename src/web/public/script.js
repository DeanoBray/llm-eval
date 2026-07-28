// === llm-eval Frontend ===
// Dual-mode: Landing page (/) and Job page (/job/<id>)



let ws = null;
let currentJobId = null;
let pipelineStartTime = 0;
let timerInterval = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

let slotEvents = {};
let phaseTimestamps = {};
let debugVisible = {};

const PHASES = [
  { id: 'translating', label: 'Prompt' },
  { id: 'querying',     label: 'Query' },
  { id: 'detecting-refusal', label: 'Refusal' },
  { id: 'extracting-facts', label: 'Extract' },
  { id: 'verifying-facts', label: 'Verify' },
  { id: 'scoring-bias',  label: 'Score' },
];

const ALL_SLOTS = ['us-model-en', 'us-model-zh', 'cn-model-en', 'cn-model-zh'];

// === Mode Detection ===
const pathMatch = location.pathname.match(/^\/job\/(\w+)$/);
const isJobPage = !!pathMatch;
const jobIdFromUrl = pathMatch ? pathMatch[1] : null;

// === DOM Elements ===
const landingView = document.getElementById('landing');
const pipelineView = document.getElementById('pipeline-view');
const aggregateSection = document.getElementById('aggregate-section');
const pipelineTimer = document.getElementById('pipeline-timer');
const runBtn = document.getElementById('run-btn');
const backBtn = document.getElementById('back-btn');
const enInput = document.getElementById('scenario-en');
const zhInput = document.getElementById('scenario-zh');
const translationHint = document.getElementById('translation-hint');
const jobStatusBanner = document.getElementById('job-status-banner');

// === Landing Page ===

backBtn.addEventListener('click', () => {
  history.pushState(null, '', '/');
  showLanding();
  if (ws) { ws.close(); ws = null; }
  currentJobId = null;
  stopTimer();
  stopQueuePolling();
  startQueuePolling();
});

function showLanding() {
  landingView.classList.add('active');
  pipelineView.classList.remove('active');
  jobStatusBanner.style.display = 'none';
  aggregateSection.style.display = 'none';
}

function showPipeline() {
  landingView.classList.remove('active');
  pipelineView.classList.add('active');
}

// Translation debounce
let translationTimer = null;
enInput.addEventListener('input', () => {
  if (translationTimer) clearTimeout(translationTimer);
  translationTimer = setTimeout(() => {
    translateText(enInput.value.trim());
  }, 800);
});

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

// Translate default on load
translateText(enInput.value.trim());

// === Run: Create Job ===
runBtn.addEventListener('click', async () => {
  const english = enInput.value.trim();
  const chinese = zhInput.value.trim();

  if (!english) return;
  if (!chinese) {
    translationHint.textContent = 'Please wait for translation or enter Chinese text manually';
    return;
  }

  runBtn.disabled = true;
  runBtn.textContent = 'Creating...';

  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ english, chinese }),
    });

    if (!response.ok) {
      const err = await response.json();
      alert('Failed to create job: ' + (err.error || 'Unknown error'));
      runBtn.disabled = false;
      runBtn.textContent = 'Run Evaluation';
      return;
    }

    const { jobId } = await response.json();
    navigateToJob(jobId);
  } catch (err) {
    alert('Failed to create job: ' + err.message);
    runBtn.disabled = false;
    runBtn.textContent = 'Run Evaluation';
  }
});

// === Navigation ===

function navigateToJob(jobId) {
  currentJobId = jobId;
  history.pushState(null, '', '/job/' + jobId);
  showPipeline();
  loadJob(jobId);
  stopQueuePolling();
}

// === State Restoration on Refresh or Navigate ===

async function loadJob(jobId) {
  const loadingEl = document.getElementById('pipeline-loading');
  const descEl = document.getElementById('pipeline-description');
  loadingEl.style.display = 'flex';
  descEl.style.display = 'none';
  try {
    const response = await fetch('/api/jobs/' + jobId);
    if (!response.ok) {
      showJobError('Job not found');
      return;
    }

    const state = await response.json();
    loadingEl.style.display = 'none';

    if (state.status === 'queued') {
      showQueuePosition(state.queuePosition);
      startPollingQueue(jobId);
    } else {
      hideQueueBanner();
      if (state.status === 'running' || state.status === 'completed' || state.status === 'error') {
        descEl.style.display = 'block';
      }
    }

    if (state.status === 'running' || state.status === 'completed') {
      // Build flowchart DOM (inside loadJob so DOM is ready)
      setupAllFlowcharts();
      handleJobSync({
        type: 'job-sync',
        jobId: state.id,
        status: state.status,
        queuePosition: state.queuePosition || 0,
        slotEvents: state.events,
        slotResults: state.slotResults,
        scenario: state.scenario,
        startedAt: state.startedAt,
      });
    }

    if (state.status === 'completed') {
      showJobBanner('completed', 'Job complete');
      stopTimer();
      return; // State fully restored from HTTP above — no WebSocket needed
    }

    if (state.status === 'error') {
      showJobError(state.error || 'Job failed');
      return;
    }

    // Connect WebSocket for live updates on running jobs
    connectAndSubscribe(jobId);
  } catch (err) {
    loadingEl.style.display = 'none';
    showJobError('Failed to load job: ' + err.message);
  }
}

// === Queue Display ===

function showQueuePosition(position) {
  jobStatusBanner.style.display = 'block';
  jobStatusBanner.className = 'job-banner queued';
  jobStatusBanner.innerHTML =
    '<span class="queue-icon">⏳</span>' +
    'Position in queue: <strong>#' + position + '</strong>' +
    '<span class="queue-sub">Waiting for available slot...</span>';

  document.getElementById('pipeline-timer').textContent = '—';
}

function hideQueueBanner() {
  jobStatusBanner.style.display = 'none';
}

function showJobBanner(status, message) {
  jobStatusBanner.style.display = 'block';
  jobStatusBanner.className = 'job-banner ' + status;
  jobStatusBanner.innerHTML = '<span>' + message + '</span>';
}

function showJobError(message) {
  jobStatusBanner.style.display = 'block';
  jobStatusBanner.className = 'job-banner error';
  jobStatusBanner.innerHTML = '<span>❌ ' + escapeHtml(message) + '</span>';
}

// === Queue Polling ===

let queuePoller = null;

function startPollingQueue(jobId) {
  if (queuePoller) clearInterval(queuePoller);
  queuePoller = setInterval(async () => {
    try {
      const response = await fetch('/api/jobs/' + jobId);
      if (!response.ok) return;
      const state = await response.json();

      if (state.status === 'running' || state.status === 'completed' || state.status === 'error') {
        clearInterval(queuePoller);
        queuePoller = null;
        loadJob(jobId); // Full reload with WebSocket
      } else if (state.status === 'queued') {
        showQueuePosition(state.queuePosition);
      }
    } catch (e) {
      // Ignore poll errors
    }
  }, 2000);
}

// === WebSocket ===

function connectAndSubscribe(jobId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    subscribeToJob(jobId);
    return;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = protocol + '//' + location.host;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WebSocket connected');
    reconnectAttempts = 0;
    subscribeToJob(jobId);
  };

  ws.onclose = () => {
    ws = null;
    if (currentJobId) {
      ALL_SLOTS.forEach(slot => {
        addDebugEntry(slot, 'connection', 'error', 'WebSocket disconnected — attempting reconnect...');
      });
      if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        const delay = reconnectAttempts * 2000;
        setTimeout(() => {
          if (currentJobId) {
            ALL_SLOTS.forEach(slot => {
              addDebugEntry(slot, 'connection', 'running',
                'Reconnect attempt ' + reconnectAttempts + '/' + MAX_RECONNECT + '...');
            });
            connectAndSubscribe(currentJobId);
          }
        }, delay);
      } else {
        ALL_SLOTS.forEach(slot => {
          addDebugEntry(slot, 'connection', 'error', 'Max reconnection attempts reached');
        });
        stopTimer();
      }
    }
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleWsMessage(data);
  };
}

function subscribeToJob(jobId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'subscribe-job', jobId }));
}

function handleWsMessage(data) {
  if (data.type === 'job-sync') {
    handleJobSync(data);
  } else if (data.type === 'progress') {
    handleProgress(data);
  } else if (data.type === 'result') {
    handleResult(data.result);
  } else if (data.type === 'error') {
    showJobError(data.message);
    ALL_SLOTS.forEach(slot => {
      addDebugEntry(slot, 'global', 'error', data.message);
    });
  }
}

// === Job Sync: Restore state on connect/refresh ===

function handleJobSync(sync) {
  // Update banner
  if (sync.status === 'running') {
    hideQueueBanner();
    showJobBanner('running', 'Job ' + sync.jobId + ' running');
    if (!pipelineStartTime && sync.startedAt) {
      pipelineStartTime = sync.startedAt;
      startTimer();
    }
  } else if (sync.status === 'completed') {
    showJobBanner('completed', 'Job complete');
    stopTimer();
  }

  // Replay all accumulated events into debug panels
  if (sync.slotEvents) {
    Object.keys(sync.slotEvents).forEach(slot => {
      slotEvents[slot] = [];
      sync.slotEvents[slot].forEach(evt => {
        slotEvents[slot].push({
          elapsed: '—',
          step: evt.step,
          status: evt.status,
          message: evt.message,
          ts: evt.timestamp,
        });
      });
      renderDebugPanel(slot);
    });
  }

  // Replay progress events to update flowcharts
  if (sync.slotEvents) {
    Object.keys(sync.slotEvents).forEach(slot => {
      sync.slotEvents[slot].forEach(evt => {
        replayPhaseState(slot, evt.step, evt.status, evt.message, evt.timestamp);
      });
    });
  }


  // Show scenario if provided
  if (sync.scenario) {
    const scenarioSection = document.getElementById('scenario-section');
    const engText = document.getElementById('scenario-english-text');
    const chiText = document.getElementById('scenario-chinese-text');
    if (scenarioSection) scenarioSection.style.display = 'block';
    if (engText && sync.scenario.english) engText.textContent = sync.scenario.english;
    if (chiText && sync.scenario.chinese) chiText.textContent = sync.scenario.chinese;
  }

  // Show any completed results
  if (sync.slotResults && sync.slotResults.length > 0) {
    sync.slotResults.forEach(sr => displaySlotResult(sr.slot, sr));
    if (sync.slotResults.length >= 4) {
      aggregateSection.style.display = 'block';
      showAggregateChartFromResults(sync.slotResults);
    }
  }
}

function replayPhaseState(slot, step, status, message, replayTimestamp) {
  const phaseIdx = PHASES.findIndex(p => p.id === step);
  if (phaseIdx === -1 && step !== 'done') return;

  if (step === 'done') {
    // Mark all phases done
    PHASES.forEach((p, i) => {
      updatePhaseNode(slot, p.id, 'done', replayTimestamp);
      if (i < PHASES.length - 1) updateArrow(slot, i, 'passed');
    });
    return;
  }

  if (status === 'done') {
    // Mark this and all previous phases as done
    for (let i = 0; i <= phaseIdx; i++) {
      updatePhaseNode(slot, PHASES[i].id, 'done', replayTimestamp);
    }
    for (let i = 0; i < phaseIdx; i++) {
      updateArrow(slot, i, 'passed');
    }
    if (phaseIdx < PHASES.length - 1) updateArrow(slot, phaseIdx, 'passed');
  } else if (status === 'running') {
    // Mark previous phases as done, this one as running
    for (let i = 0; i < phaseIdx; i++) {
      updatePhaseNode(slot, PHASES[i].id, 'done', replayTimestamp);
      updateArrow(slot, i, 'passed');
    }
    updatePhaseNode(slot, step, 'running', replayTimestamp);
    if (phaseIdx > 0) updateArrow(slot, phaseIdx - 1, 'active');

    // Check for refusal short-circuit
    if (step === 'detecting-refusal' && message.toLowerCase().includes('refusal detected')) {
      updatePhaseNode(slot, 'extracting-facts', 'skipped', replayTimestamp);
      updatePhaseNode(slot, 'verifying-facts', 'skipped', replayTimestamp);
    }
  } else if (status === 'error') {
    updatePhaseNode(slot, step, 'error', replayTimestamp);
  }
}

// === Progress Handling (live) ===

function handleProgress(progress) {
  const slot = progress.slot;
  const step = progress.step;
  const status = progress.status;
  const message = progress.message;

  // Ignore sentinel pipeline messages (they don't map to a real slot)
  if (!ALL_SLOTS.includes(slot) && step === 'pipeline') {
    // This is a job-level message — update banner
    if (status === 'running') {
      hideQueueBanner();
      showJobBanner('running', message);
      pipelineStartTime = Date.now();
      startTimer();
    }
    return;
  }

  if (!ALL_SLOTS.includes(slot)) return;

  // Log to debug panel
  addDebugEntry(slot, step, status, message);

  // Handle completion
  if (step === 'done' || (step === 'scoring-bias' && status === 'done' && progress.result)) {
    updatePhaseNode(slot, 'scoring-bias', 'done');
    for (let i = 0; i < PHASES.length - 1; i++) updateArrow(slot, i, 'passed');
    if (progress.result) {
      displaySlotResult(slot, progress.result);
    }
    return;
  }

  // If step is not a known phase, skip
  const phaseIdx = PHASES.findIndex(p => p.id === step);
  if (phaseIdx === -1) return;

  // Update phase node
  if (status === 'running') {
    updatePhaseNode(slot, step, 'running');
    for (let i = 0; i < phaseIdx; i++) {
      updatePhaseNode(slot, PHASES[i].id, 'done');
      updateArrow(slot, i, 'passed');
    }
    if (phaseIdx > 0) updateArrow(slot, phaseIdx - 1, 'active');

    // If entering extracting-facts or verifying-facts and previous was refusal, skip those
    if (step === 'extracting-facts') {
      // Just moved past refusal check — show it as done
      updatePhaseNode(slot, 'detecting-refusal', 'done');
      updateArrow(slot, phaseIdx - 1, 'passed');
    }
  } else if (status === 'done') {
    updatePhaseNode(slot, step, 'done');
    for (let i = 0; i <= phaseIdx; i++) {
      updatePhaseNode(slot, PHASES[i].id, 'done');
    }
    for (let i = 0; i < phaseIdx; i++) {
      updateArrow(slot, i, 'passed');
    }
    if (phaseIdx < PHASES.length - 1) updateArrow(slot, phaseIdx, 'passed');

    // Refusal short-circuit
    if (step === 'detecting-refusal' && message.toLowerCase().includes('refusal detected')) {
      updatePhaseNode(slot, 'extracting-facts', 'skipped');
      updatePhaseNode(slot, 'verifying-facts', 'skipped');
    }
  } else if (status === 'error') {
    updatePhaseNode(slot, step, 'error');
  }
}

// === Result Handling ===

function handleResult(result) {
  showJobBanner('completed', 'Job complete');
  stopTimer();

  if (result.slotResults) {
    result.slotResults.forEach(sr => {
      if (sr) displaySlotResult(sr.slot, sr);
    });
  }

  if (result.slotResults && result.slotResults.length >= 4) {
    aggregateSection.style.display = 'block';
    showAggregateChartFromResults(result.slotResults);
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
  html += '<div class="metric"><span class="metric-value">' + (refusal ? 'REFUSED' : 'Answered') + '</span><span class="metric-label">response</span></div>';
  if (!refusal) {
    html += '<div class="metric"><span class="metric-value">' + factCount + '</span><span class="metric-label">facts</span></div>';
    if (verifications) {
      html += '<div class="metric"><span class="metric-value">' + accurateCount + '/' + verifications.length + '</span><span class="metric-label">accurate</span></div>';
    }
  }
  html += '<div class="metric"><span class="metric-value">' + duration + '</span><span class="metric-label">time</span></div>';
  html += '</div>';

  if (result.biasIndicators && result.biasIndicators.length > 0) {
    html += '<div class="slot-indicators">';
    result.biasIndicators.forEach(bi => {
      // Invert accuracy severity labels: bias framework says 'low' risk = good accuracy,
      // but users read 'accuracy: low' as 'accuracy is low'. Flip it for this dimension.
      const displaySev = bi.dimension === 'accuracy'
        ? (bi.severity === 'high' ? 'low' : bi.severity === 'low' ? 'high' : bi.severity)
        : bi.severity;
      html += '<div class="indicator-row"><span class="indicator-dim">' + bi.dimension + '</span><span class="indicator-sev ' + bi.severity + '">' + displaySev + '</span></div>';
    });
    html += '</div>';
  }

  // Model response (collapsible)
  if (result.response) {
    const respId = 'resp-' + slot;
    html += '<div class="slot-response">';
    html += '<button class="response-toggle" onclick="document.getElementById(\'' + respId + '\').classList.toggle(\'expanded\');this.textContent=this.textContent===\'Show Response\'?\'Hide Response\':\'Show Response\'">Show Response</button>';
    html += '<pre class="response-text" id="' + respId + '">' + escapeHtml(result.response) + '</pre>';
    html += '</div>';
  }

  html += '</div>';
  resultEl.innerHTML = html;
  resultEl.style.display = 'block';
}

// === Aggregate Chart ===

function showAggregateChartFromResults(slotResults) {
  const FLAGS = {
    'us-model-en': '🇺🇸', 'us-model-zh': '🇺🇸',
    'cn-model-en': '🇨🇳', 'cn-model-zh': '🇨🇳',
  };
  const LABELS = {
    'us-model-en': 'US · EN', 'us-model-zh': 'US · ZH',
    'cn-model-en': 'CN · EN', 'cn-model-zh': 'CN · ZH',
  };

  const sorted = [...slotResults].sort((a, b) => b.overallBiasScore - a.overallBiasScore);

  let svg = '';
  sorted.forEach((item) => {
    const score = item.overallBiasScore;
    const barWidth = Math.max(score * 100, 4);
    const barColor = score > 0.5 ? 'var(--red)' : score > 0.2 ? 'var(--yellow)' : 'var(--green)';
    svg += '<div class="bar-row">' +
      '<div class="bar-label">' + FLAGS[item.slot] + ' ' + LABELS[item.slot] + '<br><span class="bar-model-name">' + (item.modelName || '').split('-')[0] + '</span></div>' +
      '<div class="bar-track">' +
        '<div class="bar-fill" style="width:' + barWidth + '%;background:' + barColor + ';"></div>' +
        '<span class="bar-value">' + (score * 100).toFixed(0) + '%</span>' +
      '</div>' +
      '</div>';
  });

  document.getElementById('aggregate-chart').innerHTML = svg;
}

// === Flowchart UI ===

function setupAllFlowcharts() {
  slotEvents = {};
  phaseTimestamps = {};
  completedSlots = [];
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
  aggregateSection.style.display = 'none';
  hideQueueBanner();
  pipelineStartTime = 0;
  stopTimer();
  pipelineTimer.textContent = '—';
}

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

function updatePhaseNode(slot, phaseId, state, replayTimestamp) {
  const node = document.getElementById('node-' + slot + '-' + phaseId);
  if (!node) return;
  node.className = node.className.replace(/\s(pending|running|done|error|skipped)/g, '');
  node.classList.add('phase-node', state);
  const icon = node.querySelector('.phase-icon');
  if (state === 'running') icon.textContent = '●';
  else if (state === 'done') icon.textContent = '✓';
  else if (state === 'error') icon.textContent = '✗';
  else if (state === 'skipped') icon.textContent = '—';
  if (state !== 'pending') {
    const timeEl = document.getElementById('time-' + slot + '-' + phaseId);
    if (timeEl && pipelineStartTime) {
      if (!phaseTimestamps[slot]) phaseTimestamps[slot] = {};
      // Only set timestamp once — first transition away from pending
      if (!phaseTimestamps[slot][phaseId]) {
        phaseTimestamps[slot][phaseId] = replayTimestamp || Date.now();
      }
      const phaseTs = phaseTimestamps[slot][phaseId];
      timeEl.textContent = '+' + ((phaseTs - pipelineStartTime) / 1000).toFixed(3) + 's';
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

// === Debug Panel ===

function addDebugEntry(slot, step, status, message) {
  if (!slotEvents[slot]) slotEvents[slot] = [];
  const elapsed = pipelineStartTime ? ((Date.now() - pipelineStartTime) / 1000).toFixed(1) : '—';
  slotEvents[slot].push({ elapsed, step, status, message, ts: Date.now() });
  renderDebugPanel(slot);
}

function renderDebugPanel(slot) {
  const panel = document.getElementById('debug-' + slot);
  if (!panel) return;
  const events = slotEvents[slot] || [];
  if (events.length === 0) {
    const elapsed = pipelineStartTime ? ((Date.now() - pipelineStartTime) / 1000).toFixed(1) : '—';
    panel.innerHTML = '<div class="debug-no-events">No events yet <span class="elapsed">(' + elapsed + 's)</span></div>';
  } else {
    panel.innerHTML = events.map(e =>
      '<div class="debug-entry">' +
        '<span class="debug-time">' + (e.elapsed === '—' ? 'sync' : '+' + e.elapsed + 's') + '</span>' +
        '<span class="debug-step">' + e.step + '</span>' +
        '<span class="debug-status ' + e.status + '">' + e.status + '</span>' +
        '<span class="debug-msg">' + escapeHtml(e.message) + '</span>' +
      '</div>'
    ).join('');
  }
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

// === Timer ===

function startTimer() {
  if (!pipelineStartTime) pipelineStartTime = Date.now();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsed = ((Date.now() - pipelineStartTime) / 1000).toFixed(1);
    pipelineTimer.textContent = elapsed + 's';
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// === Init: Route to correct view ===
// === Queue Status (Landing Page) ===
let queuePollInterval = null;

async function fetchQueueStatus() {
  try {
    const response = await fetch('/api/jobs');
    if (!response.ok) return;
    const data = await response.json();
    renderQueueStatus(data);
  } catch (e) {
    // Silent fail — queue status is non-critical
  }
}

function renderQueueStatus(data) {
  const section = document.getElementById('queue-section');
  const countEl = document.getElementById('queue-count');
  const runningEl = document.getElementById('queue-running');
  const waitingEl = document.getElementById('queue-waiting');
  const recentEl = document.getElementById('queue-recent');

  const totalActive = data.running.length + data.queued.length;

  if (totalActive === 0 && data.recent.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';

  // Queue count badge
  countEl.textContent = totalActive + ' active';
  if (totalActive === 0) {
    countEl.textContent = 'idle';
    countEl.className = 'queue-count empty';
  } else {
    countEl.className = 'queue-count';
  }

  // Running jobs
  if (data.running.length > 0) {
    runningEl.innerHTML = '<div class="queue-group-header">Running (' + data.running.length + ')</div>' +
      data.running.map(j => renderJobRow(j)).join('');
  } else {
    runningEl.innerHTML = '';
  }

  // Queued jobs
  if (data.queued.length > 0) {
    waitingEl.innerHTML = '<div class="queue-group-header">Waiting (' + data.queued.length + ')</div>' +
      data.queued.map(j => renderJobRow(j)).join('');
  } else {
    waitingEl.innerHTML = '';
  }

  // Recent jobs (last 5)
  if (data.recent.length > 0) {
    const recent5 = data.recent.slice(0, 3);
    recentEl.innerHTML = '<div class="queue-group-header">Recent</div>' +
      recent5.map(j => renderJobRow(j)).join('');
  } else {
    recentEl.innerHTML = '';
  }
}

function renderJobRow(j) {
  const slotProgress = j.runningSlots !== undefined
    ? ' <span class="job-progress">' + j.runningSlots + '/' + j.totalSlots + ' slots</span>'
    : '';

  const positionInfo = j.status === 'queued'
    ? ' <span class="job-progress">#' + j.queuePosition + ' in queue</span>'
    : '';

  const timeAgo = formatTimeAgo(j.createdAt);

  return '<a href="/job/' + j.id + '" class="queue-job" onclick="event.preventDefault(); navigateToJob(\'' + j.id + '\');">' +
    '<span class="job-id">' + j.id + '</span>' +
    (j.modelNames ? '<span class="job-models">' + [...new Set(Object.values(j.modelNames))].map(m => m.split('-MLX')[0]).join(', ') + '</span>' : '') +
    '<span class="job-scenario" title="' + escapeHtml(j.scenarioSummary) + '">' + escapeHtml(j.scenarioSummary) + '</span>' +
    '<span class="job-meta">' +
      '<span class="job-status ' + j.status + '">' + j.status + '</span>' +
      slotProgress +
      positionInfo +
      '<span class="job-time">' + timeAgo + '</span>' +
    '</span>' +
  '</a>';
}

function formatTimeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  return Math.floor(sec / 3600) + 'h ago';
}

function startQueuePolling() {
  fetchQueueStatus();
  if (queuePollInterval) clearInterval(queuePollInterval);
  queuePollInterval = setInterval(fetchQueueStatus, 3000);
}

function stopQueuePolling() {
  if (queuePollInterval) {
    clearInterval(queuePollInterval);
    queuePollInterval = null;
  }
}



if (isJobPage) {
  showPipeline();
  // setupAllFlowcharts() is now called inside loadJob() after the DOM is parsed
  loadJob(jobIdFromUrl);
}
 else {
  startQueuePolling();
}

// Handle browser back/forward
window.addEventListener('popstate', () => {
  const newMatch = location.pathname.match(/^\/job\/(\w+)$/);
  if (newMatch) {
    currentJobId = newMatch[1];
    showPipeline();
    loadJob(currentJobId);
    stopQueuePolling();
  } else {
    showLanding();
    if (ws) { ws.close(); ws = null; }
    currentJobId = null;
    stopTimer();
    startQueuePolling();
  }
});

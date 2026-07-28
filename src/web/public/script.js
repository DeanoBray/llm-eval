// === llm-eval Frontend ===

// Defer translation by 1 second after user stops typing
let translationTimer = null;
let ws = null;
let isRunning = false;

// === View Switching ===
const landingView = document.getElementById('landing');
const pipelineView = document.getElementById('pipeline-view');
const runBtn = document.getElementById('run-btn');
const backBtn = document.getElementById('back-btn');
const enInput = document.getElementById('scenario-en');
const zhInput = document.getElementById('scenario-zh');

backBtn.addEventListener('click', () => {
  landingView.classList.add('active');
  pipelineView.classList.remove('active');
  if (ws) { ws.close(); ws = null; }
  isRunning = false;
});

// === Auto-translation ===
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = protocol + '//' + location.host;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => console.log('WebSocket connected');
  ws.onclose = () => { ws = null; isRunning = false; };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'progress') {
      updateFlowchart(data);
    } else if (data.type === 'result') {
      displayResults(data.result);
      isRunning = false;
      runBtn.disabled = false;
    } else if (data.type === 'error') {
      showError(data.message);
      isRunning = false;
      runBtn.disabled = false;
    }
  };
}

// === Pipeline Flowchart ===
const flowchartSteps = [
  { id: 'translating', label: 'Translation' },
  { id: 'querying-us-en', label: 'US Model (English)' },
  { id: 'querying-us-zh', label: 'US Model (Chinese)' },
  { id: 'querying-cn-en', label: 'CN Model (English)' },
  { id: 'querying-cn-zh', label: 'CN Model (Chinese)' },
  { id: 'detecting-refusals', label: 'Detect Refusals' },
  { id: 'extracting-facts', label: 'Extract Facts' },
  { id: 'verifying-facts', label: 'Verify Facts' },
  { id: 'scoring-bias', label: 'Score Bias' },
];

function buildFlowchart() {
  const container = document.getElementById('flowchart');
  container.innerHTML = '';

  flowchartSteps.forEach((step, i) => {
    if (i > 0) {
      const conn = document.createElement('div');
      conn.className = 'flow-connector';
      conn.id = 'conn-' + step.id;
      container.appendChild(conn);
    }

    const div = document.createElement('div');
    div.className = 'flow-step';
    div.id = 'step-' + step.id;
    div.innerHTML =
      '<span class="icon">○</span>' +
      '<span class="label">' + step.label + '</span>' +
      '<span class="detail"></span>';
    container.appendChild(div);
  });
}

function updateFlowchart(progress) {
  const prevStep = getPrevStep(progress.step);
  if (prevStep) {
    markStep(prevStep, 'done', '✓');
    const conn = document.getElementById('conn-' + progress.step);
    if (conn) conn.classList.add('done');
  }

  if (progress.status === 'done') {
    markStep(progress.step, 'done', '✓');
  } else if (progress.status === 'error') {
    markStep(progress.step, 'error', '✗');
  } else {
    markStep(progress.step, 'running', '●');
  }

  const stepEl = document.getElementById('step-' + progress.step);
  if (stepEl) {
    const detail = stepEl.querySelector('.detail');
    if (detail) detail.textContent = progress.message || '';
  }
}

function markStep(stepId, status, icon) {
  const el = document.getElementById('step-' + stepId);
  if (!el) return;
  el.className = 'flow-step ' + status;
  const iconEl = el.querySelector('.icon');
  if (iconEl) iconEl.textContent = icon;
}

function getPrevStep(current) {
  const idx = flowchartSteps.findIndex(s => s.id === current);
  return idx > 0 ? flowchartSteps[idx - 1].id : null;
}

// === Results Display ===
function displayResults(result) {
  const resultsContent = document.getElementById('results-content');
  const responses = result.responses || [];
  const slotResults = result.slotResults || [];

  let html = '<p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:1rem">' +
    'Duration: ' + (result.duration / 1000).toFixed(1) + 's</p>';

  slotResults.forEach((sr) => {
    const resp = responses.find((r) => r.model === sr.slot);
    const refusal = sr.refusal && sr.refusal.isRefusal;
    const accuracyBadge = getAccuracyBadge(sr);

    html += '<div class="result-card">' +
      '<h3>' +
        formatSlot(sr.slot) +
        '<span class="badge ' + (refusal ? 'badge-refusal' : 'badge-response') + '">' +
          (refusal ? 'REFUSAL' : 'RESPONSE') +
        '</span>';

    if (accuracyBadge) {
      html += '<span class="badge ' + accuracyBadge.class + '">' + accuracyBadge.label + '</span>';
    }

    html += '</h3>';

    if (refusal && sr.refusal.reason) {
      html += '<p style="color:var(--text-muted);font-size:0.8rem">' + sr.refusal.reason + '</p>';
    }

    if (sr.facts) {
      html += '<p style="font-size:0.8rem;margin-top:0.3rem">' + sr.facts.length + ' facts extracted</p>';
    }

    if (sr.biasIndicators && sr.biasIndicators.length > 0) {
      html += '<div style="margin-top:0.5rem">';
      sr.biasIndicators.forEach((bi) => {
        html += '<div class="bias-indicator">' +
          '<span class="bias-dim">' + bi.dimension + '</span>' +
          '<span class="bias-dir ' + bi.severity + '">' + bi.severity + '</span>' +
        '</div>';
      });
      html += '</div>';
    }

    html += '</div>';
  });

  resultsContent.innerHTML = html;
  updateSummaryGrid(slotResults);
}

function getAccuracyBadge(sr) {
  if (!sr.factVerifications || sr.factVerifications.length === 0) return null;
  const accurate = sr.factVerifications.filter((v) => v.accurate).length;
  const total = sr.factVerifications.length;
  const rate = accurate / total;

  if (rate >= 0.8) return { label: accurate + '/' + total + ' ACCURATE', class: 'badge-accurate' };
  if (rate >= 0.5) return { label: accurate + '/' + total + ' PARTIAL', class: 'badge-partial' };
  return { label: accurate + '/' + total + ' INACCURATE', class: 'badge-inaccurate' };
}

function updateSummaryGrid(slotResults) {
  const grid = document.getElementById('summary-grid');
  const gridDiv = document.getElementById('bias-grid');
  grid.style.display = 'block';

  gridDiv.innerHTML = slotResults.map((sr) => {
    const score = sr.overallBiasScore;
    let cls = 'low';
    if (score > 0.5) cls = 'high';
    else if (score > 0.2) cls = 'medium';

    return '<div class="grid-card">' +
      '<div class="slot-label">' + formatSlot(sr.slot) + '</div>' +
      '<div class="score ' + cls + '">' + (score * 100).toFixed(0) + '%</div>' +
      '<div style="font-size:0.7rem;color:var(--text-muted)">bias score</div>' +
    '</div>';
  }).join('');
}

function formatSlot(slot) {
  const labels = {
    'us-model-en': 'US · EN',
    'us-model-zh': 'US · ZH',
    'cn-model-en': 'CN · EN',
    'cn-model-zh': 'CN · ZH',
  };
  return labels[slot] || slot;
}

function showError(message) {
  const resultsContent = document.getElementById('results-content');
  resultsContent.innerHTML = '<div class="result-card" style="border-color:var(--red)">' +
    '<h3 style="color:var(--red)">Error</h3>' +
    '<p style="font-size:0.85rem">' + message + '</p>' +
  '</div>';
}

// === Main Flow ===
runBtn.addEventListener('click', () => {
  const english = enInput.value.trim();
  const chinese = zhInput.value.trim();

  if (!english) return;

  isRunning = true;
  runBtn.disabled = true;

  landingView.classList.remove('active');
  pipelineView.classList.add('active');

  buildFlowchart();
  document.getElementById('results-content').innerHTML =
    '<p class="placeholder">Running pipeline...</p>';
  document.getElementById('summary-grid').style.display = 'none';

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWebSocket();
  }

  const send = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'run-pipeline',
        english: english,
        chinese: chinese || undefined,
      }));
    } else {
      setTimeout(send, 100);
    }
  };
  send();
});

// === Auto-translation (debounced) ===
const CHINESE_REGEX = /[\u4e00-\u9fff]/;

enInput.addEventListener('input', () => {
  const text = enInput.value.trim();
  if (CHINESE_REGEX.test(text) && text.length > 0) return;

  if (translationTimer) clearTimeout(translationTimer);
  translationTimer = setTimeout(async () => {
    if (!text) { zhInput.value = ''; return; }
    zhInput.value = '[Translation will be generated during pipeline execution]';
  }, 800);
});

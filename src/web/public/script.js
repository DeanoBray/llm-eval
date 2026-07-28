// === llm-eval Frontend ===

// Defer translation by 800ms after user stops typing
let translationTimer = null;
let ws = null;
let isRunning = false;
let runningSlots = new Set();
let completedSlots = [];
let pipelineStartTime = 0;
let timerInterval = null;

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

/**
 * Translate EN text to ZH via the server's translation endpoint.
 * Called on page load and on input change (debounced).
 */
async function translateText(text) {
  if (!text || text.trim().length === 0) {
    zhInput.value = '';
    translationHint.textContent = '';
    return;
  }

  // Check if text already contains Chinese characters
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

  ws.onopen = () => console.log('WebSocket connected');
  ws.onclose = () => {
    ws = null;
    isRunning = false;
    runBtn.disabled = false;
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'progress') {
      updateStreamRow(data);
    } else if (data.type === 'result') {
      handlePipelineComplete(data.result);
    } else if (data.type === 'error') {
      handleError(data.message);
    }
  };
}

// === 4-Row Stream Display ===

const SLOT_LABELS = {
  'us-model-en': 'US · EN',
  'us-model-zh': 'US · ZH',
  'cn-model-en': 'CN · EN',
  'cn-model-zh': 'CN · ZH',
};

const SLOT_FLAGS = {
  'us-model-en': '🇺🇸',
  'us-model-zh': '🇺🇸',
  'cn-model-en': '🇨🇳',
  'cn-model-zh': '🇨🇳',
};

// Build the phase indicators for each row
function buildPhaseIndicators(slot) {
  const phasesEl = document.getElementById('phases-' + slot);
  const phases = [
    { id: 'translating', label: 'Prompt' },
    { id: 'querying', label: 'Query' },
    { id: 'detecting-refusal', label: 'Refusal?' },
    { id: 'extracting-facts', label: 'Extract' },
    { id: 'verifying-facts', label: 'Verify' },
    { id: 'scoring-bias', label: 'Score' },
  ];

  phasesEl.innerHTML = phases.map(p =>
    `<div class="phase phase-${p.id}" id="phase-${slot}-${p.id}">
      <span class="phase-icon">○</span>
      <span class="phase-label">${p.label}</span>
    </div>`
  ).join('');
}

function setupStreamRows() {
  ['us-model-en', 'us-model-zh', 'cn-model-en', 'cn-model-zh'].forEach(slot => {
    buildPhaseIndicators(slot);
    document.getElementById('status-' + slot).textContent = 'Waiting...';
    document.getElementById('result-' + slot).style.display = 'none';
    document.getElementById('result-' + slot).innerHTML = '';
    // Reset all phases
    const phasesEl = document.getElementById('phases-' + slot);
    phasesEl.querySelectorAll('.phase').forEach(p => {
      p.className = p.className.replace(/\s(running|done|error|skipped)/g, '');
    });
  });
  document.getElementById('aggregate-section').style.display = 'none';
  completedSlots = [];
  runningSlots = new Set();
}

function updateStreamRow(progress) {
  const slot = progress.slot;
  const statusEl = document.getElementById('status-' + slot);
  if (!statusEl) return;

  // Update row status
  if (progress.status === 'running') {
    statusEl.innerHTML = '<span class="pulse-dot"></span> ' + progress.message;
    runningSlots.add(slot);
  } else if (progress.status === 'done') {
    statusEl.textContent = progress.message;
    runningSlots.delete(slot);
  } else if (progress.status === 'error') {
    statusEl.innerHTML = '<span class="err-icon">✗</span> ' + progress.message;
    runningSlots.delete(slot);
  }

  // Update phase indicators
  const phasesEl = document.getElementById('phases-' + slot);

  // Mark current step as running
  const currentPhase = document.getElementById('phase-' + slot + '-' + progress.step);
  if (currentPhase) {
    // First, mark previous non-done phases as running (for skipped phases)
    const allPhases = phasesEl.querySelectorAll('.phase');
    let foundCurrent = false;
    allPhases.forEach(p => {
      const phaseId = p.id.replace('phase-' + slot + '-', '');
      // Mark phases before current as done if not already done
    });

    if (progress.status === 'running') {
      currentPhase.classList.add('running');
    } else if (progress.status === 'done') {
      currentPhase.classList.remove('running');
      currentPhase.classList.add('done');
      const icon = currentPhase.querySelector('.phase-icon');
      if (icon) icon.textContent = '✓';
    } else if (progress.status === 'error') {
      currentPhase.classList.remove('running');
      currentPhase.classList.add('error');
      const icon = currentPhase.querySelector('.phase-icon');
      if (icon) icon.textContent = '✗';
    }
  }

  // Handle refusal short-circuit: skip extract/verify phases
  if (progress.step === 'detecting-refusal' && progress.status === 'done' && progress.message.includes('Refusal detected')) {
    // Mark extracting-facts, verifying-facts as skipped
    ['extracting-facts', 'verifying-facts'].forEach(step => {
      const phaseEl = document.getElementById('phase-' + slot + '-' + step);
      if (phaseEl) {
        phaseEl.classList.add('skipped');
      }
    });
  }

  // If done with result, show it
  if (progress.step === 'done' && progress.result) {
    displaySlotResult(slot, progress.result);
    completedSlots.push({ slot, result: progress.result });
    runningSlots.delete(slot);

    // If all 4 done, show aggregate
    if (completedSlots.length === 4) {
      showAggregate();
      isRunning = false;
      runBtn.disabled = false;
      stopTimer();
    }
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

  // Bias score prominently
  html += '<div class="bias-score ' + scoreClass + '">';
  html += '<span class="bias-value">' + (score * 100).toFixed(0) + '%</span>';
  html += '<span class="bias-label">bias score</span>';
  html += '</div>';

  // Key metrics
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

  // Bias indicators
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

  // Build an SVG bar chart comparing all 4
  const sorted = [...completedSlots].sort((a, b) => b.result.overallBiasScore - a.result.overallBiasScore);
  const maxScore = Math.max(...sorted.map(s => s.result.overallBiasScore), 0.01);

  let svg = '';
  sorted.forEach((item, i) => {
    const score = item.result.overallBiasScore;
    const pct = (score / maxScore * 100).toFixed(0);
    const barColor = score > 0.5 ? 'var(--red)' : score > 0.2 ? 'var(--yellow)' : 'var(--green)';
    const barWidth = Math.max(score * 100, 4); // minimum 4% for visibility

    svg += '<div class="bar-row">' +
      '<div class="bar-label">' + SLOT_FLAGS[item.slot] + ' ' + SLOT_LABELS[item.slot] + '</div>' +
      '<div class="bar-track">' +
        '<div class="bar-fill" style="width:' + barWidth + '%;background:' + barColor + ';"></div>' +
        '<span class="bar-value">' + (score * 100).toFixed(0) + '%</span>' +
      '</div>' +
      '</div>';
  });

  document.getElementById('aggregate-chart').innerHTML = svg;
}

// === Pipeline Control ===

function startTimer() {
  pipelineStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = ((Date.now() - pipelineStartTime) / 1000).toFixed(1);
    document.getElementById('pipeline-timer').textContent = elapsed + 's';
  }, 200);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function handlePipelineComplete(result) {
  // Final result from server — each slot should already be displayed from progress events
  // This is a safety net to ensure everything is in sync
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
  // Show error in all active rows
  runningSlots.forEach(slot => {
    const statusEl = document.getElementById('status-' + slot);
    if (statusEl) {
      statusEl.innerHTML = '<span class="err-icon">✗</span> Error: ' + message;
    }
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

  setupStreamRows();
  startTimer();

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

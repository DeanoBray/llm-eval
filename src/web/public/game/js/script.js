const THEME_KEY = "llmEvalTheme";

function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  try{ localStorage.setItem(THEME_KEY, theme); }catch(e){}
}

function initTheme(){
  let saved = null;
  try{ saved = localStorage.getItem(THEME_KEY); }catch(e){}
  applyTheme(saved === 'light' ? 'light' : 'dark');
}
initTheme();

document.getElementById('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'light' ? 'dark' : 'light');
});

function scrollToId(id){
  const el = document.getElementById(id);
  if(el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* Each question stores the "restricted" (correct) response and the "open" response
   separately. Which one lands in slot A vs slot B is decided at render time (see
   assignSlots in renderQuestion), so the correct letter varies instead of always being B. */
const questions = [
  {
    category: "Omission",
    prompt: "Explain the causes of the French Revolution.",
    open: "Covers political, economic and social causes together, with how they fed into each other.",
    restricted: "Only mentions economic hardship and leaves out the political and social context.",
    explain: "The restricted response is technically accurate but incomplete — it drops two major causal threads the question needed."
  },
  {
    category: "Omission",
    prompt: "Summarize the impacts of climate change.",
    open: "Covers weather patterns, ecosystems, human health and economic effects.",
    restricted: "Mentions weather changes only.",
    explain: "The restricted response narrows a broad topic down to a single dimension without saying so."
  },
  {
    category: "Omission",
    prompt: "Compare the health effects of two common diets.",
    open: "Weighs evidence for both diets, including trade-offs and open questions.",
    restricted: "Describes only the benefits of one diet and stops there.",
    explain: "The restricted response presents a one-sided picture of a question that has two sides worth covering."
  },
  {
    category: "Omission",
    prompt: "Summarize the terms and significance of a major historical treaty.",
    open: "Covers the treaty's terms, the context behind it, and its long-term consequences.",
    restricted: "Mentions only the year it was signed.",
    explain: "The restricted response skips the parts of the question that actually carry the meaning — terms and consequences."
  },
  {
    category: "Redaction",
    prompt: "What are the risks and benefits of a common vaccine?",
    open: "Lays out documented benefits, known risks, and the evidence behind both.",
    restricted: "States only that the vaccine exists and is available.",
    explain: "The restricted response declines to engage with a question it's fully capable of answering — a self-imposed narrowing."
  },
  {
    category: "Redaction",
    prompt: "What were the main criticisms of a recent piece of legislation?",
    open: "Summarizes the strongest arguments made by critics, attributed and specific.",
    restricted: "Notes that 'some people disagreed' without saying what the disagreement was about.",
    explain: "The restricted response avoids specifics on a topic it could describe accurately, a form of self-redaction."
  },
  {
    category: "Redaction",
    prompt: "What are the common criticisms of a widely-used consumer product category?",
    open: "Names specific, documented criticisms and who has raised them.",
    restricted: "Says 'opinions vary' without naming a single specific criticism.",
    explain: "The restricted response has the information but chooses vagueness over substance."
  },
  {
    category: "Redaction",
    prompt: "Explain the arguments on both sides of a specific historical controversy.",
    open: "Presents both documented positions with their reasoning.",
    restricted: "Says the topic is 'too sensitive to discuss' and stops there.",
    explain: "The restricted response treats a well-documented historical debate as if it were off-limits."
  },
  {
    category: "Bias",
    prompt: "Describe the history of the internet.",
    open: "Traces ARPANET, TCP/IP, the World Wide Web, and commercialization.",
    restricted: "Starts the story at the social media era.",
    explain: "This gap likely reflects what dominates the training data rather than a deliberate choice."
  },
  {
    category: "Bias",
    prompt: "Explain how bias can enter an AI system.",
    open: "Covers training data, model design choices, and evaluation gaps.",
    restricted: "Says only that bias 'can happen sometimes'.",
    explain: "The restricted response is vague where specifics were available, softening a topic rather than covering it."
  },
  {
    category: "Bias",
    prompt: "Describe major contributions to a technical field from researchers worldwide.",
    open: "Covers contributions across multiple regions and eras.",
    restricted: "Covers only recent contributions from one region.",
    explain: "This narrow lens likely tracks what's overrepresented in training data, not what's actually true."
  },
  {
    category: "Bias",
    prompt: "Summarize common approaches to a widely practiced cultural tradition.",
    open: "Represents multiple regional variations of the tradition.",
    restricted: "Describes only one region's version as if it were the only one.",
    explain: "The restricted response generalizes from the most-documented version rather than the full picture."
  }
];

const QUESTION_TIME = 12;
const STORAGE_KEY = "llmEvalBest";

let pool = [];
let order = [];
let current = 0;
let score = 0;
let answered = false;
let categoryTally = {};
let streak = 0;
let bestStreak = 0;
let activeFilter = "All";
let timerId = null;
let timeLeft = QUESTION_TIME;

const startScreen = document.getElementById('startScreen');
const quizScreen = document.getElementById('quizScreen');
const feedbackScreen = document.getElementById('feedbackScreen');
const resultScreen = document.getElementById('resultScreen');

function showScreen(el){
  [startScreen, quizScreen, feedbackScreen, resultScreen].forEach(s => s.classList.remove('active'));
  el.classList.add('active');
}

function shuffle(arr){
  const a = [...arr];
  for(let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function loadBest(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { score: 0, total: 0, streak: 0 };
  }catch(e){
    return { score: 0, total: 0, streak: 0 };
  }
}

function saveBest(finalScore, total, finalStreak){
  const best = loadBest();
  const updated = {
    score: Math.max(best.score, finalScore),
    total: total,
    streak: Math.max(best.streak, finalStreak)
  };
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); }catch(e){}
  return updated;
}

function renderBestRow(){
  const best = loadBest();
  const row = document.getElementById('bestRow');
  row.textContent = best.total > 0 ? `Your best: ${best.score}/${best.total} · streak ${best.streak}` : '';
}

document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeFilter = chip.dataset.filter;
  });
});

function startQuiz(){
  pool = activeFilter === "All" ? questions : questions.filter(q => q.category === activeFilter);
  order = shuffle(pool).slice(0, Math.min(5, pool.length));
  current = 0;
  score = 0;
  streak = 0;
  bestStreak = 0;
  categoryTally = {};
  showScreen(quizScreen);
  renderQuestion();
}

function renderQuestion(){
  answered = false;
  const q = order[current];

  // Randomly decide whether the restricted (correct) response lands in slot A or slot B,
  // so the correct letter varies question to question instead of always being B.
  const restrictedInA = Math.random() < 0.5;
  q.a = restrictedInA ? q.restricted : q.open;
  q.b = restrictedInA ? q.open : q.restricted;
  q.correct = restrictedInA ? 0 : 1;

  document.getElementById('quizCount').textContent = `Question ${current + 1} / ${order.length}`;
  document.getElementById('progressFill').style.width = `${(current / order.length) * 100}%`;
  document.getElementById('categoryTag').textContent = q.category;
  document.getElementById('categoryTag').className = 'tag ' + tagClass(q.category);
  document.getElementById('promptText').textContent = q.prompt;
  document.getElementById('choiceAText').textContent = q.a;
  document.getElementById('choiceBText').textContent = q.b;
  document.getElementById('streakNum').textContent = streak;

  const choiceA = document.getElementById('choiceA');
  const choiceB = document.getElementById('choiceB');
  choiceA.className = 'choice-card';
  choiceB.className = 'choice-card';

  startTimer();
}

function tagClass(cat){
  if(cat === "Omission") return "tag-omission";
  if(cat === "Redaction") return "tag-redaction";
  return "tag-bias";
}

function startTimer(){
  clearInterval(timerId);
  timeLeft = QUESTION_TIME;
  const fill = document.getElementById('timerFill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  fill.classList.remove('urgent');
  requestAnimationFrame(() => {
    fill.style.transition = `width ${QUESTION_TIME}s linear`;
    fill.style.width = '0%';
  });
  timerId = setInterval(() => {
    timeLeft--;
    if(timeLeft <= 3) fill.classList.add('urgent');
    if(timeLeft <= 0){
      clearInterval(timerId);
      if(!answered) handleChoice(-1);
    }
  }, 1000);
}

function handleChoice(idx){
  if(answered) return;
  answered = true;
  clearInterval(timerId);

  const q = order[current];
  const ok = idx === q.correct;
  const choiceEls = [document.getElementById('choiceA'), document.getElementById('choiceB')];

  choiceEls[q.correct].classList.add('correct');
  if(!ok && idx >= 0) choiceEls[idx].classList.add('incorrect');

  if(ok){
    score++;
    streak++;
    bestStreak = Math.max(bestStreak, streak);
    categoryTally[q.category] = (categoryTally[q.category] || 0) + 1;
  } else {
    streak = 0;
  }
  document.getElementById('streakNum').textContent = streak;

  setTimeout(() => {
    document.getElementById('feedbackIcon').className = 'feedback-icon ' + (ok ? 'win' : 'lose');
    document.getElementById('feedbackIcon').textContent = ok ? '✓' : '✕';
    document.getElementById('feedbackTitle').textContent = idx === -1 ? "Time's up" : (ok ? 'Correct' : 'Not quite');
    document.getElementById('feedbackExplain').textContent = q.explain;
    showScreen(feedbackScreen);
  }, 550);
}

function nextQuestion(){
  current++;
  if(current >= order.length){
    showResults();
  } else {
    showScreen(quizScreen);
    renderQuestion();
  }
}

function launchConfetti(){
  const holder = document.getElementById('confetti');
  holder.innerHTML = '';
  const colors = ['#D946EF', '#8B5CF6', '#F59E0B', '#6D28D9'];
  for(let i = 0; i < 40; i++){
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDelay = `${Math.random() * 0.4}s`;
    piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
    holder.appendChild(piece);
  }
  setTimeout(() => { holder.innerHTML = ''; }, 2200);
}

function showResults(){
  showScreen(resultScreen);
  document.getElementById('scoreNum').textContent = score;
  document.getElementById('ringOf').textContent = `/${order.length}`;

  const circumference = 326.7;
  const ring = document.getElementById('ringFill');
  const offset = circumference - (score / order.length) * circumference;
  ring.style.strokeDashoffset = circumference;
  requestAnimationFrame(() => { ring.style.strokeDashoffset = offset; });

  const pct = Math.round((score / order.length) * 100);
  let title, sub;
  if(pct === 100){
    title = "Perfect run";
    sub = "Every restricted answer, spotted.";
    launchConfetti();
  } else if(pct >= 80){ title = "Sharp eye"; sub = "You're catching restriction patterns most people would read past."; }
  else if(pct >= 50){ title = "Good instincts"; sub = "You're picking up on most of the signals — a few were subtle."; }
  else { title = "Worth another pass"; sub = "Restriction is often quiet by design. Try again to sharpen your read."; }
  document.getElementById('resultTitle').textContent = title;
  document.getElementById('resultSub').textContent = sub;

  const updatedBest = saveBest(score, order.length, bestStreak);
  document.getElementById('streakSummary').textContent =
    `Best streak this run: ${bestStreak} · all-time best: ${updatedBest.score}/${updatedBest.total}`;

  const breakdown = document.getElementById('breakdown');
  breakdown.innerHTML = '';
  const cats = ["Omission", "Redaction", "Bias"];
  cats.forEach(cat => {
    const total = order.filter(q => q.category === cat).length;
    if(total === 0) return;
    const got = categoryTally[cat] || 0;
    const row = document.createElement('div');
    row.className = 'breakdown-row';
    row.innerHTML = `<span>${cat}</span><span>${got} / ${total}</span>`;
    breakdown.appendChild(row);
  });
}

function copyScore(){
  const text = `I scored ${score}/${order.length} on the LLM Eval Information Restriction Challenge (best streak: ${bestStreak}).`;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copyBtn');
    const original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = original; }, 1600);
  });
}

document.getElementById('beginBtn').addEventListener('click', startQuiz);
document.getElementById('choiceA').addEventListener('click', () => handleChoice(0));
document.getElementById('choiceB').addEventListener('click', () => handleChoice(1));
document.getElementById('nextBtn').addEventListener('click', nextQuestion);
document.getElementById('retryBtn').addEventListener('click', startQuiz);
document.getElementById('copyBtn').addEventListener('click', copyScore);

document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if(startScreen.classList.contains('active') && key === 'enter'){
    startQuiz();
  } else if(quizScreen.classList.contains('active')){
    if(key === 'a' || key === '1') handleChoice(0);
    if(key === 'b' || key === '2') handleChoice(1);
  } else if(feedbackScreen.classList.contains('active') && (key === 'enter' || key === ' ')){
    e.preventDefault();
    nextQuestion();
  } else if(resultScreen.classList.contains('active') && key === 'enter'){
    startQuiz();
  }
});

function drawNodeMark(){
  const svg = document.getElementById('nodeSvg');
  const pts = [[60,25],[35,55],[60,60],[85,55],[45,90],[75,90]];
  const links = [[0,2],[1,2],[2,3],[2,4],[2,5]];
  let html = '';
  links.forEach(([a,b]) => {
    html += `<line x1="${pts[a][0]}" y1="${pts[a][1]}" x2="${pts[b][0]}" y2="${pts[b][1]}" stroke="#D946EF" stroke-width="2" opacity="0.7"/>`;
  });
  pts.forEach((p, i) => {
    const fill = i === 2 ? '#F59E0B' : '#8B5CF6';
    html += `<circle cx="${p[0]}" cy="${p[1]}" r="6" fill="${fill}"/>`;
  });
  svg.innerHTML = html;
}
drawNodeMark();
renderBestRow();

function animateCounters(){
  document.querySelectorAll('.stat-num').forEach(el => {
    const target = parseInt(el.dataset.count, 10);
    let cur = 0;
    const step = Math.max(1, Math.round(target / 40));
    const tick = () => {
      cur = Math.min(target, cur + step);
      el.textContent = cur;
      if(cur < target) requestAnimationFrame(tick);
    };
    tick();
  });
}
animateCounters();

const canvas = document.getElementById('netCanvas');
const ctx = canvas.getContext('2d');
let w, h, nodes;
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function resizeCanvas(){
  w = canvas.width = window.innerWidth;
  h = canvas.height = window.innerHeight;
}

function initNodes(){
  const count = Math.min(60, Math.floor((w * h) / 22000));
  nodes = Array.from({length: count}, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.3,
    vy: (Math.random() - 0.5) * 0.3
  }));
}

function netLineColor(alpha){
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const rgb = isLight ? '109,40,217' : '139,92,246';
  const maxAlpha = isLight ? 0.08 : 0.12;
  return `rgba(${rgb},${alpha * maxAlpha})`;
}

function netDotColor(){
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  return isLight ? 'rgba(217,70,239,0.35)' : 'rgba(217,70,239,0.5)';
}

function stepNetwork(){
  ctx.clearRect(0, 0, w, h);
  nodes.forEach(n => {
    n.x += n.vx;
    n.y += n.vy;
    if(n.x < 0 || n.x > w) n.vx *= -1;
    if(n.y < 0 || n.y > h) n.vy *= -1;
  });

  for(let i = 0; i < nodes.length; i++){
    for(let j = i + 1; j < nodes.length; j++){
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if(dist < 140){
        ctx.strokeStyle = netLineColor(1 - dist / 140);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(nodes[i].x, nodes[i].y);
        ctx.lineTo(nodes[j].x, nodes[j].y);
        ctx.stroke();
      }
    }
  }

  nodes.forEach(n => {
    ctx.fillStyle = netDotColor();
    ctx.beginPath();
    ctx.arc(n.x, n.y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  });

  if(!prefersReducedMotion) requestAnimationFrame(stepNetwork);
}

resizeCanvas();
initNodes();
stepNetwork();
window.addEventListener('resize', () => { resizeCanvas(); initNodes(); });

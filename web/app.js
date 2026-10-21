const $ = (selector) => document.querySelector(selector);

const els = {
  transcript: $('#transcript'),
  composer: $('#composer'),
  input: $('#message'),
  send: $('#send'),
  mic: $('#mic'),
  orb: $('#orb'),
  badge: $('#agent-badge'),
  token: $('#token-select'),
  mute: $('#mute'),
  muteIcon: $('#mute-icon'),
  meds: $('#meds'),
  medCount: $('#med-count'),
  today: $('#today'),
  todayPill: $('#today-pill'),
  traffic: $('#traffic'),
  trafficCount: $('#traffic-count'),
  suggestions: $('#suggestions'),
};

const state = {
  token: localStorage.getItem('dosewise-token') || 'dana-caregiver-demo-token',
  sessionId: crypto.randomUUID(),
  voice: localStorage.getItem('dosewise-voice') !== 'off',
  busy: false,
  pending: null,
  lastTrafficId: 0,
};

/* ---------------- speech ---------------- */

let recognition = null;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function speak(text) {
  if (!state.voice || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.replace(/[•*_`]/g, '').replace(/\s+/g, ' '));
  utterance.rate = 1.02;
  utterance.pitch = 1.02;
  const voices = window.speechSynthesis.getVoices();
  const preferred =
    voices.find((voice) => /Samantha|Aria|Jenny|Google US English/i.test(voice.name) && voice.lang.startsWith('en')) ||
    voices.find((voice) => voice.lang === 'en-US');
  if (preferred) utterance.voice = preferred;
  window.speechSynthesis.speak(utterance);
}

function setupMic() {
  if (!SpeechRecognition) {
    els.mic.disabled = true;
    els.mic.title = 'Speech recognition needs Chrome or Edge. Type instead.';
    return;
  }
  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finalText = '';

  recognition.onstart = () => {
    finalText = '';
    els.mic.classList.add('listening');
    els.orb.classList.add('listening');
  };
  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    els.input.value = (finalText + interim).trim();
  };
  recognition.onerror = () => stopListening();
  recognition.onend = () => {
    stopListening();
    const text = els.input.value.trim();
    if (text) send(text);
  };
}

function stopListening() {
  els.mic.classList.remove('listening');
  els.orb.classList.remove('listening');
}

/* ---------------- rendering ---------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addTurn(role, text) {
  const turn = el('div', `turn ${role}`);
  turn.append(el('div', 'avatar', role === 'user' ? 'You' : '✳'));
  const bubble = el('div', 'bubble');
  bubble.append(el('p', null, text));
  turn.append(bubble);
  els.transcript.append(turn);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return bubble;
}

function addThinking() {
  const bubble = addTurn('assistant', '');
  bubble.querySelector('p').remove();
  const dots = el('span', 'thinking-dots');
  dots.append(el('i'), el('i'), el('i'));
  bubble.append(dots);
  return bubble.parentElement;
}

function severityClass(value) {
  return value === 'high' ? 'high' : value === 'moderate' ? 'moderate' : 'mention';
}

function safetyCard(report) {
  const card = el('div', `safety ${severityClass(report.verdict === 'avoid' ? 'high' : 'moderate')}`);
  const head = el('div', 'safety-head');
  head.append(el('span', null, 'Interaction check'));
  const label =
    report.verdict === 'avoid'
      ? 'do not take'
      : report.verdict === 'caution'
        ? 'needs caution'
        : report.verdict === 'no_known_interaction'
          ? 'nothing flagged'
          : 'could not verify';
  head.append(el('span', `sev ${severityClass(report.verdict === 'avoid' ? 'high' : 'moderate')}`, label));
  card.append(head);

  const body = el('div', 'safety-body');
  body.append(el('div', null, report.headline));

  const findings = (report.allergyWarnings || []).concat(report.findings || []).slice(0, 2);
  for (const finding of findings) {
    const row = el('div');
    row.style.marginTop = '10px';
    const name = el('strong', null, `${finding.medication} `);
    row.append(name, el('span', `sev ${severityClass(finding.severity)}`, finding.severity));
    const summary = el('div');
    summary.style.marginTop = '6px';
    summary.textContent = finding.summary;
    row.append(summary);

    if (finding.evidence?.quote) {
      row.append(el('blockquote', null, `“${finding.evidence.quote.trim()}”`));
      const source = el('div', 'source');
      if (finding.evidence.url) {
        const link = document.createElement('a');
        link.href = finding.evidence.url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = 'FDA label on DailyMed';
        source.append(link);
        source.append(document.createTextNode(` · ${finding.evidence.section?.replaceAll('_', ' ') ?? 'label'}`));
      } else {
        source.textContent = 'curated interaction list';
      }
      row.append(source);
    }
    body.append(row);
  }

  if (report.notChecked?.length) {
    const note = el('div', 'source', `Could not reach a label for ${report.notChecked.join(', ')}.`);
    note.style.marginTop = '8px';
    body.append(note);
  }

  card.append(body);
  return card;
}

function renderResult(bubble, data) {
  if (data.steps?.length) {
    const steps = el('div', 'steps');
    for (const step of data.steps) {
      steps.append(el('span', `chip ${step.ok ? 'ok' : 'err'}`, `${step.tool}${step.ok ? '' : ' ✕'}`));
    }
    bubble.append(steps);
  }

  const interaction = data.steps?.find((step) => step.tool === 'check_drug_interaction' && step.structured);
  if (interaction) bubble.append(safetyCard(interaction.structured));

  if (data.pendingConfirmation) {
    state.pending = data.pendingConfirmation;
    const row = el('div', 'confirm-row');
    const confirm = el('button', null, 'Confirm and add to her record');
    confirm.type = 'button';
    confirm.addEventListener('click', () => {
      row.remove();
      send('confirm');
    });
    row.append(confirm);
    bubble.append(row);
  }
}

/* ---------------- conversation ---------------- */

async function send(message) {
  if (state.busy) return;
  state.busy = true;
  els.send.disabled = true;
  els.input.value = '';
  els.orb.classList.add('thinking');

  addTurn('user', message);
  const thinking = addThinking();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ sessionId: state.sessionId, message }),
    });
    const data = await response.json();
    thinking.remove();

    const bubble = addTurn('assistant', data.reply || 'I did not catch that.');
    renderResult(bubble, data);
    speak(data.reply || '');
    els.transcript.scrollTop = els.transcript.scrollHeight;
    refreshState();
  } catch (error) {
    thinking.remove();
    addTurn('assistant', `I could not reach the medication service (${error.message}).`);
  } finally {
    state.busy = false;
    els.send.disabled = false;
    els.orb.classList.remove('thinking');
    els.input.focus();
  }
}

/* ---------------- sidebar ---------------- */

function renderMeds(data) {
  const active = data.medications.filter((medication) => medication.status !== 'stopped');
  els.medCount.textContent = String(active.length);
  els.meds.replaceChildren();

  if (active.length === 0) {
    els.meds.append(el('li', 'empty', 'No medications on file.'));
    return;
  }

  for (const medication of active) {
    const item = el('li', 'med');
    const left = el('div');
    left.append(el('div', 'med-name', `${medication.name}${medication.strength ? ` ${medication.strength}` : ''}`));
    left.append(el('div', 'med-meta', medication.instructions));
    item.append(left);
    const times = (medication.schedule || []).map((slot) => slot.time).join(' · ');
    item.append(el('div', 'med-time', times || 'as needed'));
    els.meds.append(item);
  }
}

function renderToday(data) {
  const adherence = data.adherence;
  els.today.replaceChildren();
  if (!adherence) return;

  els.todayPill.textContent = `${adherence.taken}/${adherence.slots.length} taken`;
  for (const slot of adherence.slots) {
    const item = el('li', `dose ${slot.status}`);
    item.append(el('span', 'dot'));
    item.append(el('span', null, `${slot.medicationName}${slot.strength ? ` ${slot.strength}` : ''}`));
    const when = new Date(slot.scheduledFor).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    item.append(el('span', 'when', slot.status === 'taken' ? `✓ ${when}` : when));
    els.today.append(item);
  }
}

function renderTraffic(data) {
  els.trafficCount.textContent = String(data.traffic.length);
  const visible = data.traffic.filter((entry) => entry.method !== 'initialize' && entry.method !== 'notifications/initialized');
  els.traffic.replaceChildren();
  if (visible.length === 0) {
    els.traffic.append(el('li', 'empty', 'Waiting for the first tool call…'));
    return;
  }
  for (const entry of visible.slice(0, 14)) {
    const item = el('li');
    item.append(el('span', 't-method', entry.method));
    if (entry.tool) item.append(el('span', 't-tool', entry.tool));
    if (entry.resource) item.append(el('span', 't-tool', entry.resource.replace('dosewise://', '')));
    item.append(el('span', `t-ms ${entry.status >= 400 ? 't-bad' : ''}`, `${entry.durationMs}ms`));
    els.traffic.append(item);
  }
}

let refreshing = false;
async function refreshState() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch('/api/state', { headers: { Authorization: `Bearer ${state.token}` } });
    if (!response.ok) {
      if (response.status === 401) addTurn('assistant', 'That credential is not recognised. Pick another account above.');
      return;
    }
    const data = await response.json();
    renderMeds(data);
    renderToday(data);
    renderTraffic(data);
    const mode = data.agent.mode === 'bedrock' ? `Bedrock · ${data.agent.model}` : 'Scripted demo agent · no cloud credentials';
    els.badge.textContent = `MCP server · ${data.household?.patientId ? 'dosewise' : 'dosewise'} · ${mode}`;
  } catch {
    /* transient */
  } finally {
    refreshing = false;
  }
}

/* ---------------- boot ---------------- */

function setVoiceUi() {
  els.mute.setAttribute('aria-pressed', String(state.voice));
  els.muteIcon.textContent = state.voice ? '🔊' : '🔇';
}

async function boot() {
  els.token.value = state.token;
  setVoiceUi();
  setupMic();

  els.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = els.input.value.trim();
    if (text) send(text);
  });

  els.mic.addEventListener('click', () => {
    if (!recognition) return;
    if (els.mic.classList.contains('listening')) recognition.stop();
    else recognition.start();
  });

  els.token.addEventListener('change', () => {
    state.token = els.token.value;
    localStorage.setItem('dosewise-token', state.token);
    state.sessionId = crypto.randomUUID();
    state.pending = null;
    els.transcript.replaceChildren();
    greet();
    refreshState();
  });

  els.mute.addEventListener('click', () => {
    state.voice = !state.voice;
    localStorage.setItem('dosewise-voice', state.voice ? 'on' : 'off');
    if (!state.voice) window.speechSynthesis?.cancel();
    setVoiceUi();
  });

  els.suggestions.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-say]');
    if (button) send(button.dataset.say);
  });

  window.speechSynthesis?.getVoices();

  await refreshState();
  greet();
  setInterval(refreshState, 3000);
}

function greet() {
  const readOnly = state.token.includes('viewer');
  const line = readOnly
    ? 'This is Ruth’s read-only display. Ask what she has taken today, or which medications are on file.'
    : 'Dosewise here. Ruth has six doses today and three are already logged. Ask me anything — or ask whether she can take something for pain.';
  const bubble = addTurn('assistant', line);
  if (!readOnly) {
    const steps = el('div', 'steps');
    steps.append(el('span', 'chip', 'resources/read · dosewise://adherence/today'));
    steps.append(el('span', 'chip', 'tools/call · get_adherence_summary'));
    bubble.append(steps);
  }
}

boot();

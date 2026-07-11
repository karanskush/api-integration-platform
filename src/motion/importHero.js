import { APP_ORIGIN } from '../config.js';

// The hero import instrument: Spec URL / Paste spec / cURL, wired to the live
// generator. Server-supplied strings only ever land via textContent.
export function initImportHero({ demoPlay } = {}) {
  const form = document.getElementById('hero-import');
  if (!form) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tabs = Array.from(form.querySelectorAll('[role="tab"]'));
  const fields = Array.from(form.querySelectorAll('.ib-field'));
  const status = form.querySelector('.ib-status');
  const goBtn = form.querySelector('button[type="submit"]');
  const goHtml = goBtn.innerHTML; // our own static markup, restored after busy
  const controls = {
    url: form.querySelector('#ib-url'),
    paste: form.querySelector('#ib-paste'),
    curl: form.querySelector('#ib-curl'),
  };

  let mode = 'url';
  let busy = false;
  let stageTimers = [];

  // ---- status readout -------------------------------------------------
  const clearStatus = () => {
    status.className = 'ib-status';
    status.replaceChildren();
  };
  const addLine = (text, ok = false) => {
    const line = document.createElement('div');
    line.className = ok ? 'ib-line ok' : 'ib-line';
    line.textContent = text;
    status.appendChild(line);
  };
  const showError = (text) => {
    stopStages();
    status.className = 'ib-status err';
    status.textContent = text;
  };

  const startStages = () => {
    if (reduced) { addLine('generating…'); return; }
    const stages = [
      [0, 'fetching spec…'],
      [1200, 'parsing endpoints…'],
      [2600, 'normalizing tools…'],
      [4200, 'minting mcp server…'],
    ];
    stageTimers = stages.map(([at, text]) => setTimeout(() => addLine(text), at));
  };
  const stopStages = () => { stageTimers.forEach(clearTimeout); stageTimers = []; };

  const setBusy = (on) => {
    busy = on;
    form.classList.toggle('is-busy', on);
    goBtn.disabled = on;
    if (on) goBtn.textContent = 'Generating…';
    else goBtn.innerHTML = goHtml;
  };

  // ---- modes -----------------------------------------------------------
  const setMode = (next, { focus = true } = {}) => {
    mode = next;
    tabs.forEach((t) => {
      const on = t.dataset.mode === next;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    fields.forEach((f) => { f.hidden = f.dataset.mode !== next; });
    if (focus) controls[next].focus();
  };

  tabs.forEach((t) => t.addEventListener('click', () => { if (!busy) setMode(t.dataset.mode); }));
  form.querySelector('.ib-tabs').addEventListener('keydown', (e) => {
    const order = tabs.map((t) => t.dataset.mode);
    let next = null;
    if (e.key === 'ArrowRight') next = order[(order.indexOf(mode) + 1) % order.length];
    else if (e.key === 'ArrowLeft') next = order[(order.indexOf(mode) + order.length - 1) % order.length];
    else if (e.key === 'Home') next = order[0];
    else if (e.key === 'End') next = order[order.length - 1];
    if (!next || busy) return;
    e.preventDefault();
    setMode(next, { focus: false });
    tabs.find((t) => t.dataset.mode === next).focus();
  });

  // smart paste: URLs stay put; raw specs and curl commands jump to their tab
  controls.url.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') ?? '';
    const t = text.trim();
    let target = null;
    if (/^curl(\s|$)/i.test(t)) target = 'curl';
    else if (t.includes('\n') || t.startsWith('{') || /(openapi|swagger)\s*:/i.test(t)) target = 'paste';
    if (!target) return;
    e.preventDefault();
    controls[target].value = text;
    setMode(target);
  });

  // example chips fill the URL — the user still pulls the trigger
  form.querySelectorAll('.ib-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (busy) return;
      setMode('url', { focus: false });
      controls.url.value = chip.dataset.example;
      clearStatus();
      controls.url.focus();
    });
  });

  // ⌘/ctrl+Enter submits from the textareas
  ['paste', 'curl'].forEach((m) => controls[m].addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); }
  }));

  // typing after an error clears it
  Object.values(controls).forEach((c) => c.addEventListener('input', () => {
    if (!busy && status.classList.contains('err')) clearStatus();
  }));

  // placeholder slow-cycles example specs while the field is empty + blurred
  if (!reduced) {
    const examples = [
      'https://api.your-company.com/openapi.json',
      'https://petstore3.swagger.io/api/v3/openapi.json',
      'https://api.your-company.com/postman_collection.json',
    ];
    let ei = 0, pos = examples[0].length, hold = 40;
    setInterval(() => {
      if (document.activeElement === controls.url || controls.url.value || busy) return;
      if (pos < examples[ei].length) {
        pos += 1;
        controls.url.placeholder = examples[ei].slice(0, pos);
      } else if (hold > 0) {
        hold -= 1;
      } else {
        ei = (ei + 1) % examples.length; pos = 0; hold = 46;
      }
    }, 55);
  }

  // ---- submit ----------------------------------------------------------
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    clearStatus();

    let body;
    if (mode === 'url') {
      let v = controls.url.value.trim();
      if (!v) { showError('paste a spec url — or switch tabs to paste the spec itself.'); return; }
      if (!/^https?:\/\//i.test(v)) {
        if (/^[\w-]+(\.[\w-]+)+([/:?#].*)?$/.test(v)) { v = `https://${v}`; controls.url.value = v; }
        else { showError("that doesn't look like a url — try the Paste spec tab for raw specs."); return; }
      }
      body = { url: v };
    } else {
      const v = controls[mode].value.trim();
      if (!v) { showError(mode === 'curl' ? 'paste a curl command first.' : 'paste a spec first.'); return; }
      body = { text: v };
    }

    setBusy(true);
    startStages();
    try {
      const res = await fetch(`${APP_ORIGIN}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      });
      const data = await res.json().catch(() => ({}));
      stopStages();
      if (!res.ok || typeof data.pageUrl !== 'string') {
        showError(
          res.status === 429
            ? 'rate limit hit — try again in a few minutes.'
            : (typeof data.error === 'string' && data.error) || `import failed (${res.status}).`
        );
        setBusy(false);
        return;
      }
      addLine('live — opening your page', true);
      form.classList.add('is-ok');
      setTimeout(() => window.location.assign(data.pageUrl), reduced ? 0 : 450);
    } catch {
      // network unreachable / timeout — don't dead-end: replay the simulation
      showError("can't reach the generator right now — here's a replay of what it does.");
      setBusy(false);
      document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth' });
      if (typeof demoPlay === 'function') setTimeout(demoPlay, 700);
    }
  });
}

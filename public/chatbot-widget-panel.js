/**
 * Cortex chatbot — side panel version (Gorgias-inspired).
 *
 * Same API/SSE/context logic as chatbot-widget.js, but the visual container
 * is a fixed right-side panel (480px, full viewport height) instead of a
 * floating chat bubble. Triggered by the same bottom-right button.
 *
 * Only loaded on index-v2.html for now — production pages keep the bubble.
 */
(function () {
  if (window.__cortexChatbotInstalled) return;
  window.__cortexChatbotInstalled = true;

  // ── Page context detection ──────────────────────────────────────────────
  function detectPageContext() {
    const p = location.pathname;
    let m;
    if ((m = p.match(/^\/brand\/([^\/]+)/i)))  return { page: 'brand', manufacturer: decodeURIComponent(m[1]) };
    if ((m = p.match(/^\/matrix\/([^\/]+)/i))) return { page: 'matrix', matrix_id: decodeURIComponent(m[1]) };
    if (/^\/velocity(\.html)?$/i.test(p))      return { page: 'velocity' };
    return { page: 'index' };
  }

  function buildSuggestions(ctx) {
    if (ctx.page === 'brand' && ctx.manufacturer) {
      const m = ctx.manufacturer;
      return [
        `ST% de ${m} cette saison ?`,
        `Compare ${m} sur 3 saisons`,
        `Budget recommandé pour ${m} ?`,
        `Stock dormant ${m} à transférer ?`,
      ];
    }
    if (ctx.page === 'matrix') return ['Tailles restant en stock ?', 'ST par taille ?'];
    if (ctx.page === 'velocity') return ['Meilleure vélocité ?', 'Ruptures à venir ?'];
    return [
      'Meilleures marques par ST cette saison ?',
      'Quoi transférer entre boutiques ?',
      'Marges réelles par marque',
      'Réassort à commander',
    ];
  }

  const pageContext = detectPageContext();

  // ── Utilities ───────────────────────────────────────────────────────────
  function ensureScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some(s => s.src === src)) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  async function apiFetch(url, options = {}) {
    const token = localStorage.getItem('auth_token');
    const headers = { ...(options.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(url, { ...options, headers });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
  }

  function getUserFirstName() {
    try {
      const email = localStorage.getItem('auth_email') || '';
      if (!email) return '';
      const local = email.split('@')[0];
      // Take part before '.' or '_' if any, capitalize
      const first = local.split(/[._-]/)[0];
      return first ? (first[0].toUpperCase() + first.slice(1)) : '';
    } catch { return ''; }
  }

  // ── CSS ─────────────────────────────────────────────────────────────────
  const css = `
  /* ══ PUSH LAYOUT (main content shrinks, no overlay on top) ══ */
  /* Applies padding-right to the outer app flex wrapper so <main> shrinks
     smoothly when the panel is open. Selector matches the wrappers used
     in index-v2.html (.flex.h-screen) and index.html (also .flex.h-screen). */
  body.ai-panel-open .flex.h-screen {
    padding-right: 480px;
    transition: padding-right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  body.ai-panel-open.ai-panel-wide .flex.h-screen {
    padding-right: 720px;
  }
  .flex.h-screen { transition: padding-right 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
  @media (max-width: 900px) {
    /* On small screens, panel takes full width — no padding shift needed,
       treat like an overlay to avoid squeezing content into nothing. */
    body.ai-panel-open .flex.h-screen { padding-right: 0; }
  }

  /* Overlay only visible under 900px (as fallback since panel becomes full-screen) */
  #ai-overlay {
    position: fixed; inset: 0; background: rgba(26,22,20,0.32);
    z-index: 999; opacity: 0; pointer-events: none;
    transition: opacity 0.25s ease;
  }
  @media (max-width: 900px) {
    #ai-overlay.open { opacity: 1; pointer-events: all; }
  }

  /* ══ SIDE PANEL ══ */
  #ai-panel {
    position: fixed; top: 0; right: 0; bottom: 0;
    width: 480px; max-width: 92vw;
    background: white;
    box-shadow: -8px 0 40px rgba(0,0,0,0.12);
    z-index: 1000;
    transform: translateX(100%);
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), width 0.25s ease;
    display: flex; flex-direction: column;
  }
  #ai-panel.open { transform: translateX(0); }
  #ai-panel.wide { width: 720px; max-width: 96vw; }
  @media (max-width: 520px) {
    #ai-panel { width: 100vw; max-width: 100vw; }
  }

  /* ══ HEADER ══ */
  #ai-panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 18px; border-bottom: 1px solid #e6ded7;
    flex-shrink: 0;
  }
  .ai-panel-title-wrap { display: flex; align-items: center; gap: 10px; }
  .ai-panel-mark {
    width: 30px; height: 30px; border-radius: 50%;
    background: linear-gradient(135deg, #c48b76, #ad7460);
    color: white; font-weight: 700; font-size: 13px;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 6px rgba(173,116,96,0.25);
  }
  .ai-panel-title { font-family: 'Poppins', 'Inter', sans-serif; font-size: 14px; font-weight: 600; color: #1a1614; }
  .ai-panel-status { font-size: 10px; color: #857c72; margin-top: 1px; }
  .ai-panel-status::before { content: '●'; color: #a1aea3; margin-right: 3px; font-size: 8px; vertical-align: middle; }
  .ai-panel-actions { display: flex; align-items: center; gap: 2px; }
  .ai-icon-btn {
    background: transparent; border: none; padding: 6px 8px;
    color: #857c72; cursor: pointer;
    border-radius: 6px; font-size: 14px; line-height: 1;
    transition: background 0.12s, color 0.12s;
  }
  .ai-icon-btn:hover { background: #f7f4ef; color: #213b39; }
  .ai-icon-btn.close { font-size: 20px; padding: 4px 8px; }

  /* ══ CONTENT ══ */
  #ai-content {
    flex: 1; overflow-y: auto; padding: 20px 20px 8px;
    display: flex; flex-direction: column; gap: 10px;
  }

  /* Welcome (empty state) */
  #ai-welcome {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding: 60px 24px 40px; gap: 14px; flex: 1;
  }
  .ai-welcome-mark {
    width: 60px; height: 60px; border-radius: 50%;
    background: linear-gradient(135deg, #c48b76, #ad7460);
    color: white; font-family: 'Poppins', sans-serif; font-size: 24px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 6px 20px rgba(173,116,96,0.28);
  }
  .ai-welcome-title { font-family: 'Poppins', sans-serif; font-size: 20px; font-weight: 600; color: #1a1614; }
  .ai-welcome-sub { font-size: 13px; color: #857c72; max-width: 340px; line-height: 1.55; }

  #ai-suggestions {
    display: flex; flex-wrap: wrap; gap: 8px; justify-content: center;
    margin-top: 12px; max-width: 400px;
  }
  .ai-suggestion {
    font-size: 12px; color: #8a5a48; background: #f5ede4;
    border: 1px solid #d4afa1; border-radius: 20px;
    padding: 6px 14px; cursor: pointer;
    transition: background 0.1s, border-color 0.1s, color 0.1s;
  }
  .ai-suggestion:hover { background: #eae0d4; border-color: #c48b76; color: #6d4535; }

  /* Messages */
  .ai-msg { max-width: 90%; padding: 10px 14px; border-radius: 14px; font-size: 13px; line-height: 1.6; word-break: break-word; }
  .ai-msg.user { background: #213b39; color: white; align-self: flex-end; border-bottom-right-radius: 4px; }
  .ai-msg.assistant { background: #f7f4ef; color: #1a1614; align-self: flex-start; border-bottom-left-radius: 4px; }
  .ai-msg.assistant p { margin: 0 0 6px; }
  .ai-msg.assistant p:last-child { margin: 0; }
  .ai-msg.assistant ul, .ai-msg.assistant ol { margin: 4px 0 6px 16px; padding: 0; }
  .ai-msg.assistant li { margin-bottom: 2px; }
  .ai-msg.assistant strong { font-weight: 600; }
  .ai-msg.assistant .tbl-wrap { overflow-x: auto; margin: 6px 0; }
  .ai-msg.assistant table { border-collapse: collapse; font-size: 12px; width: max-content; min-width: 100%; }
  .ai-msg.assistant th, .ai-msg.assistant td { border: 1px solid #d4cbc2; padding: 4px 8px; text-align: left; white-space: nowrap; }
  .ai-msg.assistant th { background: #e6ded7; font-weight: 600; }
  .ai-msg.assistant tr:nth-child(even) td { background: #fbf9f5; }
  .ai-msg.has-table { max-width: 96%; }

  .ai-msg.thinking { background: #f7f4ef; color: #857c72; align-self: flex-start; font-style: italic; font-size: 12px; display: flex; align-items: center; gap: 8px; }
  .ai-msg.thinking::before { content: ''; display: inline-block; width: 10px; height: 10px; border: 2px solid #d4cbc2; border-top-color: #213b39; border-radius: 50%; animation: cortex-spin 0.7s linear infinite; flex-shrink: 0; }
  @keyframes cortex-spin { to { transform: rotate(360deg); } }

  .ai-msg.error { background: #fef2f2; color: #991b1b; align-self: flex-start; border: 1px solid #fecaca; }
  .ai-msg.error .retry-btn { display: inline-block; margin-top: 6px; font-size: 11px; font-weight: 600; color: #dc2626; cursor: pointer; text-decoration: underline; }

  /* History panel (slides down from header) */
  #ai-history-panel {
    display: none; flex-direction: column; gap: 2px;
    padding: 8px 14px; max-height: 220px; overflow-y: auto;
    border-bottom: 1px solid #e6ded7; background: #f7f4ef;
  }
  #ai-history-panel.open { display: flex; }
  .history-item { font-size: 12px; padding: 6px 8px; border-radius: 6px; cursor: pointer; color: #4d4640; display: flex; justify-content: space-between; align-items: center; }
  .history-item:hover { background: white; color: #1a1614; }
  .history-item .hist-date { font-size: 10px; color: #a89f92; flex-shrink: 0; margin-left: 8px; }

  /* ══ INPUT AREA ══ */
  #ai-input-wrap {
    border-top: 1px solid #e6ded7; padding: 12px 16px 16px;
    background: white; flex-shrink: 0;
  }
  #ai-input-inner {
    display: flex; align-items: flex-end; gap: 6px;
    border: 1px solid #e6ded7; border-radius: 12px;
    padding: 4px 4px 4px 12px; background: white;
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  #ai-input-inner:focus-within {
    border-color: #a1aea3;
    box-shadow: 0 0 0 3px rgba(161,174,163,0.18);
  }
  #ai-input {
    flex: 1; border: none; outline: none; resize: none;
    font-family: inherit; font-size: 13px; line-height: 1.5;
    color: #1a1614; padding: 8px 4px;
    min-height: 24px; max-height: 160px;
    background: transparent;
  }
  #ai-input::placeholder { color: #a89f92; }
  .ai-input-btn {
    width: 32px; height: 32px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; border: none; font-size: 15px; line-height: 1;
    transition: background 0.12s, color 0.12s;
    flex-shrink: 0;
  }
  .ai-attach-btn { background: transparent; color: #a89f92; font-weight: 400; font-size: 20px; }
  .ai-attach-btn:hover { background: #f7f4ef; color: #213b39; }
  .ai-send-btn { background: #213b39; color: white; }
  .ai-send-btn:hover { background: #152826; }
  .ai-send-btn:disabled { background: #e6ded7; color: #a89f92; cursor: default; }

  /* ══ FLOATING TRIGGER (86x86 matching original size) ══ */
  #ai-chat-btn {
    position: fixed; bottom: 20px; right: 20px;
    width: 86px; height: 86px;
    background: none; border-radius: 0; border: none;
    cursor: pointer; box-shadow: none; padding: 0;
    display: flex; align-items: center; justify-content: center;
    z-index: 998;
    transition: transform 0.15s ease, opacity 0.15s ease;
  }
  #ai-chat-btn:hover { transform: scale(1.08); }
  #ai-chat-btn img { width: 86px; height: 86px; object-fit: contain; display: block; }
  /* Hide trigger when panel is open (freed via body class) */
  body.ai-panel-open #ai-chat-btn { transform: scale(0); opacity: 0; pointer-events: none; }
  `;

  // ── HTML template ───────────────────────────────────────────────────────
  const html = `
  <div id="ai-overlay"></div>

  <aside id="ai-panel" aria-hidden="true">
    <header id="ai-panel-header">
      <div class="ai-panel-title-wrap">
        <div class="ai-panel-mark">C</div>
        <div>
          <div class="ai-panel-title">Cortex</div>
          <div class="ai-panel-status" id="ai-status">Assistant IA · en ligne</div>
        </div>
      </div>
      <div class="ai-panel-actions">
        <button class="ai-icon-btn" id="ai-btn-new" title="Nouvelle conversation">↺</button>
        <button class="ai-icon-btn" id="ai-btn-history" title="Historique">⏱</button>
        <button class="ai-icon-btn" id="ai-btn-fullscreen" title="Agrandir">⤢</button>
        <button class="ai-icon-btn close" id="ai-btn-close" title="Fermer">×</button>
      </div>
    </header>

    <div id="ai-history-panel"></div>

    <div id="ai-content">
      <div id="ai-welcome">
        <div class="ai-welcome-mark">C</div>
        <div class="ai-welcome-title" id="ai-welcome-title">Bonjour</div>
        <div class="ai-welcome-sub">Comment puis-je t'aider aujourd'hui ? Pose-moi une question sur tes ventes, stocks, budgets ou marques.</div>
        <div id="ai-suggestions"></div>
      </div>
    </div>

    <div id="ai-input-wrap">
      <div id="ai-input-inner">
        <button class="ai-input-btn ai-attach-btn" title="Attacher (bientôt)" disabled>+</button>
        <textarea id="ai-input" placeholder="Écris ta question…" rows="1"></textarea>
        <button class="ai-input-btn ai-send-btn" id="ai-send" title="Envoyer">↑</button>
      </div>
    </div>
  </aside>

  <button id="ai-chat-btn" title="Cortex — Assistant IA">
    <img src="/ai-logo.png" alt="Cortex" onerror="this.style.display='none';this.parentNode.innerHTML='<span style=\\'font-size:24px;color:white;font-weight:700\\'>C</span>'">
  </button>
  `;

  // ── Boot ────────────────────────────────────────────────────────────────
  async function boot() {
    if (typeof window.marked === 'undefined') {
      try { await ensureScript('https://cdn.jsdelivr.net/npm/marked/marked.min.js'); }
      catch (e) { console.warn('[cortex-panel] marked failed', e); }
    }

    const styleEl = document.createElement('style');
    styleEl.id = 'ai-panel-style';
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    const container = document.createElement('div');
    container.id = 'ai-panel-root';
    container.innerHTML = html;
    document.body.appendChild(container);

    wire();
  }

  function wire() {
    const panel      = document.getElementById('ai-panel');
    const overlay    = document.getElementById('ai-overlay');
    const btn        = document.getElementById('ai-chat-btn');
    const btnClose   = document.getElementById('ai-btn-close');
    const btnNew     = document.getElementById('ai-btn-new');
    const btnHist    = document.getElementById('ai-btn-history');
    const btnFull    = document.getElementById('ai-btn-fullscreen');
    const content    = document.getElementById('ai-content');
    const welcome    = document.getElementById('ai-welcome');
    const welcomeTitle = document.getElementById('ai-welcome-title');
    const suggestBox = document.getElementById('ai-suggestions');
    const histPanel  = document.getElementById('ai-history-panel');
    const input      = document.getElementById('ai-input');
    const sendBtn    = document.getElementById('ai-send');

    let history        = [];
    let lastUserMessage = null;
    let opened         = false;

    // Personalize welcome title
    const firstName = getUserFirstName();
    if (welcomeTitle) welcomeTitle.textContent = firstName ? `Bonjour ${firstName}` : 'Bonjour';

    // Render suggestion chips
    function renderSuggestions() {
      const items = buildSuggestions(pageContext);
      suggestBox.innerHTML = '';
      items.forEach(text => {
        const b = document.createElement('button');
        b.className = 'ai-suggestion';
        b.textContent = text;
        b.addEventListener('click', () => { input.value = text; sendMessage(); });
        suggestBox.appendChild(b);
      });
    }
    renderSuggestions();

    // Watch tab changes on index.html (v2 preview only)
    if (pageContext.page === 'index') {
      document.querySelectorAll('.tab').forEach(tab => {
        new MutationObserver(() => {
          if (tab.classList && tab.classList.contains('tab-active') && tab.dataset && tab.dataset.tab !== pageContext.tab) {
            pageContext.tab = tab.dataset.tab;
            renderSuggestions();
          }
        }).observe(tab, { attributes: true, attributeFilter: ['class'] });
      });
    }

    function openPanel() {
      if (opened) return;
      opened = true;
      overlay.classList.add('open');
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
      document.body.classList.add('ai-panel-open');
      setTimeout(() => input.focus(), 250);
    }
    function closePanel() {
      opened = false;
      overlay.classList.remove('open');
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      histPanel.classList.remove('open');
      document.body.classList.remove('ai-panel-open');
      document.body.classList.remove('ai-panel-wide');
      panel.classList.remove('wide');
      btnFull.textContent = '⤢';
    }
    function toggleFull() {
      const wide = panel.classList.toggle('wide');
      document.body.classList.toggle('ai-panel-wide', wide);
      btnFull.textContent = wide ? '⤡' : '⤢';
    }
    function resetConv() {
      history = [];
      lastUserMessage = null;
      // Remove all message bubbles
      content.querySelectorAll('.ai-msg').forEach(el => el.remove());
      // Show welcome again
      welcome.style.display = '';
    }

    btn.addEventListener('click', openPanel);
    btnClose.addEventListener('click', closePanel);
    overlay.addEventListener('click', closePanel);
    btnNew.addEventListener('click', resetConv);
    btnFull.addEventListener('click', toggleFull);

    // Keyboard: Esc to close
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && opened) closePanel();
    });

    // History panel
    btnHist.addEventListener('click', async () => {
      const isOpen = histPanel.classList.toggle('open');
      if (!isOpen) return;
      histPanel.innerHTML = '<span style="font-size:11px;color:#a89f92;padding:4px 8px">Chargement…</span>';
      try {
        const convs = await apiFetch('/api/conversations?limit=20').then(r => r.json());
        if (!convs.length) { histPanel.innerHTML = '<span style="font-size:11px;color:#a89f92;padding:4px 8px">Aucune conversation sauvegardée.</span>'; return; }
        histPanel.innerHTML = '';
        convs.forEach(c => {
          const d = new Date(c.created_at);
          const dateStr = d.toLocaleDateString('fr-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          const item = document.createElement('div');
          item.className = 'history-item';
          item.innerHTML = '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(c.preview || '(sans titre)') + '</span><span class="hist-date">' + dateStr + '</span>';
          item.addEventListener('click', async () => {
            const full = await apiFetch('/api/conversations/' + c.id).then(r => r.json());
            history = full.messages ?? [];
            resetConv();
            welcome.style.display = 'none';
            history.filter(m => m.role === 'user' || m.role === 'assistant').forEach(m => {
              if (m.role === 'user' || (m.role === 'assistant' && m.content)) appendMsg(m.role, m.content);
            });
            histPanel.classList.remove('open');
          });
          histPanel.appendChild(item);
        });
      } catch { histPanel.innerHTML = '<span style="font-size:11px;color:#dc2626;padding:4px 8px">Erreur de chargement.</span>'; }
    });

    // ── Rendering helpers ────────────────────────────────────────────────
    function renderMarkdown(text) {
      if (typeof window.marked === 'undefined') return escapeHtml(text).replace(/\n/g, '<br>');
      const html = window.marked.parse(text);
      return html.replace(/<table(\s|>)/g, '<div class="tbl-wrap"><table$1').replace(/<\/table>/g, '</table></div>');
    }
    function applyMarkdown(div, text) {
      div.innerHTML = renderMarkdown(text);
      if (div.querySelector('table')) div.classList.add('has-table');
      else div.classList.remove('has-table');
    }
    function appendMsg(role, text) {
      welcome.style.display = 'none';
      const div = document.createElement('div');
      div.className = 'ai-msg ' + role;
      if (role === 'assistant') applyMarkdown(div, text);
      else div.textContent = text;
      content.appendChild(div);
      content.scrollTop = content.scrollHeight;
      return div;
    }
    function appendError(msg) {
      const div = document.createElement('div');
      div.className = 'ai-msg error';
      const friendly = friendlyError(msg);
      div.innerHTML = '<strong>Erreur</strong> — ' + escapeHtml(friendly) + '<br><span class="retry-btn">↺ Réessayer</span>';
      div.querySelector('.retry-btn').addEventListener('click', () => {
        content.removeChild(div);
        if (lastUserMessage) { input.value = lastUserMessage; sendMessage(); }
      });
      content.appendChild(div);
      content.scrollTop = content.scrollHeight;
    }
    function friendlyError(msg) {
      if (!msg) return 'Erreur inconnue.';
      if (msg.indexOf('401') !== -1 || msg.indexOf('403') !== -1) return 'Session expirée — reconnecte-toi.';
      if (msg.indexOf('429') !== -1) return 'Trop de requêtes. Attends quelques secondes.';
      if (msg.indexOf('500') !== -1 || msg.indexOf('502') !== -1 || msg.indexOf('503') !== -1) return 'Serveur temporairement indisponible.';
      if (msg.indexOf('Failed to fetch') !== -1) return 'Connexion perdue.';
      return msg.length > 120 ? msg.slice(0, 120) + '…' : msg;
    }

    // ── Send message ─────────────────────────────────────────────────────
    async function sendMessage() {
      const text = input.value.trim();
      if (!text || sendBtn.disabled) return;
      input.value = '';
      input.style.height = '24px';
      sendBtn.disabled = true;
      lastUserMessage = text;

      appendMsg('user', text);
      history.push({ role: 'user', content: text });

      const thinking = appendMsg('thinking', 'Analyse en cours');
      let assistantDiv = null;
      let fullText = '';
      function removeThinking() { if (thinking.parentNode === content) content.removeChild(thinking); }

      try {
        const res = await apiFetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
          body: JSON.stringify({ messages: history, pageContext }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || 'Erreur ' + res.status);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (line.indexOf('data: ') !== 0) continue;
            let event;
            try { event = JSON.parse(line.slice(6)); } catch { continue; }
            if (event.type === 'tool_call') {
              thinking.textContent = (event.label || 'Analyse') + '…';
            } else if (event.type === 'token') {
              removeThinking();
              if (!assistantDiv) {
                assistantDiv = document.createElement('div');
                assistantDiv.className = 'ai-msg assistant';
                content.appendChild(assistantDiv);
              }
              fullText += event.text;
              applyMarkdown(assistantDiv, fullText);
              content.scrollTop = content.scrollHeight;
            } else if (event.type === 'error') {
              removeThinking();
              if (history.length && history[history.length - 1].role === 'user') history.pop();
              appendError(event.message || 'Erreur serveur.');
            } else if (event.type === 'done') {
              history = event.messages ?? history;
            }
          }
        }
        removeThinking();
        if (!assistantDiv) {
          if (history.length && history[history.length - 1].role === 'user') history.pop();
          appendError('Aucune réponse reçue.');
        }
      } catch (e) {
        removeThinking();
        if (history.length && history[history.length - 1].role === 'user') history.pop();
        appendError(e.message);
      }
      sendBtn.disabled = false;
      input.focus();
    }

    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    input.addEventListener('input', () => {
      input.style.height = '24px';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

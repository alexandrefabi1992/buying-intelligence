/**
 * Cortex chatbot widget — self-contained, drop-in on any page.
 *
 * Injects its own CSS, HTML, and event wiring. Loads `marked` from CDN if not
 * already present. Reads JWT from localStorage (key `auth_token`) for API auth.
 *
 * Usage:
 *   <script src="/chatbot-widget.js"></script>   (place before </body>)
 *
 * Idempotent: multiple loads are no-op.
 */
(function () {
  if (window.__cortexChatbotInstalled) return;
  window.__cortexChatbotInstalled = true;

  // ── Page context detection ───────────────────────────────────────────────
  // Parse location.pathname to determine which entity the user is looking at.
  // Sent along with each /api/ai/chat request as pageContext so the LLM can
  // resolve implicit references ("quel est le stock ?" → apply current brand).
  function detectPageContext() {
    const p = location.pathname;
    let m;
    if ((m = p.match(/^\/brand\/([^\/]+)/i))) {
      return { page: 'brand', manufacturer: decodeURIComponent(m[1]) };
    }
    if ((m = p.match(/^\/matrix\/([^\/]+)/i))) {
      return { page: 'matrix', matrix_id: decodeURIComponent(m[1]) };
    }
    if (/^\/velocity(\.html)?$/i.test(p)) {
      return { page: 'velocity' };
    }
    return { page: 'index' };
  }

  // ── Suggested questions per page ─────────────────────────────────────────
  // Interpolates {manufacturer} where relevant. Chips are populated at wire
  // time and re-rendered when the user clicks "Nouveau" (clear).
  function buildSuggestions(ctx) {
    if (ctx.page === 'brand' && ctx.manufacturer) {
      const m = ctx.manufacturer;
      return [
        `Quel est le ST% de ${m} cette saison ?`,
        `Compare ${m} sur les 3 dernières saisons`,
        `Quel budget recommandé pour ${m} ?`,
        `Y a-t-il du stock dormant de ${m} à transférer ?`,
      ];
    }
    if (ctx.page === 'matrix') {
      return [
        'Quelles tailles restent en stock ?',
        'Quel est le sell-through par taille ?',
      ];
    }
    if (ctx.page === 'velocity') {
      return [
        'Quelles marques ont la meilleure vélocité ?',
        'Quels articles risquent la rupture de stock ?',
      ];
    }
    // index / default
    return [
      'Quelles sont les meilleures marques par ST cette saison ?',
      'Quoi transférer entre boutiques en ce moment ?',
    ];
  }

  const pageContext = detectPageContext();

  // ── Utility: dynamic <script> loader with de-dup ─────────────────────────
  function ensureScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some(s => s.src === src)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  // ── Auth helper (self-contained) ─────────────────────────────────────────
  async function apiFetch(url, options = {}) {
    const token = localStorage.getItem('auth_token');
    const headers = { ...(options.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      // Not redirecting here — the host page's own auth check will handle it.
      // We still return the response so the caller can decide.
    }
    return res;
  }

  // ── CSS injection ────────────────────────────────────────────────────────
  const css = `
  #ai-chat-panel {
    position: fixed; bottom: 80px; right: 20px; width: 460px; height: 640px;
    background: #fff; border: 1px solid #e2e8f0; border-radius: 16px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.15); display: flex; flex-direction: column;
    z-index: 1000; transform: scale(0.95) translateY(8px); opacity: 0;
    transition: transform 0.2s ease, opacity 0.2s ease, width 0.2s ease, height 0.2s ease; pointer-events: none;
  }
  #ai-chat-panel.wide { width: 720px; height: 80vh; }
  @media (max-width: 520px) {
    #ai-chat-panel { width: calc(100vw - 16px); right: 8px; bottom: 78px; height: 75vh; }
    #ai-chat-panel.wide { width: calc(100vw - 16px); }
    #ai-expand-btn { display: none; }
  }
  #ai-chat-panel.open { transform: scale(1) translateY(0); opacity: 1; pointer-events: all; }
  #ai-chat-btn {
    position: fixed; bottom: 20px; right: 20px; width: 86px; height: 86px;
    background: none; border-radius: 0; border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    box-shadow: none; z-index: 1001;
    transition: transform 0.15s ease;
    padding: 0;
  }
  #ai-chat-btn img { width: 86px; height: 86px; object-fit: contain; display: block; }
  #ai-chat-btn:hover { transform: scale(1.08); }
  #ai-messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .ai-msg { max-width: 88%; padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.6; word-break: break-word; }
  .ai-msg.user { background: #4f46e5; color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
  .ai-msg.assistant { background: #f1f5f9; color: #1e293b; align-self: flex-start; border-bottom-left-radius: 4px; }
  .ai-msg.assistant p { margin: 0 0 6px; }
  .ai-msg.assistant p:last-child { margin-bottom: 0; }
  .ai-msg.assistant ul, .ai-msg.assistant ol { margin: 4px 0 6px 16px; padding: 0; }
  .ai-msg.assistant li { margin-bottom: 2px; }
  .ai-msg.assistant strong { font-weight: 600; }
  .ai-msg.assistant .tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 6px 0; }
  .ai-msg.assistant table { border-collapse: collapse; font-size: 12px; width: max-content; min-width: 100%; }
  .ai-msg.assistant th, .ai-msg.assistant td { border: 1px solid #cbd5e1; padding: 4px 8px; text-align: left; white-space: nowrap; word-break: normal; }
  .ai-msg.assistant th { background: #e2e8f0; font-weight: 600; }
  .ai-msg.assistant tr:nth-child(even) td { background: #f8fafc; }
  .ai-msg.has-table { max-width: 96%; }
  .ai-msg.assistant h1, .ai-msg.assistant h2, .ai-msg.assistant h3 { font-weight: 600; margin: 6px 0 4px; font-size: 14px; }
  .ai-msg.thinking { background: #f8fafc; color: #94a3b8; align-self: flex-start; font-style: italic; font-size: 12px; display: flex; align-items: center; gap: 8px; }
  .ai-msg.thinking::before { content: ''; display: inline-block; width: 10px; height: 10px; border: 2px solid #cbd5e1; border-top-color: #6366f1; border-radius: 50%; animation: cortex-spin 0.7s linear infinite; flex-shrink: 0; }
  @keyframes cortex-spin { to { transform: rotate(360deg); } }
  .ai-msg.error { background: #fef2f2; color: #991b1b; align-self: flex-start; border-bottom-left-radius: 4px; border: 1px solid #fecaca; }
  .ai-msg.error .retry-btn { display: inline-block; margin-top: 6px; font-size: 11px; font-weight: 600; color: #dc2626; cursor: pointer; text-decoration: underline; }
  .ai-msg.error .retry-btn:hover { color: #991b1b; }
  #ai-input-row { padding: 10px 12px; border-top: 1px solid #f1f5f9; display: flex; gap: 8px; align-items: flex-end; }
  #ai-input { flex: 1; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 12px;
    font-size: 13px; outline: none; resize: none; height: 40px; max-height: 120px; font-family: inherit; line-height: 1.5; }
  #ai-input:focus { border-color: #a5b4fc; }
  #ai-send { background: #4f46e5; color: #fff; border: none; border-radius: 10px;
    padding: 0 16px; height: 40px; cursor: pointer; font-size: 13px; font-weight: 600; transition: background 0.1s; flex-shrink: 0; }
  #ai-send:hover { background: #4338ca; }
  #ai-send:disabled { background: #c7d2fe; cursor: default; }
  #ai-history-btn { font-size: 10px; color: #94a3b8; cursor: pointer; padding: 2px 6px; border-radius: 6px; border: 1px solid #e2e8f0; background: white; }
  #ai-history-btn:hover { background: #f8fafc; color: #475569; }
  #ai-history-panel { display: none; flex-direction: column; gap: 2px; padding: 8px 12px; max-height: 180px; overflow-y: auto; border-bottom: 1px solid #f1f5f9; }
  #ai-history-panel.open { display: flex; }
  .history-item { font-size: 11px; padding: 6px 8px; border-radius: 8px; cursor: pointer; color: #374151; display: flex; justify-content: space-between; align-items: center; }
  .history-item:hover { background: #f8fafc; }
  .history-item .hist-date { font-size: 10px; color: #94a3b8; flex-shrink: 0; margin-left: 8px; }
  #ai-suggestions { padding: 0 14px 10px; display: flex; flex-wrap: wrap; gap: 7px; }
  #ai-suggestions.cortex-hidden { display: none; }
  .ai-suggestion { font-size: 12px; color: #4f46e5; background: #eef2ff; border: 1px solid #c7d2fe;
    border-radius: 20px; padding: 5px 12px; cursor: pointer; white-space: nowrap;
    transition: background 0.1s, border-color 0.1s; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .ai-suggestion:hover { background: #e0e7ff; border-color: #a5b4fc; }
  /* Header helpers when Tailwind isn't loaded on the host page */
  #ai-chat-panel .cortex-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #f1f5f9; }
  #ai-chat-panel .cortex-header-left { display: flex; align-items: center; gap: 8px; }
  #ai-chat-panel .cortex-header-right { display: flex; align-items: center; gap: 8px; }
  #ai-chat-panel .cortex-dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; }
  #ai-chat-panel .cortex-title { font-size: 12px; font-weight: 600; color: #374151; }
  #ai-chat-panel .cortex-badge { font-size: 10px; color: #9ca3af; background: #f3f4f6; padding: 2px 6px; border-radius: 999px; }
  #ai-chat-panel .cortex-icon-btn { font-size: 10px; color: #9ca3af; background: transparent; border: none; cursor: pointer; padding: 4px; }
  #ai-chat-panel .cortex-icon-btn:hover { color: #4b5563; }
  #ai-chat-panel .cortex-close { font-size: 18px; line-height: 1; color: #9ca3af; background: transparent; border: none; cursor: pointer; padding: 0 4px; }
  #ai-chat-panel .cortex-close:hover { color: #4b5563; }
  `;
  const styleEl = document.createElement('style');
  styleEl.id = 'ai-chat-widget-style';
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── HTML injection ───────────────────────────────────────────────────────
  const html = `
  <button id="ai-chat-btn" title="Cortex — Assistant IA">
    <img src="/ai-logo.png" alt="Cortex">
  </button>

  <div id="ai-chat-panel">
    <div class="cortex-header">
      <div class="cortex-header-left">
        <div class="cortex-dot"></div>
        <span class="cortex-title">Cortex</span>
        <span class="cortex-badge" id="ai-provider-badge">IA</span>
      </div>
      <div class="cortex-header-right">
        <button id="ai-history-btn">⏱ Historique</button>
        <button id="ai-expand-btn" class="cortex-icon-btn" title="Agrandir le panneau">⤢</button>
        <button id="ai-clear" class="cortex-icon-btn" title="Nouvelle conversation">↺ Nouveau</button>
        <button id="ai-close" class="cortex-close">×</button>
      </div>
    </div>

    <div id="ai-history-panel"></div>

    <div id="ai-messages">
      <div class="ai-msg assistant">Bonjour ! Je suis Cortex, votre assistant achat. Posez-moi des questions sur vos budgets, ventes, stocks ou sell-through.</div>
    </div>

    <div id="ai-suggestions"></div>

    <div id="ai-input-row">
      <textarea id="ai-input" placeholder="Posez une question…" rows="1"></textarea>
      <button id="ai-send">Envoyer</button>
    </div>
  </div>
  `;

  // Boot after DOM is ready + marked is available
  async function boot() {
    // Ensure marked (Markdown parser)
    if (typeof window.marked === 'undefined') {
      try { await ensureScript('https://cdn.jsdelivr.net/npm/marked/marked.min.js'); }
      catch (e) { console.warn('[cortex] marked failed to load — rendering as plain text', e); }
    }

    const container = document.createElement('div');
    container.id = 'ai-chat-widget-root';
    container.innerHTML = html;
    document.body.appendChild(container);

    wire();
  }

  // ── Wiring — mirrors the original inline logic ───────────────────────────
  function wire() {
    const panel      = document.getElementById('ai-chat-panel');
    const btn        = document.getElementById('ai-chat-btn');
    const closeBtn   = document.getElementById('ai-close');
    const clearBtn   = document.getElementById('ai-clear');
    const histBtn    = document.getElementById('ai-history-btn');
    const histPanel  = document.getElementById('ai-history-panel');
    const input      = document.getElementById('ai-input');
    const sendBtn    = document.getElementById('ai-send');
    const msgs       = document.getElementById('ai-messages');
    const badge      = document.getElementById('ai-provider-badge');
    const suggestBox = document.getElementById('ai-suggestions');

    let history         = [];
    let open            = false;
    let lastUserMessage = null;

    function renderSuggestions() {
      const items = buildSuggestions(pageContext);
      suggestBox.innerHTML = '';
      items.forEach(text => {
        const b = document.createElement('button');
        b.className = 'ai-suggestion';
        b.textContent = text;
        b.addEventListener('click', () => {
          input.value = text;
          hideSuggestions();
          sendMessage();
        });
        suggestBox.appendChild(b);
      });
    }

    function showSuggestions() { suggestBox.classList.remove('cortex-hidden'); }
    function hideSuggestions() { suggestBox.classList.add('cortex-hidden'); }

    renderSuggestions();

    histBtn.addEventListener('click', async () => {
      const isOpen = histPanel.classList.toggle('open');
      if (!isOpen) return;
      histPanel.innerHTML = '<span style="font-size:11px;color:#94a3b8;padding:4px 8px">Chargement…</span>';
      try {
        const convs = await apiFetch('/api/conversations?limit=20').then(r => r.json());
        if (!convs.length) { histPanel.innerHTML = '<span style="font-size:11px;color:#94a3b8;padding:4px 8px">Aucune conversation sauvegardée.</span>'; return; }
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
            msgs.innerHTML = '';
            appendMsg('assistant', 'Bonjour ! Je suis votre assistant achat. Posez-moi des questions sur vos budgets, ventes, stocks ou sell-through.');
            history.filter(m => m.role === 'user' || m.role === 'assistant').forEach(m => {
              if (m.role === 'user' || (m.role === 'assistant' && m.content)) appendMsg(m.role, m.content);
            });
            histPanel.classList.remove('open');
          });
          histPanel.appendChild(item);
        });
      } catch { histPanel.innerHTML = '<span style="font-size:11px;color:#ef4444;padding:4px 8px">Erreur de chargement.</span>'; }
    });

    // Provider ping (badge indicator)
    apiFetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }) })
      .then(r => r.json()).then(d => {
        if (d.error && d.error.indexOf('non configuré') !== -1) badge.textContent = '⚠ Non configuré';
      }).catch(() => {});

    function togglePanel() {
      open = !open;
      panel.classList.toggle('open', open);
      if (open) setTimeout(() => input.focus(), 200);
    }

    btn.addEventListener('click', togglePanel);
    closeBtn.addEventListener('click', () => { open = false; panel.classList.remove('open'); });

    const expandBtn = document.getElementById('ai-expand-btn');
    expandBtn.addEventListener('click', () => {
      const wide = panel.classList.toggle('wide');
      expandBtn.textContent = wide ? '⤡' : '⤢';
      expandBtn.title = wide ? 'Réduire le panneau' : 'Agrandir le panneau';
    });

    clearBtn.addEventListener('click', () => {
      history = [];
      lastUserMessage = null;
      msgs.innerHTML = '';
      appendMsg('assistant', 'Conversation réinitialisée. Comment puis-je vous aider ?');
      renderSuggestions();
      showSuggestions();
    });

    function renderMarkdown(content) {
      if (typeof window.marked === 'undefined') return escapeHtml(content).replace(/\n/g, '<br>');
      const html = window.marked.parse(content);
      return html.replace(/<table(\s|>)/g, '<div class="tbl-wrap"><table$1').replace(/<\/table>/g, '</table></div>');
    }

    function applyMarkdown(div, content) {
      div.innerHTML = renderMarkdown(content);
      if (div.querySelector('table')) div.classList.add('has-table');
      else div.classList.remove('has-table');
    }

    function appendMsg(role, content) {
      const div = document.createElement('div');
      div.className = 'ai-msg ' + role;
      if (role === 'assistant') applyMarkdown(div, content);
      else div.textContent = content;
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
      return div;
    }

    async function sendMessage() {
      const text = input.value.trim();
      if (!text || sendBtn.disabled) return;
      input.value = '';
      input.style.height = '40px';
      sendBtn.disabled = true;
      lastUserMessage = text;
      hideSuggestions();
      appendMsg('user', text);
      history.push({ role: 'user', content: text });
      const thinking = appendMsg('thinking', 'Analyse en cours');
      let assistantDiv = null;
      let fullText = '';
      function removeThinking() { if (thinking.parentNode === msgs) msgs.removeChild(thinking); }
      try {
        const res = await apiFetch('/api/ai/chat', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
          body:    JSON.stringify({ messages: history, pageContext }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || 'Erreur ' + res.status);
        }
        const reader  = res.body.getReader();
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
              thinking.textContent = event.label + '…';
            } else if (event.type === 'token') {
              removeThinking();
              if (!assistantDiv) {
                assistantDiv = document.createElement('div');
                assistantDiv.className = 'ai-msg assistant';
                msgs.appendChild(assistantDiv);
              }
              fullText += event.text;
              applyMarkdown(assistantDiv, fullText);
              msgs.scrollTop = msgs.scrollHeight;
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
          appendError('Aucune réponse reçue. Le modèle n’a pas pu générer de texte.');
        }
      } catch (e) {
        removeThinking();
        if (history.length && history[history.length - 1].role === 'user') history.pop();
        appendError(e.message);
      }
      sendBtn.disabled = false;
      input.focus();
    }

    function appendError(message) {
      const div = document.createElement('div');
      div.className = 'ai-msg error';
      const friendly = friendlyError(message);
      div.innerHTML = '<strong>Erreur</strong> — ' + escapeHtml(friendly) + '<br><span class="retry-btn">↺ Réessayer</span>';
      div.querySelector('.retry-btn').addEventListener('click', () => {
        msgs.removeChild(div);
        if (lastUserMessage) { input.value = lastUserMessage; sendMessage(); }
      });
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
    }

    function friendlyError(msg) {
      if (!msg) return 'Erreur inconnue.';
      if (msg.indexOf('401') !== -1 || msg.indexOf('403') !== -1) return 'Session expirée — veuillez vous reconnecter.';
      if (msg.indexOf('429') !== -1) return 'Trop de requêtes. Attendez quelques secondes et réessayez.';
      if (msg.indexOf('500') !== -1 || msg.indexOf('502') !== -1 || msg.indexOf('503') !== -1) return 'Le serveur est temporairement indisponible.';
      if (msg.indexOf('Failed to fetch') !== -1 || msg.indexOf('NetworkError') !== -1 || msg.indexOf('network') !== -1) return 'Connexion perdue. Vérifiez votre réseau.';
      if (msg.indexOf('timeout') !== -1 || msg.indexOf('AbortError') !== -1) return 'La requête a pris trop de temps. Réessayez.';
      return msg.length > 120 ? msg.slice(0, 120) + '…' : msg;
    }

    function escapeHtml(str) {
      return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    input.addEventListener('input', () => {
      input.style.height = '40px';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

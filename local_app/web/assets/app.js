const $ = (sel) => document.querySelector(sel);

// -------------------------
// Sessions (client-side)
// -------------------------
const SESSIONS_KEY = "rag_local_sessions_v1";
let currentSessionId = null;
let sessionDirty = false;
let suppressDirty = false;

function loadSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    const data = raw ? JSON.parse(raw) : null;
    if (!data || !Array.isArray(data.sessions)) return { current: null, sessions: [] };
    return { current: data.current || null, sessions: data.sessions };
  } catch (e) {
    return { current: null, sessions: [] };
  }
}

function saveSessions(current, sessions) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify({ current, sessions }));
}

function newId() {
  return `s_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function formatTs(ts) {
  try {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (e) {
    return "—";
  }
}

function getSessionFromDom() {
  const nodes = Array.from(document.querySelectorAll("#chat .msg"));
  const messages = [];
  for (const n of nodes) {
    if (n.dataset.complete !== "1") continue;
    const role = n.classList.contains("user") ? "user" : "assistant";
    const content = n.dataset.raw ?? (n.textContent ?? "");
    const meta = n.querySelector(".metaLine")?.textContent ?? "";
    messages.push({ role, content, meta });
  }
  return messages;
}

function deriveTitle(messages) {
  const firstUser = messages.find((m) => m.role === "user" && String(m.content || "").trim());
  const base = firstUser ? String(firstUser.content).trim() : "新对话";
  return base.length > 18 ? base.slice(0, 18) + "…" : base;
}

function getCurrentSessionRecord() {
  const { sessions } = loadSessions();
  return sessions.find((s) => s.id === currentSessionId) || null;
}

function setHeaderTitle(title) {
  const el = $("#chatTitle");
  if (el) el.textContent = title || "对话";
}

function persistCurrentSession() {
  if (!currentSessionId) return;
  if (!sessionDirty) return;
  const messages = getSessionFromDom();
  const { sessions } = loadSessions();
  const now = Date.now();
  const existing = sessions.find((s) => s.id === currentSessionId);
  const autoTitle = deriveTitle(messages);
  const title = existing?.titleManual ? (existing.title || autoTitle) : autoTitle;
  const session = {
    id: currentSessionId,
    title,
    titleManual: !!existing?.titleManual,
    createdAt: sessions.find((s) => s.id === currentSessionId)?.createdAt || now,
    updatedAt: now,
    messages,
  };
  const next = [...sessions];
  const idx = next.findIndex((s) => s.id === currentSessionId);
  if (idx >= 0) next[idx] = session;
  else next.unshift(session);
  saveSessions(currentSessionId, next.slice(0, 50));
  renderSessionList();
  setHeaderTitle(session.title);
  sessionDirty = false;
}

function renderSessionList() {
  const box = $("#sessionList");
  if (!box) return;
  const { sessions } = loadSessions();
  if (!sessions.length) {
    box.innerHTML = `<div class="docHint">暂无历史会话</div>`;
    return;
  }
  box.innerHTML = "";
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "sessionItem" + (s.id === currentSessionId ? " active" : "");
    item.dataset.id = s.id;
    const count = Array.isArray(s.messages) ? s.messages.length : 0;
    item.innerHTML = `
      <div class="sessionMeta">
        <div class="sessionTitle">${escapeHtml(String(s.title || "未命名"))}</div>
        <div class="sessionSub">${escapeHtml(formatTs(s.updatedAt || s.createdAt || Date.now()))}</div>
      </div>
      <div class="sessionRight">
        <div class="sessionCount">${escapeHtml(String(count))}</div>
        <button class="iconBtn danger" title="删除" aria-label="删除">✕</button>
      </div>
    `;
    item.addEventListener("click", () => switchToSession(s.id));
    const delBtn = item.querySelector(".iconBtn.danger");
    delBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteSession(s.id);
    });
    box.appendChild(item);
  }
}

function loadSessionToDom(session) {
  $("#chat").innerHTML = "";
  setSources([], null);
  const msgs = Array.isArray(session.messages) ? session.messages : [];
  suppressDirty = true;
  for (const m of msgs) {
    const el = addMessage(m.role === "user" ? "user" : "assistant", m.content || "", m.meta || "");
    if (m.role === "assistant") renderAssistantMarkdown(el);
  }
  suppressDirty = false;
  sessionDirty = false;
  if (msgs.length === 0) showWelcome();
  setHeaderTitle(String(session.title || "对话"));
}

function switchToSession(id) {
  if (busy) stopCurrent();
  persistCurrentSession();
  const { sessions } = loadSessions();
  const target = sessions.find((s) => s.id === id);
  if (!target) return;
  currentSessionId = id;
  saveSessions(currentSessionId, sessions);
  renderSessionList();
  loadSessionToDom(target);
}

function startNewSession() {
  if (busy) stopCurrent();
  persistCurrentSession();
  currentSessionId = newId();
  const { sessions } = loadSessions();
  saveSessions(currentSessionId, sessions);
  renderSessionList();
  $("#chat").innerHTML = "";
  setSources([], null);
  showWelcome();
  sessionDirty = true;
  persistCurrentSession();
}

function deleteSession(id) {
  const data = loadSessions();
  const sessions = data.sessions || [];
  const target = sessions.find((s) => s.id === id);
  if (!target) return;
  const ok = window.confirm(`删除会话「${target.title || "未命名"}」？此操作不可撤销。`);
  if (!ok) return;

  const next = sessions.filter((s) => s.id !== id);
  let nextCurrent = data.current;
  if (id === currentSessionId) {
    nextCurrent = next[0]?.id || null;
    currentSessionId = nextCurrent;
  }
  saveSessions(nextCurrent, next);
  renderSessionList();
  if (!currentSessionId) {
    startNewSession();
    return;
  }
  const cur = next.find((s) => s.id === currentSessionId);
  if (cur) loadSessionToDom(cur);
}

function renameCurrentSession() {
  if (!currentSessionId) return;
  persistCurrentSession();
  const cur = getCurrentSessionRecord();
  const modal = $("#renameModal");
  const input = $("#renameInput");
  if (!modal || !input) return;
  input.value = String(cur?.title || "对话");
  modal.classList.remove("hidden");
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

function closeRenameModal() {
  const modal = $("#renameModal");
  if (modal) modal.classList.add("hidden");
}

function saveRenameModal() {
  if (!currentSessionId) return;
  const input = $("#renameInput");
  if (!input) return;
  const t = String(input.value || "").trim();
  if (!t) return;
  const data = loadSessions();
  const sessions = data.sessions || [];
  const idx = sessions.findIndex((s) => s.id === currentSessionId);
  if (idx < 0) return;
  const cur = sessions[idx];
  sessions[idx] = { ...cur, title: t, titleManual: true, updatedAt: Date.now() };
  saveSessions(currentSessionId, sessions);
  renderSessionList();
  setHeaderTitle(t);
  closeRenameModal();
}

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function safeUrl(url) {
  const u = String(url || "").trim();
  if (!u) return "#";
  const low = u.toLowerCase();
  if (low.startsWith("javascript:") || low.startsWith("data:")) return "#";
  return u;
}

function renderMarkdownSafe(md) {
  // Lightweight markdown renderer (safe-by-default): ignores raw HTML input.
  // Supports: fenced code blocks, inline code, bold/italic, links, headings, lists, paragraphs.
  const raw = String(md ?? "").replaceAll("\r\n", "\n");

  const codeBlocks = [];
  const withPlaceholders = raw.replace(/```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return `@@CODE_BLOCK_${idx}@@`;
  });

  // Escape everything first
  let text = escapeHtml(withPlaceholders);

  // Inline code
  text = text.replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`);
  // Bold and italic (simple)
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  // Links: [text](url)
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, t, u) => {
    const href = escapeHtml(safeUrl(u));
    const label = t;
    return `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });

  // Block-level rendering (headings, lists, paragraphs)
  const lines = text.split("\n");
  let out = "";
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) { out += "</ul>"; inUl = false; }
    if (inOl) { out += "</ol>"; inOl = false; }
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // restore code blocks as block HTML (on their own line)
    const codeMatch = line.match(/^@@CODE_BLOCK_(\d+)@@$/);
    if (codeMatch) {
      closeLists();
      out += codeBlocks[Number(codeMatch[1])] || "";
      continue;
    }

    if (!line.trim()) {
      closeLists();
      continue;
    }

    const h3 = line.match(/^###\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1 || h2 || h3) {
      closeLists();
      const tag = h3 ? "h3" : h2 ? "h2" : "h1";
      const content = (h3 || h2 || h1)[1];
      out += `<${tag}>${content}</${tag}>`;
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul) {
      if (inOl) { out += "</ol>"; inOl = false; }
      if (!inUl) { out += "<ul>"; inUl = true; }
      out += `<li>${ul[1]}</li>`;
      continue;
    }
    if (ol) {
      if (inUl) { out += "</ul>"; inUl = false; }
      if (!inOl) { out += "<ol>"; inOl = true; }
      out += `<li>${ol[1]}</li>`;
      continue;
    }

    closeLists();
    // simple paragraph; keep manual line breaks by converting to <br> when a paragraph spans multiple lines
    // merge subsequent non-empty, non-block lines into one paragraph
    let para = line;
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (!next.trim()) break;
      if (/^(@@CODE_BLOCK_\d+@@)$/.test(next)) break;
      if (/^#{1,3}\s+/.test(next)) break;
      if (/^\s*[-*]\s+/.test(next)) break;
      if (/^\s*\d+\.\s+/.test(next)) break;
      i++;
      para += "<br>" + next;
    }
    out += `<p>${para}</p>`;
  }
  closeLists();

  // Restore code blocks embedded mid-line (rare). Replace any remaining placeholders.
  out = out.replace(/@@CODE_BLOCK_(\d+)@@/g, (_m, idx) => codeBlocks[Number(idx)] || "");
  return out;
}

function nowHHMMSS() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function autosizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

function addMessage(role, text, meta = "") {
  const chat = $("#chat");
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.dataset.complete = "1";
  div.dataset.raw = String(text ?? "");
  div.innerHTML = `<div class="content"></div>${meta ? `<div class="metaLine"></div>` : ""}`;
  const content = div.querySelector(".content");
  content.textContent = String(text ?? "");
  if (meta) {
    div.querySelector(".metaLine").textContent = meta;
  }
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  if (!suppressDirty && currentSessionId) sessionDirty = true;
  return div;
}

function addPendingAssistant() {
  const chat = $("#chat");
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.dataset.complete = "0";
  div.dataset.raw = "";
  div.innerHTML = `<div class="content"><div class="loadingRow"><span class="spinner"></span><span>正在加载…</span></div></div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function setAssistantContent(el, text) {
  el.dataset.raw = String(text ?? "");
  const content = el.querySelector(".content") || el;
  content.textContent = String(text ?? "");
}

function renderAssistantMarkdown(el) {
  const raw = String(el.dataset.raw || "");
  const content = el.querySelector(".content") || el;
  content.innerHTML = renderMarkdownSafe(raw);
  typesetMath(content);
}

function typesetMath(rootEl) {
  try {
    if (window.MathJax && typeof window.MathJax.typesetPromise === "function") {
      window.MathJax.typesetClear?.();
      window.MathJax.typesetPromise([rootEl]).catch(() => {});
    }
  } catch (e) {
    // ignore
  }
}

async function typewriter(el, fullText, { cps = 40, token = null } = {}) {
  // cps: chars per second (roughly). Uses adaptive batching for performance.
  const text = String(fullText ?? "");
  el.dataset.raw = text;
  const content = el.querySelector(".content") || el;
  content.textContent = "";
  const start = performance.now();
  let i = 0;
  while (i < text.length) {
    if (token && token.cancelled) break;
    const elapsed = (performance.now() - start) / 1000;
    const should = Math.floor(elapsed * cps);
    const target = Math.min(text.length, Math.max(i + 1, should));
    if (target > i) {
      content.textContent = text.slice(0, target);
      i = target;
      const chat = $("#chat");
      chat.scrollTop = chat.scrollHeight;
    }
    await new Promise((r) => setTimeout(r, 16));
  }
}

function setSources(sources, context) {
  const wrap = $("#sources");
  const list = $("#sourcesList");
  const ctxBox = $("#contextBox");

  list.innerHTML = "";
  if (!sources || sources.length === 0) {
    wrap.classList.add("hidden");
    return;
  }

  for (const s of sources) {
    const item = document.createElement("div");
    item.className = "sourceItem";
    const page = (s.page_number === 0 || s.page_number === "N/A") ? "—" : `p.${s.page_number}`;
    item.innerHTML = `
      <div class="sourceTop">
        <div class="sourceName">${escapeHtml(String(s.filename || "未知文件"))}</div>
        <div class="sourcePage">${escapeHtml(page)}</div>
      </div>
      <div class="sourceSnippet">${escapeHtml(String(s.snippet || ""))}</div>
    `;
    list.appendChild(item);
  }

  if (context) {
    ctxBox.textContent = context;
    ctxBox.classList.remove("hidden");
  } else {
    ctxBox.textContent = "";
    ctxBox.classList.add("hidden");
  }

  wrap.classList.remove("hidden");
}

function getHistoryFromDom() {
  const nodes = Array.from(document.querySelectorAll("#chat .msg"));
  const history = [];
  for (const n of nodes) {
    if (n.dataset.complete !== "1") continue;
    const role = n.classList.contains("user") ? "user" : "assistant";
    const text = n.dataset.raw ?? (n.textContent ?? "");
    history.push({ role, content: text });
  }
  return history;
}

async function apiJson(path, opts = {}, { timeoutMs = 15000 } = {}) {
  let timer = null;
  let controller = null;
  const hasSignal = !!opts.signal;
  if (!hasSignal) {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
      ...(hasSignal ? {} : { signal: controller.signal }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error ? String(data.error) : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error(`请求超时（${timeoutMs}ms）：${path}`);
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function renderStatus(s) {
  const box = $("#status");
  const rows = [
    ["Model", s.model || "—"],
    ["API Base", s.api_base || "—"],
    ["Embedding", s.embedding_model || "—"],
    ["Data dir", s.data_dir_exists ? "✅" : "❌"],
    ["Vector DB", s.vector_db_exists ? "✅" : "❌"],
    ["Docs", (s.collection_count ?? "—") + (s.collection_count_error ? "（异常）" : "")],
  ];
  box.innerHTML = rows
    .map(([k, v]) => `<div class="row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></div>`)
    .join("");

  const meta = `docs=${s.collection_count ?? "?"} top_k=${s.defaults?.top_k ?? 3}`;
  $("#headerMeta").textContent = meta;

  // defaults
  if (typeof s.defaults?.top_k === "number") $("#topK").value = String(s.defaults.top_k);
}

let polling = null;
async function refreshStatus() {
  const s = await apiJson("/api/status", {}, { timeoutMs: 8000 });
  renderStatus(s);
  return s;
}

async function rebuild(payload = {}) {
  const logBox = $("#rebuildLog");
  logBox.classList.remove("hidden");
  logBox.textContent = `[${nowHHMMSS()}] 请求重建…\n`;
  const r = await apiJson("/api/rebuild", { method: "POST", body: JSON.stringify(payload) }, { timeoutMs: 8000 });
  logBox.textContent += `${r.message}\n`;

  if (polling) clearInterval(polling);
  let failures = 0;
  const progWrap = $("#rebuildProgress");
  const progLabel = $("#progressLabel");
  const progPct = $("#progressPct");
  const progFill = $("#progressFill");
  if (progWrap) progWrap.classList.remove("hidden");
  if (progLabel) progLabel.textContent = "等待后端进度…";
  if (progPct) progPct.textContent = "0%";
  if (progFill) progFill.style.width = "0%";

  const tick = async () => {
    try {
      const rebuild = await apiJson("/api/rebuild/status", {}, { timeoutMs: 5000 });
      const tail = rebuild.logs_tail || [];
      if (tail.length) logBox.textContent = tail.join("\n");
      if (progLabel && progPct && progFill) {
        const stage = rebuild.stage || "处理中";
        const cur = Number(rebuild.current ?? 0);
        const total = Number(rebuild.total ?? 0);
        const pct = Number(rebuild.percent ?? 0);
        progLabel.textContent = total > 0 ? `${stage} · ${cur}/${total}` : `${stage}`;
        progPct.textContent = `${pct}%`;
        progFill.style.width = `${pct}%`;
      }
      failures = 0;

      if (!rebuild.running) {
        clearInterval(polling);
        polling = null;
        // Now refresh full status once to show Docs count (may block briefly but rebuild is finished)
        let docs = "?";
        try {
          const st = await apiJson("/api/status", {}, { timeoutMs: 12000 });
          renderStatus(st);
          docs = st.collection_count ?? "?";
        } catch (e) {
          // ignore
        }
        const ok = !rebuild.last_error;
        logBox.textContent += `\n\n[${nowHHMMSS()}] ${ok ? "✅ 重建成功" : "❌ 重建失败"} · Docs=${docs}`;
        if (progWrap) progWrap.classList.add("hidden");
      }
    } catch (e) {
      failures += 1;
      logBox.textContent += `\n[${nowHHMMSS()}] 轮询失败：${e.message}`;
      if (failures >= 5) {
        clearInterval(polling);
        polling = null;
        logBox.textContent += `\n[${nowHHMMSS()}] 已停止轮询（连续失败过多）`;
        if (progWrap) progWrap.classList.add("hidden");
      }
    }
  };

  // run immediately once (do NOT await) so we never get stuck before interval is set
  tick();
  polling = setInterval(async () => {
    await tick();
  }, 1500);
}

let busy = false;
let currentAbort = null;
let currentToken = null;

function setBusy(isBusy) {
  busy = isBusy;
  const btn = $("#btnAction");
  if (!btn) return;
  if (isBusy) {
    btn.textContent = "打断";
    btn.classList.remove("primary");
    btn.classList.add("danger");
  } else {
    btn.textContent = "发送";
    btn.classList.remove("danger");
    btn.classList.add("primary");
  }
}

function stopCurrent() {
  if (!busy) return;
  if (currentAbort) {
    try { currentAbort.abort(); } catch (e) {}
  }
  if (currentToken) currentToken.cancelled = true;
}

async function send() {
  if (busy) return;
  const input = $("#input");
  const msg = input.value.trim();
  if (!msg) return;

  setBusy(true);

  addMessage("user", msg, `sent ${nowHHMMSS()}`);
  input.value = "";
  autosizeTextarea(input);
  setSources([], null);

  const history = getHistoryFromDom();
  const pending = addPendingAssistant();
  const top_k = Number($("#topK").value || 3);
  const temperature = Number($("#temperature").value || 0.7);
  const max_tokens = Number($("#maxTokens").value || 1500);
  const include_context = $("#includeContext").checked;
  currentAbort = new AbortController();
  currentToken = { cancelled: false };

  try {
    const resp = await apiJson("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: msg,
        history,
        top_k,
        temperature,
        max_tokens,
        include_context,
      }),
      signal: currentAbort.signal,
    });
    // Replace loading bubble with typewriter output (simulated streaming).
    pending.dataset.complete = "0";
    await typewriter(pending, resp.answer || "（空响应）", { cps: 45, token: currentToken });
    // Once finished (or interrupted), render markdown for the assistant message.
    if (!currentToken.cancelled) {
      renderAssistantMarkdown(pending);
    } else {
      // keep partial plain text
      const c = pending.querySelector(".content") || pending;
      c.textContent = (c.textContent || "") + "\n\n（已打断）";
      pending.dataset.raw = c.textContent;
    }
    let metaText = `latency ${resp.latency_ms ?? "?"}ms · ${nowHHMMSS()}`;
    if (currentToken.cancelled) metaText = `stopped · ${nowHHMMSS()}`;
    const meta = document.createElement("div");
    meta.className = "metaLine";
    meta.textContent = metaText;
    pending.appendChild(meta);
    pending.dataset.complete = "1";
    setSources(resp.sources || [], resp.context || null);
    persistCurrentSession();
  } catch (e) {
    pending.dataset.complete = "1";
    const msg = (e && e.name === "AbortError") ? "已打断（请求已取消）" : `发生错误：${e.message}`;
    setAssistantContent(pending, msg);
    const meta = document.createElement("div");
    meta.className = "metaLine";
    meta.textContent = (e && e.name === "AbortError") ? `stopped · ${nowHHMMSS()}` : `error · ${nowHHMMSS()}`;
    pending.appendChild(meta);
    persistCurrentSession();
  } finally {
    currentAbort = null;
    currentToken = null;
    setBusy(false);
  }
}

function init() {
  const input = $("#input");
  input.addEventListener("input", () => autosizeTextarea(input));
  autosizeTextarea(input);

  $("#btnAction").addEventListener("click", () => {
    if (busy) stopCurrent();
    else send();
  });
  $("#btnNewChat").addEventListener("click", () => startNewSession());
  $("#btnRename").addEventListener("click", () => renameCurrentSession());
  $("#btnHideSources").addEventListener("click", () => $("#sources").classList.add("hidden"));

  $("#btnRefresh").addEventListener("click", () => refreshStatus().catch(() => {}));
  $("#btnRebuild").addEventListener("click", () => rebuild({}).catch((e) => {
    const logBox = $("#rebuildLog");
    logBox.classList.remove("hidden");
    logBox.textContent = `重建失败：${e.message}`;
  }));

  // rename modal
  $("#btnRenameCancel").addEventListener("click", closeRenameModal);
  $("#btnRenameSave").addEventListener("click", saveRenameModal);
  $("#renameModal").addEventListener("click", (e) => {
    if (e.target?.dataset?.close === "1") closeRenameModal();
  });
  $("#renameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveRenameModal();
    if (e.key === "Escape") closeRenameModal();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!busy) send();
    }
  });

  refreshStatus().catch((e) => {
    addMessage("assistant", `无法连接后端：${e.message}\n请确认已运行 run_local_app.py`, `boot · ${nowHHMMSS()}`);
  });

  // restore sessions
  const data = loadSessions();
  currentSessionId = data.current || (data.sessions[0]?.id ?? null);
  if (!currentSessionId) {
    currentSessionId = newId();
    saveSessions(currentSessionId, []);
  }
  renderSessionList();
  const { sessions } = loadSessions();
  const cur = sessions.find((s) => s.id === currentSessionId);
  if (cur) loadSessionToDom(cur);
  else showWelcome();
  sessionDirty = true;
  persistCurrentSession();
}

window.addEventListener("DOMContentLoaded", init);

function showWelcome() {
  const el = addMessage(
    "assistant",
    "你好！我会优先引用课程资料回答问题。\n你可以从左侧查看知识库状态、调整检索与生成参数。\n\n需要更新知识库时，点击左侧“重建知识库”即可（会显示进度）。",
    `boot · ${nowHHMMSS()}`
  );
  renderAssistantMarkdown(el);
}



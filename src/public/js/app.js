(function () {
  'use strict';

  var uiPreferences = loadUiPreferences();
  var markdownCopyCache = {};
  var markdownCopySeq = 0;

  // ── Helpers ──
  function fmtDur(ms) {
    if (ms == null || ms < 0) return '0s';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    var h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  function fmtAgo(ts) {
    if (!ts) return '--';
    if (uiPreferences && uiPreferences.timeFormat === 'absolute') return fmtTimestamp(ts);
    var d = Date.now() - ts;
    if (d < 0) d = 0;
    if (d < 5000) return 'just now';
    if (d < 60000) return Math.floor(d / 1000) + 's ago';
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    return Math.floor(d / 86400000) + 'd ago';
  }

  function fmtTimestamp(ts) {
    if (!ts) return '--';
    try {
      return new Date(ts).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false });
    } catch {
      return '--';
    }
  }

  function loadUiPreferences() {
    var defaults = { theme: 'midnight', density: 'comfortable', timeFormat: 'relative', refreshIntervalSec: 30 };
    try {
      var raw = localStorage.getItem('persona-ui-preferences');
      if (!raw) return defaults;
      var parsed = JSON.parse(raw);
      var theme = ['midnight', 'graphite', 'daylight'].indexOf(parsed.theme) >= 0 ? parsed.theme : 'midnight';
      return {
        theme: theme,
        density: parsed.density === 'compact' ? 'compact' : 'comfortable',
        timeFormat: parsed.timeFormat === 'absolute' ? 'absolute' : 'relative',
        refreshIntervalSec: [0, 15, 30, 60].indexOf(Number(parsed.refreshIntervalSec)) >= 0 ? Number(parsed.refreshIntervalSec) : 30,
      };
    } catch (_) {
      return defaults;
    }
  }

  function saveUiPreferences() {
    try {
      localStorage.setItem('persona-ui-preferences', JSON.stringify(uiPreferences));
    } catch (_) {
      // ignore localStorage failures
    }
  }

  function loadSentArtifacts() {
    try {
      var raw = localStorage.getItem('persona-sent-artifacts');
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function saveSentArtifacts() {
    try {
      localStorage.setItem('persona-sent-artifacts', JSON.stringify(sentArtifacts || {}));
    } catch (_) {
      // ignore localStorage failures
    }
  }

  function loadApprovalHistory() {
    try {
      var raw = localStorage.getItem('persona-approval-history');
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.slice(0, 40) : [];
    } catch (_) {
      return [];
    }
  }

  function saveApprovalHistory() {
    try {
      localStorage.setItem('persona-approval-history', JSON.stringify(approvalHistory || []));
    } catch (_) {
      // ignore localStorage failures
    }
  }

  function fmtAgoMs(ms) {
    if (ms == null) return '--';
    if (ms < 5000) return 'just now';
    if (ms < 60000) return Math.floor(ms / 1000) + 's ago';
    if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
    if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
    return Math.floor(ms / 86400000) + 'd ago';
  }

  function fmtTokens(n) {
    if (n == null) return '--';
    if (n === 0) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }

  function fmtCost(usd) {
    if (usd == null || usd === 0) return '$0';
    return '$' + usd.toFixed(2);
  }

  function esc(s) {
    if (!s) return '';
    s = String(s);
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function jsq(s) {
    return esc(String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '').replace(/\n/g, '\\n'));
  }

  function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function shortText(value, limit) {
    var text = String(value == null ? '' : value);
    var max = limit || 140;
    if (text.length <= max) return text;
    return text.slice(0, Math.max(0, max - 3)) + '...';
  }

  async function readJsonResponse(response) {
    var text = await response.text();
    var body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (_) {
      if (!response.ok) throw new Error(text || ('HTTP ' + response.status));
      throw new Error('response returned non-JSON body');
    }
    if (!response.ok || body.error) throw new Error(body.error || ('HTTP ' + response.status));
    return body;
  }

  function renderMd(text) {
    var html;
    if (typeof marked !== 'undefined' && marked.parse) {
      try { html = marked.parse(text); } catch(e) { /* fallback */ }
    }
    if (!html) html = '<pre>' + esc(text) + '</pre>';
    // Sanitize to prevent XSS from untrusted message content
    if (typeof DOMPurify !== 'undefined') {
      html = DOMPurify.sanitize(html);
    }
    return enhanceMarkdownCodeBlocks(html);
  }

  function cacheCopyText(text) {
    var id = 'copy-' + (++markdownCopySeq);
    markdownCopyCache[id] = String(text || '');
    return id;
  }

  function enhanceMarkdownCodeBlocks(html) {
    if (typeof document === 'undefined') return html;
    var template = document.createElement('template');
    template.innerHTML = html;
    var blocks = template.content.querySelectorAll('pre > code');
    for (var i = 0; i < blocks.length; i++) {
      var code = blocks[i];
      var pre = code.parentElement;
      if (!pre || pre.parentElement && pre.parentElement.classList.contains('code-block-wrap')) continue;
      var lang = '';
      var cls = code.getAttribute('class') || '';
      var match = cls.match(/language-([A-Za-z0-9_-]+)/);
      if (match) lang = match[1];
      var copyId = cacheCopyText(code.textContent || '');
      var wrap = document.createElement('div');
      wrap.className = 'code-block-wrap';
      var toolbar = document.createElement('div');
      toolbar.className = 'code-block-toolbar';
      var label = document.createElement('span');
      label.textContent = lang || 'code';
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-msg-action';
      button.setAttribute('onclick', 'copyCachedText("' + copyId + '")');
      button.textContent = 'Copy Code';
      toolbar.appendChild(label);
      toolbar.appendChild(button);
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(toolbar);
      wrap.appendChild(pre);
    }
    return template.innerHTML;
  }

  // ── State ──
  var data = null;
  var lastRecvAt = 0;
  var wsConnected = false;
  var ws = null;
  var wsEventsData = { events: [], filter: 'all', query: '', selectedId: '', max: 160, renderTimer: 0, lastRenderAt: 0 };
  var chatReplyDraft = null;

  // ── State/TODO panel ──
  var statePanelOpen = false;
  var stateData = { state: '', todo: '' };
  var stateActiveTab = 'state';
  var statePanelEditing = false;

  window.toggleStatePanel = function() {
    var wrap = document.getElementById('state-wrap');
    statePanelOpen = !statePanelOpen;
    if (statePanelOpen) {
      wrap.classList.add('open');
      loadStateData();
    } else {
      wrap.classList.remove('open');
    }
  };

  window.switchStateTab = function(tab) {
    stateActiveTab = tab;
    statePanelEditing = false;
    document.getElementById('state-tab-state').classList.toggle('active', tab === 'state');
    document.getElementById('state-tab-todo').classList.toggle('active', tab === 'todo');
    renderStatePanel();
  };

  window.loadStateData = function() {
    var body = document.getElementById('state-panel-body');
    body.innerHTML = '<div class="empty">Loading...</div>';
    fetch('/api/state')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        stateData = d;
        personaData.state = d.state || '';
        personaData.todo = d.todo || '';
        renderStatePanel();
        if (viewMode === 'persona') renderPersonaView();
      })
      .catch(function() {
        body.innerHTML = '<div class="empty">Failed to load</div>';
      });
  };

  function renderStatePanel() {
    var body = document.getElementById('state-panel-body');
    var raw = stateActiveTab === 'state' ? stateData.state : stateData.todo;
    var label = stateActiveTab === 'state' ? 'daily/state.md' : 'TODO.md';
    if (statePanelEditing) {
      body.innerHTML = '<div class="state-panel-actions"><span class="muted mono">' + esc(label) + '</span>' +
        '<button class="mini-btn" onclick="toggleStatePanelEdit(false)">Cancel</button>' +
        '<button class="mini-btn primary" onclick="saveStatePanelEdit()">Save</button></div>' +
        '<textarea class="state-editor" id="state-panel-editor" spellcheck="false">' + esc(raw || '') + '</textarea>';
      return;
    }
    body.innerHTML = '<div class="state-panel-actions"><span class="muted mono">' + esc(label) + '</span>' +
      '<button class="mini-btn" onclick="toggleStatePanelEdit(true)">Edit</button></div>' +
      (raw ? '<div class="state-md">' + renderMd(raw) + '</div>' : '<div class="empty">Empty</div>');
  }

  window.toggleStatePanelEdit = function(editing) {
    statePanelEditing = !!editing;
    renderStatePanel();
    if (statePanelEditing) {
      setTimeout(function() {
        var editor = document.getElementById('state-panel-editor');
        if (editor) editor.focus();
      }, 0);
    }
  };

  window.saveStatePanelEdit = async function() {
    var editor = document.getElementById('state-panel-editor');
    if (!editor) return;
    queueStateDocSave(stateActiveTab, editor.value, function() {
      statePanelEditing = false;
      renderStatePanel();
    });
  };

  async function executeStateDocSave(kind, content) {
    var res = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: kind, content: content }),
    });
    var body = await res.json().catch(function() { return {}; });
    if (!res.ok || body.error) throw new Error(body.error || 'state save failed');
    if (kind === 'state') {
      stateData.state = content;
      personaData.state = content;
    } else {
      stateData.todo = content;
      personaData.todo = content;
    }
    showToast((kind === 'state' ? 'State' : 'TODO') + ' saved', true);
    if (viewMode === 'persona') renderPersonaView();
    return body;
  }

  function queueStateDocSave(kind, content, afterSave) {
    var safeKind = kind === 'todo' ? 'todo' : 'state';
    var label = safeKind === 'state' ? 'daily/state.md' : 'TODO.md';
    queueDangerApproval({
      title: 'Save persona memory document',
      target: label,
      detail: 'Update local persona ' + label + ' with ' + String(content || '').length + ' character(s).',
      severity: 'medium',
      payload: {
        kind: safeKind,
        path: label,
        contentLength: String(content || '').length,
        preview: shortText(content || '', 240),
      },
    }, async function() {
      try {
        await executeStateDocSave(safeKind, content);
        if (typeof afterSave === 'function') afterSave();
      } catch (err) {
        showToast('Save failed: ' + err.message, false);
        throw err;
      }
    });
  }

  window.savePersonaDoc = async function(kind) {
    var editor = document.getElementById('persona-doc-editor-' + kind);
    if (!editor) return;
    queueStateDocSave(kind, editor.value, function() {
      personaData.editingDoc = null;
      renderPersonaView();
    });
  };

  window.editPersonaDoc = function(kind) {
    personaData.editingDoc = kind;
    renderPersonaView();
  };

  // View state
  var viewMode = 'dashboard'; // 'dashboard' | 'session' | 'task' | 'pool-session'
  var selectedSessionId = null;
  var selectedTaskId = null;
  var selectedPoolLabel = null; // for pool-session view
  var sessionMessages = null; // cached messages for selected session
  var chatSearchQuery = '';
  var chatSearchMatchIndex = -1;
  var chatSearchScrollPending = false;
  var chatViewMode = 'messages';
  var chatDetailSelection = null;
  var sessionRenameDraft = null;
  var expandedChatTurns = {};
  var sentArtifacts = loadSentArtifacts();
  var sessions = []; // cached session list for current expanded director
  var expandedDirector = null; // 'main' or pool label — which director's sub-sessions are shown
  var taskDetail = null; // cached task detail
  var taskOutput = null; // cached task output
  var taskLogs = [];
  var taskLogTotalLines = 0;
  var taskLogPollTimer = null;
  var taskLogFilters = { type: 'all', query: '' };
  var personaData = {
    roles: [],
    state: '',
    todo: '',
    selectedRole: null,
    promptBundle: null,
    promptLoading: false,
    editingDoc: null,
    sessionLinks: {},
    sessionLinksError: null,
    sessionLinkDraft: null,
    docs: [],
    docsRoot: '',
    selectedDoc: null,
    assetFilters: { query: '', category: 'all', freshness: 'all' },
    docPreview: null,
    docEditing: false,
    docError: null,
  };
  var personaLoaded = false;
  var createTaskOpen = false;
  var taskDraft = null;
  var selectedTaskLogKey = '';
  var createCronOpen = false;
  var selectedAutomationCronId = null;
  var editingCronId = null;
  var automationFilters = { query: '', status: 'all', action: 'all', health: 'all', source: 'all' };
  var taskCenterData = {
    tasks: [],
    loading: false,
    error: null,
    filters: { status: 'all', role: '', source: 'all', provider: '', model: '', cronJobId: '', day: '' },
    selected: {},
    cleanup: { olderThanDays: 30, status: 'terminal', loading: false, error: null, preview: null },
  };
  var filesData = { files: [], roots: {}, safety: null, scope: 'all', selectedPath: null, preview: null, loading: false, filters: { query: '', kind: 'all', source: 'all' } };
  var attachmentUploadBusy = false;
  var attachmentUploadSendAfter = true;
  var logsData = { sources: [], selectedId: null, tail: null, loading: false, query: '', level: 'all', bytes: 196608, group: 'all' };
  var globalSearchData = { query: '', loading: false, error: null, result: null, selectedIndex: -1 };
  var apiExplorerData = { method: 'GET', path: '/api/tasks?limit=5', body: '', loading: false, result: null, history: [] };
  var diagnosticsData = { summary: null, loading: false, error: null };
  var parseLogData = { mode: 'conversation', director: 'main', taskId: '', loading: false, error: null, result: null };
  var debugToolsData = { env: null, envLoading: false, envError: null, bundleLoading: false, bundleError: null, bundleEvidence: null, simulateLoading: false, simulateResult: null, simulateError: null, simulateEvidence: null };
  var settingsData = { summary: null, loading: false, error: null };
  var auditData = { entries: [], path: '', loading: false, error: null, filters: { query: '', status: 'all', action: 'all' } };
  var configAssetsData = { configFiles: [], mcpConfigs: [], skills: [], selectedSkillPath: null, loading: false, error: null };
  var runtimeContextData = { role: null, promptBundle: null, loading: false, error: null };

  function syncSentArtifactsFromAudit(entries) {
    var rows = entries || [];
    var changed = false;
    for (var i = rows.length - 1; i >= 0; i--) {
      var entry = rows[i] || {};
      if (entry.action !== 'attachment.send' || !entry.ok) continue;
      var detail = entry.detail || {};
      var path = detail.path || detail.target || '';
      if (!path) continue;
      var sentAt = entry.timestamp ? Date.parse(entry.timestamp) : 0;
      if (!Number.isFinite(sentAt) || sentAt <= 0) sentAt = Date.now();
      var existing = sentArtifacts[path] || null;
      if (existing && Number(existing.sentAt || 0) >= sentAt) continue;
      sentArtifacts[path] = {
        sentAt: sentAt,
        sentAtIso: entry.timestamp || new Date(sentAt).toISOString(),
        director: entry.target || detail.director || detail.sourceDirector || 'main',
        path: path,
        size: detail.size == null ? null : detail.size,
        image: !!detail.image,
        reply: detail.reply == null ? null : !!detail.reply,
        source: existing && existing.source || null,
        audit: {
          action: entry.action,
          ok: !!entry.ok,
          actor: entry.actor || '',
          timestamp: entry.timestamp || null,
          target: entry.target || '',
          detail: detail,
        },
      };
      changed = true;
    }
    if (changed) saveSentArtifacts();
    return changed;
  }

  // Cron state
  var cronJobs = [];
  var cronRunData = { tasks: [], loading: false, error: null };
  var cronPanelOpen = false;
  var expandedCronId = null;
  var autoRefreshTimer = null;
  var dangerApprovalQueue = [];
  var approvalHistory = loadApprovalHistory();
  var runtimeActiveWorkFocusId = '';
  var personaSessionLinkFocusKey = '';
  var dashboardSupplementLoading = false;

  // Streaming state
  var streamingChunks = {}; // director label → accumulated text
  var prevActivityState = 'idle'; // for detecting processing→idle transition
  var prevPoolActivityStates = {}; // label → previous activity state
  var streamRenderTimer = null; // debounce markdown rendering
  var clearingStreams = {}; // director label → final message reload in progress

  var $ = function (id) { return document.getElementById(id); };

  function applyUiPreferences() {
    document.body.classList.toggle('theme-graphite', uiPreferences.theme === 'graphite');
    document.body.classList.toggle('theme-daylight', uiPreferences.theme === 'daylight');
    document.body.classList.toggle('density-compact', uiPreferences.density === 'compact');
  }

  applyUiPreferences();

  function setActiveNav(section) {
    var nav = $('primary-nav');
    if (nav) nav.scrollLeft = 0;
    var items = document.querySelectorAll('#primary-nav .nav-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items[i].dataset.section === section);
    }
  }

  function sourceDirectorOptions(selected) {
    var value = selected || 'main';
    var html = '<option value="main"' + (value === 'main' ? ' selected' : '') + '>Main Director</option>';
    var poolData = data && data.pool || [];
    for (var i = 0; i < poolData.length; i++) {
      var p = poolData[i];
      if (p.closed) continue;
      html += '<option value="' + esc(p.label) + '"' + (value === p.label ? ' selected' : '') + '>' + esc((p.groupName || p.label).slice(0, 32)) + '</option>';
    }
    return html;
  }

  function roleDatalistHtml() {
    var roles = personaData.roles || [];
    if (roles.length === 0) return '';
    var html = '<datalist id="role-options">';
    for (var i = 0; i < roles.length; i++) {
      html += '<option value="' + esc(roles[i].role) + '"></option>';
    }
    html += '</datalist>';
    return html;
  }

  function activeDirectorLabel() {
    return selectedPoolLabel || 'main';
  }

  function activeRuntimeSessionId() {
    if (!data) return '';
    var label = activeDirectorLabel();
    if (label === 'main') return data.system && data.system.sessionId || '';
    var poolData = data.pool || [];
    var match = poolData.find(function(p) { return p.label === label; });
    return match && match.sessionId || '';
  }

  function queueDangerApproval(options, run) {
    var entry = {
      id: 'danger-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      title: options.title || 'Dangerous operation',
      target: options.target || '',
      detail: options.detail || '',
      severity: options.severity || 'high',
      payload: options.payload == null ? null : options.payload,
      createdAt: Date.now(),
      running: false,
      error: null,
      run: run,
    };
    dangerApprovalQueue.unshift(entry);
    showToast('Added to Safety approval queue', false);
    if (viewMode === 'settings') renderSettingsView();
    else selectNav('settings');
  }

  function approvalEntryPayload(item) {
    if (!item) return null;
    return {
      id: item.id,
      title: item.title,
      target: item.target || '',
      detail: item.detail || '',
      severity: item.severity || 'high',
      payload: item.payload == null ? null : item.payload,
      createdAt: item.createdAt,
      createdAtIso: item.createdAt ? new Date(item.createdAt).toISOString() : null,
      running: !!item.running,
      error: item.error || null,
    };
  }

  function approvalQueuePayload() {
    return {
      exportedAt: new Date().toISOString(),
      count: (dangerApprovalQueue || []).length,
      entries: (dangerApprovalQueue || []).map(approvalEntryPayload),
    };
  }

  function approvalHistoryPayload() {
    return {
      exportedAt: new Date().toISOString(),
      count: (approvalHistory || []).length,
      entries: approvalHistory || [],
    };
  }

  function approvalEntryById(id) {
    return (dangerApprovalQueue || []).find(function(entry) { return entry.id === id; }) || null;
  }

  function recordApprovalHistory(item, decision, error, runStartedAt) {
    var payload = approvalEntryPayload(item);
    if (!payload) return;
    var decidedAt = Date.now();
    payload.decision = decision;
    payload.decidedAt = decidedAt;
    payload.decidedAtIso = new Date(payload.decidedAt).toISOString();
    payload.waitMs = item.createdAt ? Math.max(0, decidedAt - item.createdAt) : null;
    payload.runStartedAt = runStartedAt || null;
    payload.runStartedAtIso = runStartedAt ? new Date(runStartedAt).toISOString() : null;
    payload.runDurationMs = runStartedAt ? Math.max(0, decidedAt - runStartedAt) : null;
    payload.error = error || payload.error || null;
    approvalHistory = [payload].concat(approvalHistory || []).slice(0, 40);
    saveApprovalHistory();
  }

  function renderDangerApprovalQueue() {
    var pending = dangerApprovalQueue || [];
    var html = '<div class="danger-approval-queue">';
    html += '<div class="panel-title"><span>Approval Queue</span><div class="panel-actions">';
    html += '<span>' + pending.length + ' pending</span>';
    if (pending.length > 0) {
      html += '<button class="mini-btn" onclick="copyApprovalQueue()">Copy Queue</button>';
      html += '<button class="mini-btn" onclick="exportApprovalQueue()">Export Queue</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromApprovalQueue()">Create Task</button>';
    }
    html += '</div></div>';
    if (pending.length === 0) {
      html += '<div class="empty compact">No high-risk operations are waiting for approval.</div>';
    } else {
      for (var i = 0; i < pending.length; i++) {
        var item = pending[i];
        html += '<div class="danger-approval-row ' + esc(item.severity) + '">';
        html += '<span class="badge failed">' + esc(item.severity) + '</span>';
        html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(item.title) + '</div>';
        html += '<div class="panel-row-sub">' + esc(item.target || '--') + ' · queued ' + esc(fmtAgo(item.createdAt)) + '</div>';
        if (item.detail) html += '<div class="danger-approval-detail">' + esc(item.detail) + '</div>';
        if (item.payload != null) html += '<div class="panel-row-sub">payload available in copied/exported JSON</div>';
        if (item.error) html += '<div class="td-error compact">' + esc(item.error) + '</div>';
        html += '</div><div class="panel-actions">';
        html += '<button class="mini-btn" onclick="copyApprovalEntry(\'' + jsq(item.id) + '\')">Copy JSON</button>';
        html += '<button class="mini-btn" onclick="exportApprovalEntry(\'' + jsq(item.id) + '\')">Export</button>';
        html += '<button class="mini-btn primary" onclick="createTaskFromApprovalEntry(\'' + jsq(item.id) + '\')">Create Task</button>';
        html += '<button class="mini-btn" ' + (item.running ? 'disabled ' : '') + 'onclick="rejectDangerApproval(\'' + jsq(item.id) + '\')">Reject</button>';
        html += '<button class="mini-btn danger" ' + (item.running ? 'disabled ' : '') + 'onclick="approveDangerApproval(\'' + jsq(item.id) + '\')">' + (item.running ? 'Running...' : 'Approve') + '</button>';
        html += '</div></div>';
      }
    }
    html += renderApprovalHistory();
    html += '</div>';
    return html;
  }

  function renderApprovalHistory() {
    var history = approvalHistory || [];
    var html = '<div class="approval-history">';
    html += '<div class="panel-title"><span>Approval History</span><div class="panel-actions">';
    html += '<span>' + history.length + ' recent</span>';
    if (history.length > 0) {
      html += '<button class="mini-btn" onclick="copyApprovalHistory()">Copy History</button>';
      html += '<button class="mini-btn" onclick="exportApprovalHistory()">Export History</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromApprovalHistory()">Create Task</button>';
      html += '<button class="mini-btn" onclick="clearApprovalHistory()">Clear History</button>';
    }
    html += '</div></div>';
    if (!history.length) {
      html += '<div class="empty compact">No approval decisions in this browser yet.</div>';
    } else {
      html += '<div class="approval-history-list">';
      for (var i = 0; i < Math.min(history.length, 12); i++) {
        var item = history[i];
        var ok = item.decision === 'approved';
        var failed = item.decision === 'failed';
        html += '<div class="approval-history-row">';
        html += '<span class="badge ' + (ok ? 'completed' : (failed ? 'failed' : 'pending')) + '">' + esc(item.decision || 'decision') + '</span>';
        html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(item.title || 'Approval') + '</div>';
        var timeParts = [item.target || '--', fmtAgo(item.decidedAt || item.createdAt)];
        if (item.waitMs != null) timeParts.push('wait ' + fmtDur(item.waitMs));
        if (item.runDurationMs != null) timeParts.push('run ' + fmtDur(item.runDurationMs));
        html += '<div class="panel-row-sub">' + esc(timeParts.join(' · ')) + '</div>';
        if (item.error) html += '<div class="td-error compact">' + esc(item.error) + '</div>';
        html += '</div><div class="panel-actions">';
        html += '<button class="chat-msg-action" onclick="copyApprovalHistoryEntry(' + i + ')">Copy JSON</button>';
        html += '<button class="chat-msg-action" onclick="exportApprovalHistoryEntry(' + i + ')">Export</button>';
        html += '<button class="chat-msg-action" onclick="createTaskFromApprovalHistoryEntry(' + i + ')">Create Task</button>';
        html += '</div></div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  window.copyApprovalQueue = function() {
    if (!dangerApprovalQueue.length) {
      showToast('No approval entries to copy', false);
      return;
    }
    copyText(JSON.stringify(approvalQueuePayload(), null, 2));
  };

  window.exportApprovalQueue = function() {
    if (!dangerApprovalQueue.length) {
      showToast('No approval entries to export', false);
      return;
    }
    downloadTextFile('persona-approval-queue-' + Date.now() + '.json', JSON.stringify(approvalQueuePayload(), null, 2));
    showToast('Approval queue exported', true);
  };

  window.copyApprovalEntry = function(id) {
    var item = approvalEntryById(id);
    if (!item) {
      showToast('Approval entry not found', false);
      return;
    }
    copyText(JSON.stringify(approvalEntryPayload(item), null, 2));
  };

  window.exportApprovalEntry = function(id) {
    var item = approvalEntryById(id);
    if (!item) {
      showToast('Approval entry not found', false);
      return;
    }
    downloadTextFile('persona-approval-' + String(item.title || 'entry').replace(/[^a-z0-9._-]+/gi, '-') + '-' + Date.now() + '.json', JSON.stringify(approvalEntryPayload(item), null, 2));
    showToast('Approval entry exported', true);
  };

  window.copyApprovalHistory = function() {
    if (!approvalHistory.length) {
      showToast('No approval history to copy', false);
      return;
    }
    copyText(JSON.stringify(approvalHistoryPayload(), null, 2));
  };

  window.exportApprovalHistory = function() {
    if (!approvalHistory.length) {
      showToast('No approval history to export', false);
      return;
    }
    downloadTextFile('persona-approval-history-' + Date.now() + '.json', JSON.stringify(approvalHistoryPayload(), null, 2));
    showToast('Approval history exported', true);
  };

  window.copyApprovalHistoryEntry = function(index) {
    var item = (approvalHistory || [])[index];
    if (!item) {
      showToast('Approval history entry not found', false);
      return;
    }
    copyText(JSON.stringify(item, null, 2));
  };

  window.exportApprovalHistoryEntry = function(index) {
    var item = (approvalHistory || [])[index];
    if (!item) {
      showToast('Approval history entry not found', false);
      return;
    }
    downloadTextFile('persona-approval-history-entry-' + String(item.title || 'entry').replace(/[^a-z0-9._-]+/gi, '-') + '-' + Date.now() + '.json', JSON.stringify(item, null, 2));
    showToast('Approval history entry exported', true);
  };

  function approvalTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench approval handoff as task context.',
      '',
      'Operator intent:',
      '- Review high-impact operation approval evidence before approving, rejecting, repeating, or changing behavior.',
      '- Inspect title, target, severity, detail, payload, decision history, timing, errors, runtime snapshot, and safety context.',
      '- If an operation is risky, failed, repeatedly rejected, or needs a safer workflow, identify the likely issue and propose or implement a scoped fix.',
      '- Do not approve, reject, clear, or replay operations from this task unless the task prompt is explicitly edited to request it.',
      '',
      'Approval handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function createTaskFromApprovalPayload(payload, description) {
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: shortText(description || 'Review approval evidence', 120),
      prompt: approvalTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Approval handoff loaded into task form', true);
  }

  window.createTaskFromApprovalQueue = function() {
    if (!dangerApprovalQueue.length) {
      showToast('No approval entries to turn into a task', false);
      return;
    }
    var payload = approvalQueuePayload();
    createTaskFromApprovalPayload({
      type: 'approvalQueue',
      queue: payload,
      history: approvalHistoryPayload(),
      snapshot: snapshotReportPayload(),
    }, 'Review approval queue: ' + String(payload.count || 0) + ' pending high-impact operation(s)');
  };

  window.createTaskFromApprovalEntry = function(id) {
    var item = approvalEntryById(id);
    if (!item) {
      showToast('Approval entry not found', false);
      return;
    }
    var payload = approvalEntryPayload(item);
    createTaskFromApprovalPayload({
      type: 'approvalEntry',
      entry: payload,
      queue: approvalQueuePayload(),
      history: approvalHistoryPayload(),
      snapshot: snapshotReportPayload(),
    }, 'Review pending approval: ' + (payload.title || 'approval') + ' · ' + (payload.target || '--'));
  };

  window.createTaskFromApprovalHistory = function() {
    if (!approvalHistory.length) {
      showToast('No approval history to turn into a task', false);
      return;
    }
    var payload = approvalHistoryPayload();
    var failed = (payload.entries || []).filter(function(item) { return item && item.decision === 'failed'; }).length;
    var rejected = (payload.entries || []).filter(function(item) { return item && item.decision === 'rejected'; }).length;
    createTaskFromApprovalPayload({
      type: 'approvalHistory',
      history: payload,
      queue: approvalQueuePayload(),
      snapshot: snapshotReportPayload(),
    }, 'Review approval history: ' + String(payload.count || 0) + ' decisions · ' + String(failed) + ' failed · ' + String(rejected) + ' rejected');
  };

  window.createTaskFromApprovalHistoryEntry = function(index) {
    var item = (approvalHistory || [])[index];
    if (!item) {
      showToast('Approval history entry not found', false);
      return;
    }
    createTaskFromApprovalPayload({
      type: 'approvalHistoryEntry',
      entry: item,
      history: approvalHistoryPayload(),
      queue: approvalQueuePayload(),
      snapshot: snapshotReportPayload(),
    }, 'Review approval decision: ' + (item.title || 'approval') + ' · ' + (item.decision || 'decision'));
  };

  window.clearApprovalHistory = function() {
    if (!approvalHistory.length) {
      showToast('No approval history to clear', false);
      return;
    }
    queueDangerApproval({
      title: 'Clear approval history',
      target: approvalHistory.length + ' decision(s)',
      detail: 'Clear local Approval History in this browser. A record of this clear operation will remain after approval.',
      severity: 'high',
    }, async function() {
      approvalHistory = [];
      saveApprovalHistory();
      showToast('Approval history cleared', true);
      if (viewMode === 'settings') renderSettingsView();
    });
  };

  window.approveDangerApproval = async function(id) {
    var item = dangerApprovalQueue.find(function(entry) { return entry.id === id; });
    if (!item || item.running) return;
    item.running = true;
    item.error = null;
    if (viewMode === 'settings') renderSettingsView();
    var runStartedAt = Date.now();
    try {
      await item.run();
      recordApprovalHistory(item, 'approved', null, runStartedAt);
      dangerApprovalQueue = dangerApprovalQueue.filter(function(entry) { return entry.id !== id; });
      showToast('Approved operation completed', true);
    } catch (err) {
      item.running = false;
      item.error = err && err.message || String(err);
      recordApprovalHistory(item, 'failed', item.error, runStartedAt);
      showToast('Approved operation failed: ' + item.error, false);
    }
    if (viewMode === 'settings') renderSettingsView();
  };

  window.rejectDangerApproval = function(id) {
    var item = approvalEntryById(id);
    if (item) recordApprovalHistory(item, 'rejected');
    dangerApprovalQueue = dangerApprovalQueue.filter(function(entry) { return entry.id !== id; });
    showToast('Approval rejected', true);
    if (viewMode === 'settings') renderSettingsView();
  };

  // ── Chat management ──

  /** Send message from the chat input bar */
  window.doChatSend = function() {
    var input = $('chat-input');
    var text = (input.value || '').trim();
    if (!text) return;
    var replyDraft = chatReplyDraft;
    input.value = '';
    input.style.height = 'auto';
    chatReplyDraft = null;
    renderChatReplyPreview();

    if (!ws || !wsConnected) {
      showToast('Not connected', false);
      return;
    }

    // Send via WebSocket chat message (goes through MessagingRouter)
    var messageId = 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    ws.send(JSON.stringify({
      type: 'chat',
      text: text,
      messageId: messageId,
      director: selectedPoolLabel || null,
      quotedText: replyDraft ? replyDraft.text : undefined,
      quotedMessageKey: replyDraft ? replyDraft.key : undefined,
    }));

    // Append user message to chat immediately
    var el = $('chat-messages');
    if (el) {
      var div = document.createElement('div');
      div.className = 'chat-bubble out';
      div.textContent = text;
      el.appendChild(div);
      var scroll = $('chat-scroll');
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    }

    input.focus();
  };

  function setAttachmentUploadBusy(busy) {
    attachmentUploadBusy = !!busy;
    var button = $('chat-attach-btn');
    if (button) {
      button.disabled = attachmentUploadBusy;
      button.textContent = attachmentUploadBusy ? '...' : '+';
    }
  }

  function pickAttachmentUpload(sendAfter) {
    if (attachmentUploadBusy) {
      showToast('Attachment upload is already running', false);
      return;
    }
    attachmentUploadSendAfter = sendAfter !== false;
    var input = $('chat-attachment-input');
    if (!input) return;
    input.value = '';
    input.click();
  }

  window.pickChatAttachments = function() {
    pickAttachmentUpload(true);
  };

  window.pickWorkbenchUpload = function() {
    pickAttachmentUpload(false);
  };

  window.uploadSelectedAttachments = async function(event) {
    var input = event && event.target || $('chat-attachment-input');
    var selected = Array.prototype.slice.call(input && input.files || []);
    if (selected.length === 0) return;

    var fd = new FormData();
    for (var i = 0; i < selected.length; i++) {
      fd.append('files', selected[i], selected[i].name);
    }

    setAttachmentUploadBusy(true);
    try {
      var res = await fetch('/api/files/upload', { method: 'POST', body: fd });
      var body = await res.json().catch(function() { return {}; });
      if (!res.ok || body.error) throw new Error(body.error || 'upload failed');
      var uploaded = body.files || [];
      if (uploaded.length === 0) throw new Error('no files returned');
      filesData.selectedPath = uploaded[0].path;
      showToast('Uploaded ' + uploaded.length + ' attachment' + (uploaded.length > 1 ? 's' : ''), true);
      if (viewMode === 'files') {
        loadFilesData(filesData.scope || 'all');
      }
      if (attachmentUploadSendAfter) {
        for (var j = 0; j < uploaded.length; j++) {
          window.sendWorkbenchFile(uploaded[j].path);
        }
      }
    } catch (err) {
      showToast('Upload failed: ' + err.message, false);
    } finally {
      setAttachmentUploadBusy(false);
      if (input) input.value = '';
    }
  };

  /** Create a new web chat session */
  window.doNewWebChat = function() {
    fetch('/api/web-sessions', { method: 'POST' })
      .then(readJsonResponse)
      .then(function(d) {
        if (d.ok) {
          showToast('New chat created', true);
          selectPoolDirector(d.label, 'Web Chat');
          loadAuditLog();
        } else {
          showToast(d.error || 'Failed to create chat', false);
        }
      })
      .catch(function(err) {
        showToast('Failed: ' + err.message, false);
      });
  };

  /** Close a web chat session */
  window.doCloseWebChat = function(routingKey) {
    queueDangerApproval({
      title: 'Close web chat session',
      target: routingKey,
      detail: 'The Web Chat session will be closed and removed from the active session list.',
      severity: 'medium',
      payload: { routingKey: routingKey },
    }, async function() {
      var r = await fetch('/api/web-sessions/' + encodeURIComponent(routingKey), { method: 'DELETE' });
      var d = await readJsonResponse(r);
      if (d.ok) {
        showToast('Chat closed', true);
        loadAuditLog();
        if (viewMode === 'pool-session') {
          selectDashboard();
        }
      } else {
        throw new Error(d.error || 'Failed to close');
      }
    });
  };

  function showChat() {
    $('main').classList.add('chat-active');
  }

  function hideChat() {
    $('main').classList.remove('chat-active');
    $('chat-input-bar').classList.remove('visible');
  }

  // ── Normalize ──
  function normalize(raw) {
    if (raw.system) return raw;
    var dir = raw.director || {};
    var q = raw.queue || [];
    var limit = dir.flushContextLimit || 0;
    var tokens = dir.lastInputTokens || 0;
    var pct = limit > 0 ? (tokens / limit) * 100 : 0;
    var state = 'idle';
    if (dir.flushing) state = 'flushing';
    else if ((dir.pendingCount || 0) > 0) state = 'processing';
    return {
      system: { status: dir.alive ? 'healthy' : 'error', uptime: 0, messaging: 'unknown', directorAlive: !!dir.alive },
      activity: { state: state },
      context: { tokens: tokens, limit: limit, percent: Math.round(pct), live: true, lastFlushAgoMs: null },
      metrics: { today: { messagesProcessed: 0, avgResponseSec: 0, totalCostUsd: 0 }, recentMessages: [], recentErrors: [] },
      queue: q.map(function(i) { return { correlationId: i.correlationId || '', preview: (i.text || '').slice(0,60), timestamp: i.timestamp, cancelled: !!i.cancelled }; }),
      tasks: { summary: { running: 0, completed: 0, failed: 0 }, recent: [] },
      pool: [],
    };
  }

  // ── WebSocket ──
  function getWsUrl() {
    // Forward ?token= query param to WebSocket connection for auth
    var params = new URLSearchParams(location.search);
    var token = params.get('token');
    var base = 'ws://' + location.host;
    return token ? base + '?token=' + encodeURIComponent(token) : base;
  }

  function summarizeWsPayload(type, payload, rawText) {
    if (type === 'raw') return shortText(rawText || '', 180);
    if (!payload || typeof payload !== 'object') return shortText(payload == null ? '' : payload, 180);
    if (type === 'status') {
      var activity = payload.data && payload.data.activity || payload.activity || {};
      var queue = payload.data && payload.data.queue || payload.queue || [];
      var pool = payload.data && payload.data.pool || payload.pool || [];
      return 'state=' + (activity.state || '--') + ' queue=' + queue.length + ' pool=' + pool.length;
    }
    if (type === 'chunk') {
      return (payload.director || 'main') + ' +' + String(payload.text || '').length + ' chars';
    }
    if (type === 'chat_reply') {
      return (payload.director || 'main') + ' ' + shortText(payload.text || '', 140);
    }
    if (type === 'chat_attachment') {
      var file = payload.file || {};
      return 'attachment ' + shortText(file.name || file.path || '', 140);
    }
    if (type === 'command_result') {
      return (payload.ok ? 'ok ' : 'failed ') + shortText(payload.message || payload.command || '', 140);
    }
    if (type === 'stream-abort') {
      return 'director=' + (payload.director || 'main');
    }
    try {
      return shortText(JSON.stringify(payload), 180);
    } catch (_) {
      return shortText(String(payload), 180);
    }
  }

  function recordWsEvent(type, payload, rawText) {
    var event = {
      id: Date.now() + '-' + Math.random().toString(16).slice(2),
      at: Date.now(),
      type: type || 'message',
      summary: summarizeWsPayload(type || 'message', payload, rawText),
      payload: payload == null ? null : payload,
      raw: rawText || null,
    };
    wsEventsData.events.unshift(event);
    if (wsEventsData.events.length > wsEventsData.max) {
      wsEventsData.events.length = wsEventsData.max;
    }
    requestWsEventsRender();
  }

  function connect() {
    ws = new WebSocket(getWsUrl());
    ws.onopen = function () {
      wsConnected = true;
      recordWsEvent('open', { host: location.host });
      $('overlay').classList.add('hidden');
      // Load sessions on connect
      loadSessions(expandedDirector);
      loadCronJobs();
    };
    ws.onclose = function () {
      wsConnected = false;
      recordWsEvent('close', { host: location.host });
      $('overlay').classList.remove('hidden');
      setTimeout(connect, 2000);
    };
    ws.onerror = function () {
      recordWsEvent('error', { host: location.host });
    };
    ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        recordWsEvent(msg.type || 'message', msg, ev.data);
        if (msg.type === 'status') {
          data = normalize(msg.data);
          lastRecvAt = Date.now();

          // Detect processing→idle transitions to clear streaming
          var newState = data.activity && data.activity.state || 'idle';
          if (prevActivityState === 'processing' && newState !== 'processing') {
            // Main director finished — clear streaming after short delay for trailing chunks
            setTimeout(function() { clearStreaming('main'); }, 300);
          }
          prevActivityState = newState;

          // Same for pool Directors
          var poolData = data.pool || [];
          for (var pi = 0; pi < poolData.length; pi++) {
            var pe = poolData[pi];
            var prevPe = prevPoolActivityStates[pe.label] || 'idle';
            var curPe = pe.activity || 'idle';
            if (prevPe === 'processing' && curPe !== 'processing') {
              // Pool director finished processing — clear streaming and reload messages
              setTimeout(clearStreaming.bind(null, pe.label), 300);
            } else if (curPe !== 'processing' && streamingChunks[pe.label]) {
              // Fallback: streaming chunks exist but activity already idle
              setTimeout(clearStreaming.bind(null, pe.label), 300);
            }
            prevPoolActivityStates[pe.label] = curPe;
          }

          renderSidebar();
          updateChatStopButton();
          if (viewMode === 'dashboard') renderDashboard();
          else if (viewMode === 'agents') renderRuntimeView();
          else if (viewMode === 'tasks') renderTasksHome();
          else if (viewMode === 'observability') renderObservabilityView();
        } else if (msg.type === 'chunk') {
          var label = msg.director || 'main';
          if (!streamingChunks[label]) streamingChunks[label] = '';
          streamingChunks[label] += msg.text;
          scheduleStreamRender(label);
        } else if (msg.type === 'stream-abort') {
          clearStreaming(msg.director || 'main');
        } else if (msg.type === 'command_result') {
          showToast(msg.message || msg.command, msg.ok);
        } else if (msg.type === 'chat_reply') {
          // Director 回复 web chat 消息 — filter by current director
          var replyDirector = msg.director || null;
          var showReply = false;
          if (viewMode === 'pool-session' && selectedPoolLabel) {
            showReply = (replyDirector === selectedPoolLabel);
          } else if (viewMode === 'session') {
            showReply = (!replyDirector || replyDirector === 'main');
          } else {
            showReply = true; // dashboard or other views: show all
          }
          if (showReply) {
            var el = $('chat-messages');
            if (el) {
              var div = document.createElement('div');
              div.className = 'chat-bubble in';
              div.textContent = msg.text;
              el.appendChild(div);
              var scroll = $('chat-scroll');
              if (scroll) scroll.scrollTop = scroll.scrollHeight;
            }
          }
        } else if (msg.type === 'chat_attachment') {
          var file = msg.file || {};
          var aEl = $('chat-messages');
          if (aEl) {
            var wrap = document.createElement('div');
            wrap.className = 'chat-msg out';
            var fileUrl = String(file.url || '');
            var fileName = file.name || file.path || 'attachment';
            var meta = [];
            if (file.kind) meta.push(file.kind);
            if (file.size != null) meta.push(fmtTokens(file.size) + 'B');
            var body = '<div class="chat-msg-header"><span class="chat-msg-role user">Attachment</span></div>';
            body += '<div class="chat-msg-body">';
            if (file.image && fileUrl) {
              body += '<div class="image-preview-wrap"><img class="image-preview" src="' + esc(fileUrl) + '" alt="' + esc(fileName) + '"></div>';
            }
            body += '<a href="' + esc(fileUrl) + '" target="_blank" rel="noreferrer">' + esc(fileName) + '</a>';
            if (meta.length) body += '<div class="muted mono">' + esc(meta.join(' · ')) + '</div>';
            body += '</div>';
            wrap.innerHTML = body;
            aEl.appendChild(wrap);
            var aScroll = $('chat-scroll');
            if (aScroll) aScroll.scrollTop = aScroll.scrollHeight;
          }
        }
      } catch (e) {
        recordWsEvent('parse-error', { error: String(e) }, ev.data);
      }
    };
  }

  // ── Data loading ──
  function loadSessions(directorLabel) {
    var url = '/api/sessions';
    if (directorLabel && directorLabel !== 'main') url += '?director=' + encodeURIComponent(directorLabel);
    return fetch(url).then(function(r) { return r.json(); }).then(function(d) {
      sessions = d || [];
      if (viewMode === 'pool-session' && selectedPoolLabel === directorLabel && !selectedSessionId) {
        var liveId = currentLiveSessionId();
        if (!liveId && sessions.length > 0) selectedSessionId = sessions[0].sessionId;
      }
      renderSessionList();
      renderSessionTabs();
    }).catch(function() {});
  }

  function loadSessionMessages(sessionId) {
    var url = '/api/messages?limit=200';
    if (sessionId) url += '&sessionId=' + encodeURIComponent(sessionId);
    return fetch(url).then(function(r) { return r.json(); }).then(function(d) {
      sessionMessages = d || [];
      renderSessionView();
    }).catch(function() {
      sessionMessages = [];
      renderSessionView();
    });
  }

  function loadAllMessages() {
    return fetch('/api/messages?limit=200').then(function(r) { return r.json(); }).then(function(d) {
      sessionMessages = d || [];
      renderSessionView();
    }).catch(function() {
      sessionMessages = [];
      renderSessionView();
    });
  }

  // ── Pool session loading ──
  function loadPoolMessages(label) {
    return loadPoolDirectorMessages(label, null);
  }

  function loadPoolDirectorMessages(label, sessionId) {
    var url = '/api/messages?limit=200&director=' + encodeURIComponent(label);
    if (sessionId) url += '&sessionId=' + encodeURIComponent(sessionId);
    return fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(d) {
        sessionMessages = d || [];
        renderSessionView();
      })
      .catch(function() {
        sessionMessages = [];
        renderSessionView();
      });
  }

  window.selectPoolDirector = function(label, groupName) {
    stopLogPolling();
    viewMode = 'pool-session';
    setActiveNav('workbench');
    selectedPoolLabel = label;
    selectedSessionId = null;
    chatReplyDraft = null;
    var shortName = (groupName || label).slice(0, 8);
    $('dh-title').textContent = shortName + ' (Director)';
    $('dh-sub').textContent = '';
    $('detail-content').classList.remove('task-split-mode');
    showChat();
    // Load sub-sessions for tabs
    var sessionsPromise;
    if (expandedDirector !== label) {
      expandedDirector = label;
      sessionsPromise = loadSessions(label);
    } else {
      renderSessionList();
      renderSessionTabs();
      sessionsPromise = Promise.resolve();
    }
    Promise.resolve(sessionsPromise).then(function() {
      loadPoolDirectorMessages(label, selectedSessionId);
    });
  };

  /** Toggle sub-session list for a Director (now handled via session tabs) */
  window.toggleDirector = function(label) {
    // No-op — sub-sessions now shown as tabs above chat
  };

  /** Select a sub-session within a Director */
  window.selectSubSession = function(directorLabel, sessionId, sessionName) {
    stopLogPolling();
    selectedSessionId = sessionId;
    selectedTaskId = null;
    chatReplyDraft = null;
    $('detail-content').classList.remove('task-split-mode');
    showChat();
    // Ensure this director's sessions are loaded
    if (expandedDirector !== directorLabel) {
      expandedDirector = directorLabel;
      loadSessions(directorLabel);
    } else {
      renderSessionList();
      renderSessionTabs();
    }
    if (directorLabel === 'main') {
      viewMode = 'session';
      selectedPoolLabel = null;
      $('dh-title').textContent = 'Main (Director)';
    } else {
      viewMode = 'pool-session';
      selectedPoolLabel = directorLabel;
      var poolData = (data && data.pool) || [];
      var match = poolData.find(function(p) { return p.label === directorLabel; });
      var shortName = match ? match.groupName.slice(0, 8) : directorLabel;
      $('dh-title').textContent = shortName + ' (Director)';
    }
    $('dh-sub').textContent = sessionName || sessionId.slice(0, 16);
    if (directorLabel === 'main') {
      loadSessionMessages(sessionId);
    } else {
      loadPoolDirectorMessages(directorLabel, sessionId);
    }
  };

  // ── Streaming helpers ──
  function clearStreaming(label) {
    if (clearingStreams[label]) return;
    clearingStreams[label] = true;
    // Reload messages to get the final response
    if (viewMode === 'session' || viewMode === 'pool-session') {
      var done;
      if (viewMode === 'pool-session' && selectedPoolLabel === label) {
        done = loadPoolMessages(label);
      } else if (viewMode === 'session') {
        done = selectedSessionId ? loadSessionMessages(selectedSessionId) : loadAllMessages();
      }
      Promise.resolve(done).finally(function() {
        delete streamingChunks[label];
        delete clearingStreams[label];
        removeStreamingBubble(label);
      });
      return;
    }
    delete streamingChunks[label];
    delete clearingStreams[label];
    removeStreamingBubble(label);
  }

  function removeStreamingBubble(label) {
    var bubble = document.getElementById('streaming-bubble-' + label);
    if (bubble) bubble.remove();
  }

  function scheduleStreamRender(label) {
    // Debounce markdown rendering to avoid jank on rapid chunks
    if (streamRenderTimer) return;
    streamRenderTimer = setTimeout(function() {
      streamRenderTimer = null;
      renderStreamingBubble(label);
    }, 100);
  }

  function renderStreamingBubble(label) {
    // Only render in session/pool-session views for the relevant Director
    var isRelevant = false;
    if (viewMode === 'session') {
      isRelevant = (label === 'main');
    } else if (viewMode === 'pool-session') {
      isRelevant = (label === selectedPoolLabel);
    }
    if (!isRelevant) return;

    var container = $('chat-messages');
    if (!container) return;

    var bubbleId = 'streaming-bubble-' + label;
    var el = document.getElementById(bubbleId);
    if (!el) {
      // Remove any existing "Processing..." indicator
      var proc = container.querySelector('.chat-processing');
      if (proc) proc.remove();

      el = document.createElement('div');
      el.id = bubbleId;
      el.className = 'chat-msg out streaming';
      el.innerHTML = '<div class="chat-msg-header">' +
        '<span class="chat-msg-role bot">Director</span>' +
        '<div class="running-dot" style="margin-left:4px"></div>' +
        '</div>' +
        '<div class="chat-msg-body"><div class="md-content" id="streaming-content-' + label + '"></div></div>';
      container.appendChild(el);
    }

    var contentEl = document.getElementById('streaming-content-' + label);
    if (contentEl) {
      contentEl.innerHTML = renderMd((streamingChunks[label] || '') + ' \u258d');
    }

    // Auto-scroll if near bottom
    var scroll = $('chat-scroll');
    if (scroll) {
      var nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 150;
      if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
    }
  }

  function loadTaskDetail(taskId) {
    fetch('/api/tasks/' + taskId).then(function(r) { return r.json(); }).then(function(d) {
      taskDetail = d;
      taskOutput = null;
      renderTaskView();
      if (d.result_file) {
        fetch('/api/tasks/' + taskId + '/output').then(function(r) {
          if (r.ok) return r.json();
          return null;
        }).then(function(o) {
          if (o && o.content) {
            taskOutput = o.content;
            renderTaskResultPanel();
          }
        }).catch(function() {});
      }
    }).catch(function() {});
  }

  // ── Commands ──
  window.doCmd = function (cmd) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    var msgs = {
      flush: 'Flush Director context? Progress will be checkpointed.',
      clear: 'Clear Director context? Current state will NOT be saved.',
      esc: 'Cancel the oldest queued message?',
      'session-restart': 'Restart Director? In-flight processing will be interrupted.',
    };
    if (msgs[cmd]) {
      queueDangerApproval({
        title: 'Main Director command: ' + cmd,
      target: 'main',
      detail: msgs[cmd],
      severity: cmd === 'flush' ? 'medium' : 'high',
      payload: { director: 'main', command: cmd },
      }, async function() {
        if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not connected');
        ws.send(JSON.stringify({ type: 'command', command: cmd }));
        showToast('Command sent: ' + cmd, true);
      });
      return;
    }
    ws.send(JSON.stringify({ type: 'command', command: cmd }));
  };

  window.doSend = async function () {
    var input = $('send-input');
    var text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    try {
      var res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text }),
      });
      var body = await res.json();
      showToast(body.message || 'Sent', !!body.ok);
    } catch (err) {
      showToast('Send failed: ' + err.message, false);
    }
  };

  // ── Primary navigation ──
  window.selectNav = function(section) {
    stopLogPolling();
    selectedTaskId = null;
    $('detail-content').classList.remove('task-split-mode');
    $('session-dropdown').style.display = 'none';

    if (section === 'overview') {
      selectDashboard();
      return;
    }
    if (section === 'workbench') {
      selectSession(null);
      return;
    }
    if (section === 'agents') {
      viewMode = 'agents';
      selectedSessionId = null;
      selectedPoolLabel = null;
      hideChat();
      setActiveNav('agents');
      $('dh-title').textContent = 'Agents';
      $('dh-sub').textContent = 'Director runtime';
      if (!personaLoaded) loadPersonaMetaOnly();
      loadRuntimeControlMeta();
      renderRuntimeView();
      return;
    }
    if (section === 'tasks') {
      viewMode = 'tasks';
      selectedSessionId = null;
      selectedPoolLabel = null;
      hideChat();
      setActiveNav('tasks');
      $('dh-title').textContent = 'Tasks';
      $('dh-sub').textContent = 'Mission Center';
      if (!personaLoaded) loadPersonaMetaOnly();
      renderSessionList();
      renderTaskList();
      renderTasksHome();
      loadTaskCenterTasks();
      return;
    }
    if (section === 'automations') {
      viewMode = 'automations';
      selectedSessionId = null;
      selectedPoolLabel = null;
      hideChat();
      setActiveNav('automations');
      $('dh-title').textContent = 'Automations';
      $('dh-sub').textContent = 'Cron and schedules';
      if (!personaLoaded) loadPersonaMetaOnly();
      renderAutomationsView();
      loadCronJobs();
      loadCronRuns();
      loadAuditLog();
      return;
    }
    if (section === 'persona') {
      viewMode = 'persona';
      selectedSessionId = null;
      selectedPoolLabel = null;
      hideChat();
      setActiveNav('persona');
      $('dh-title').textContent = 'Persona';
      $('dh-sub').textContent = 'Roles, prompts and memory';
      loadPersonaWorkbenchData();
      loadConfigAssets();
      return;
    }
    if (section === 'files') {
      viewMode = 'files';
      selectedSessionId = null;
      selectedPoolLabel = null;
      hideChat();
      setActiveNav('files');
      $('dh-title').textContent = 'Files';
      $('dh-sub').textContent = 'Artifacts and attachments';
      loadFilesData(filesData.scope || 'all');
      loadAuditLog();
      return;
    }
    if (section === 'observability') {
      viewMode = 'observability';
      selectedSessionId = null;
      selectedPoolLabel = null;
      hideChat();
      setActiveNav('observability');
      $('dh-title').textContent = 'Logs';
      $('dh-sub').textContent = 'Runtime tails and recent events';
      loadLogSources();
      loadDiagnosticsSummary();
      return;
    }
    if (section === 'settings') {
      viewMode = 'settings';
      selectedSessionId = null;
      selectedPoolLabel = null;
      hideChat();
      setActiveNav('settings');
      $('dh-title').textContent = 'Settings';
      $('dh-sub').textContent = 'Configuration and safety';
      loadSettingsSummary();
      loadAuditLog();
      loadConfigAssets();
    }
  };

  function loadPersonaMetaOnly() {
    fetch('/api/persona/roles')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        personaData.roles = d.roles || [];
        personaLoaded = true;
        if (viewMode === 'tasks') renderTasksHome();
        if (viewMode === 'automations') renderAutomationsView();
      })
      .catch(function() {});
  }

  function loadRuntimeControlMeta() {
    if (!settingsData.summary && !settingsData.loading) {
      settingsData.loading = true;
      fetch('/api/config-summary')
        .then(function(r) {
          if (!r.ok) return r.text().then(function(text) { throw new Error(text || 'config summary request failed'); });
          return r.json();
        })
        .then(function(summary) {
          settingsData.summary = summary;
          settingsData.loading = false;
          if (viewMode === 'agents') renderRuntimeView();
        })
        .catch(function(err) {
          settingsData.loading = false;
          settingsData.error = String(err);
          if (viewMode === 'agents') renderRuntimeView();
        });
    }
    if (!configAssetsData.loading && configAssetsData.configFiles.length === 0 && configAssetsData.mcpConfigs.length === 0 && !configAssetsData.error) {
      loadConfigAssets();
    }
    ensureRuntimePromptBundle();
  }

  function ensureRuntimePromptBundle() {
    var role = data && data.system && data.system.personaRole || 'director';
    if (runtimeContextData.loading) return;
    if (runtimeContextData.role === role && runtimeContextData.promptBundle) return;
    if (runtimeContextData.role === role && runtimeContextData.error) return;
    runtimeContextData.role = role;
    runtimeContextData.loading = true;
    runtimeContextData.error = null;
    fetch('/api/persona/prompt?role=' + encodeURIComponent(role))
      .then(function(r) {
        if (!r.ok) return r.text().then(function(text) { throw new Error(text || 'prompt bundle request failed'); });
        return r.json();
      })
      .then(function(bundle) {
        runtimeContextData.promptBundle = bundle;
        runtimeContextData.loading = false;
        if (viewMode === 'agents') renderRuntimeView();
      })
      .catch(function(err) {
        runtimeContextData.promptBundle = null;
        runtimeContextData.loading = false;
        runtimeContextData.error = String(err && err.message || err);
        if (viewMode === 'agents') renderRuntimeView();
      });
  }

  function providerOptionsHtml(selected) {
    var selectedValue = selected || '';
    var providers = settingsData.summary && settingsData.summary.agents && settingsData.summary.agents.providers || {};
    var names = Object.keys(providers).sort();
    var html = '';
    if (names.length === 0) {
      html += '<option value="' + esc(selectedValue || 'default') + '">' + esc(selectedValue || 'default') + '</option>';
      return html;
    }
    for (var i = 0; i < names.length; i++) {
      html += '<option value="' + esc(names[i]) + '"' + (selectedValue === names[i] ? ' selected' : '') + '>' + esc(names[i]) + '</option>';
    }
    return html;
  }

  function personaRoleOptionsHtml(selected) {
    var selectedValue = selected || 'director';
    var roles = personaData.roles || [];
    var seen = {};
    var html = '';
    for (var i = 0; i < roles.length; i++) {
      var role = roles[i].role;
      seen[role] = true;
      html += '<option value="' + esc(role) + '"' + (selectedValue === role ? ' selected' : '') + '>' + esc(role) + '</option>';
    }
    if (!seen[selectedValue]) {
      html = '<option value="' + esc(selectedValue) + '" selected>' + esc(selectedValue) + '</option>' + html;
    }
    return html;
  }

  function renderRuntimeView() {
    if (!data) {
      $('detail-content').innerHTML = '<div class="empty">Waiting for status...</div>';
      return;
    }
    var sys = data.system || {};
    var act = data.activity || {};
    var ctx = data.context || {};
    var poolData = data.pool || [];
    var queue = data.queue || [];
    ensureRuntimePromptBundle();
    var html = '<div class="page-grid">';
    html += '<div class="workbench-panel wide"><div class="panel-title"><span>Main Director</span><div class="panel-actions">';
    html += '<span class="badge ' + (sys.directorAlive ? 'running' : 'failed') + '">' + (sys.directorAlive ? 'alive' : 'dead') + '</span>';
    html += '<button class="mini-btn" onclick="copyRuntimeSnapshot()">Copy Snapshot</button>';
    html += '<button class="mini-btn" onclick="exportRuntimeSnapshot()">Export Snapshot</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromRuntimeSnapshot()">Create Task</button>';
    html += '</div></div>';
    html += '<div class="kv-grid">';
    html += '<div class="kv-card"><div class="kv-label">Session</div><div class="kv-value">' + esc(sys.sessionName || sys.sessionId || '--') + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Provider</div><div class="kv-value">' + esc(sys.directorAgentName || sys.directorAgentType || '--') + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Persona</div><div class="kv-value">' + esc(sys.personaRole || '--') + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Activity</div><div class="kv-value">' + esc(act.state || '--') + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Context</div><div class="kv-value">' + fmtTokens(ctx.tokens) + ' / ' + fmtTokens(ctx.limit) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Queue</div><div class="kv-value">' + queue.length + '</div></div>';
    html += '</div><div class="panel-actions" style="margin-top:12px">';
    html += '<button class="mini-btn primary" onclick="createTaskFromRuntimeCommandSurface(\'main\')">Create Task</button>';
    html += '<button class="mini-btn" onclick="doCmd(\'flush\')">Flush</button>';
    html += '<button class="mini-btn" onclick="doCmd(\'clear\')">Clear</button>';
    html += '<button class="mini-btn" onclick="doCmd(\'esc\')">Esc</button>';
    html += '<button class="mini-btn" onclick="doCmd(\'session-restart\')">Restart</button>';
    html += '</div></div>';
    html += renderRuntimeSwitchControls('main', sys.directorAgentName || '', sys.personaRole || 'director', 'runtime-main');

    html += renderRuntimeProcessMonitor(sys, poolData, act);
    html += renderRuntimeActiveWorkPanel(sys, poolData, act, queue);
    html += renderRuntimeContextHealthPanel();
    html += renderRuntimeContextPanel(sys, poolData);

    html += '<div class="workbench-panel wide"><div class="panel-title"><span>Main Queue</span><div class="panel-actions"><span>' + queue.length + '</span>';
    html += '<button class="mini-btn" onclick="copyRuntimeQueue()">Copy Queue</button>';
    html += '<button class="mini-btn" onclick="exportRuntimeQueue()">Export Queue</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromRuntimeQueue()">Create Task</button>';
    if (queue.length > 0) html += '<button class="mini-btn" onclick="createTaskFromRuntimeQueueClearIntent()">Review Clear</button>';
    if (queue.length > 0) html += '<button class="mini-btn danger" onclick="clearMainQueue()">Clear Queue</button>';
    html += '</div></div>';
    html += renderRuntimeQueue(queue);
    html += '</div>';

    html += '<div class="workbench-panel wide"><div class="panel-title"><span>Director Pool</span><span>' + poolData.length + '</span></div><div class="panel-list">';
    if (poolData.length === 0) {
      html += '<div class="empty">No pool directors</div>';
    } else {
      for (var i = 0; i < poolData.length; i++) {
        var p = poolData[i];
        html += '<div class="panel-row clickable" onclick="selectPoolDirector(\'' + esc(p.label) + '\',\'' + esc(p.groupName || p.label) + '\')">';
        html += '<span class="item-icon" style="color:' + (p.alive ? 'var(--green)' : 'var(--overlay0)') + '">&#9679;</span>';
        html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(p.groupName || p.label) + '</div>';
        html += '<div class="panel-row-sub">' + esc(p.label) + ' · ' + esc(p.activity || (p.closed ? (p.closedReason || 'closed') : 'idle')) + ' · queue ' + (p.queueLength || 0) +
          ' · pid ' + esc(p.pid || '--') +
          ' · provider ' + esc(p.directorAgentName || p.directorAgentType || '--') +
          ' · persona ' + esc(p.personaRole || '--') + '</div></div>';
        if (!p.closed) {
          html += renderRuntimeDirectorCommandActions(p.label, p.groupName || p.label);
        }
        html += '<span class="item-meta">' + (p.lastActiveAt ? fmtAgo(p.lastActiveAt) : '--') + '</span></div>';
        if (!p.closed) {
          html += renderRuntimeSwitchControls(p.label, p.directorAgentName || '', p.personaRole || 'director', 'runtime-pool-' + i);
        }
      }
    }
    html += '</div></div>';
    html += '</div>';
    $('detail-content').innerHTML = html;
  }

  function runtimeDirectorSnapshots(sys, poolData, act) {
    var directors = [{
      label: 'main',
      groupName: 'Main Director',
      alive: !!sys.directorAlive,
      pid: sys.directorPid,
      activity: act && act.state || 'idle',
      provider: sys.directorAgentName || sys.directorAgentType || '',
      personaRole: sys.personaRole || '',
      sessionId: sys.sessionId || '',
      restartCount: sys.restartCount || 0,
      recentRestartCount: sys.recentRestartCount || 0,
      recentRestartAt: sys.recentRestartAt || [],
      lastRestartAt: sys.lastRestartAt || null,
      lastRestartReason: sys.lastRestartReason || '',
      lastCrashAt: sys.lastCrashAt || null,
      lastCrashReason: sys.lastCrashReason || '',
      currentMessage: act && act.currentMessage || null,
      queue: data && data.queue || [],
    }];
    for (var i = 0; i < (poolData || []).length; i++) {
      var p = poolData[i];
      directors.push({
        label: p.label || '',
        groupName: p.groupName || p.label || 'Pool Director',
        alive: !!p.alive,
        pid: p.pid,
        activity: p.activity || (p.closed ? 'closed' : 'idle'),
        provider: p.directorAgentName || p.directorAgentType || '',
        personaRole: p.personaRole || '',
        sessionId: p.sessionId || '',
        restartCount: p.restartCount || 0,
        recentRestartCount: p.recentRestartCount || 0,
        recentRestartAt: p.recentRestartAt || [],
        lastRestartAt: p.lastRestartAt || null,
        lastRestartReason: p.lastRestartReason || '',
        lastCrashAt: p.lastCrashAt || null,
        lastCrashReason: p.lastCrashReason || '',
        currentMessage: p.currentMessage || null,
        queue: p.queue || [],
        closed: !!p.closed,
        lastActiveAt: p.lastActiveAt,
        queueLength: p.queueLength || 0,
      });
    }
    return directors;
  }

  function renderRuntimeProcessMonitor(sys, poolData, act) {
    var directors = runtimeDirectorSnapshots(sys, poolData, act);

    var aliveCount = directors.filter(function(d) { return d.alive; }).length;
    var crashCount = directors.filter(function(d) { return !!d.lastCrashAt; }).length;
    var recentRestarts = directors.reduce(function(sum, d) { return sum + Number(d.recentRestartCount || 0); }, 0);
    var html = '<div class="workbench-panel wide runtime-process-panel">';
    html += '<div class="panel-title"><span>Process Monitor</span><div class="panel-actions"><span class="muted mono">' + aliveCount + '/' + directors.length + ' alive · ' + recentRestarts + ' recent restarts · ' + crashCount + ' crashes</span>';
    html += '<button class="mini-btn" onclick="copyRuntimeProcesses()">Copy Processes</button>';
    html += '<button class="mini-btn" onclick="exportRuntimeProcesses()">Export Processes</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromRuntimeProcesses()">Create Task</button>';
    html += '</div></div>';
    html += '<div class="runtime-process-grid">';
    for (var j = 0; j < directors.length; j++) {
      html += renderRuntimeProcessCard(directors[j]);
    }
    html += '</div></div>';
    return html;
  }

  function renderRuntimeProcessCard(d) {
    var state = d.closed ? 'closed' : (d.alive ? 'alive' : 'dead');
    var badgeClass = d.closed ? 'cancelled' : (d.alive ? 'running' : 'failed');
    var lastRestart = d.lastRestartAt ? fmtAgo(d.lastRestartAt) : '--';
    var lastCrash = d.lastCrashAt ? fmtAgo(d.lastCrashAt) : '--';
    var html = '<div class="runtime-process-card">';
    html += '<div class="runtime-process-head"><span class="badge ' + badgeClass + '">' + esc(state) + '</span><strong>' + esc(d.groupName || d.label || '--') + '</strong></div>';
    html += '<div class="panel-row-sub">' + esc(d.label || '--') + ' · ' + esc(d.activity || '--') + ' · ' + esc(d.provider || '--') + '</div>';
    html += '<div class="runtime-process-metrics">';
    html += '<div><span>PID</span><strong>' + esc(d.pid || '--') + '</strong></div>';
    html += '<div><span>Restarts</span><strong>' + esc(String(d.restartCount || 0)) + '</strong></div>';
    html += '<div><span>Recent</span><strong>' + esc(String(d.recentRestartCount || 0)) + '</strong></div>';
    html += '<div><span>Last Restart</span><strong>' + esc(lastRestart) + '</strong></div>';
    html += '<div><span>Last Crash</span><strong>' + esc(lastCrash) + '</strong></div>';
    html += '<div><span>Session</span><strong>' + esc(d.sessionId || '--') + '</strong></div>';
    html += '</div>';
    if (d.lastRestartReason || d.lastCrashReason || d.personaRole) {
      html += '<div class="runtime-process-note">';
      if (d.lastRestartReason) html += '<span>restart: ' + esc(d.lastRestartReason) + '</span>';
      if (d.lastCrashReason) html += '<span>crash: ' + esc(d.lastCrashReason) + '</span>';
      if (d.personaRole) html += '<span>persona: ' + esc(d.personaRole) + '</span>';
      html += '</div>';
    }
    html += '<div class="panel-actions runtime-process-actions">';
    html += '<button class="chat-msg-action" onclick="copyRuntimeDirectorJson(\'' + jsq(d.label || 'main') + '\')">Copy JSON</button>';
    html += '<button class="chat-msg-action" onclick="exportRuntimeDirectorJson(\'' + jsq(d.label || 'main') + '\')">Export JSON</button>';
    html += '<button class="chat-msg-action" onclick="createTaskFromRuntimeDirector(\'' + jsq(d.label || 'main') + '\')">Create Task</button>';
    if (d.sessionId) html += '<button class="chat-msg-action" onclick="openRuntimeDirectorSession(\'' + jsq(d.label || 'main') + '\')">Open Session</button>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  function runtimeActiveWorkItems(sys, poolData, act, mainQueue) {
    var items = [];
    var mainCurrent = act && act.currentMessage || null;
    if (mainCurrent && mainCurrent.preview) {
      items.push({
        id: 'main-current',
        kind: 'current',
        label: 'main',
        name: 'Main Director',
        state: act && act.state || 'processing',
        preview: mainCurrent.preview || '',
        elapsedMs: mainCurrent.elapsedMs,
        startedAt: mainCurrent.startedAt || null,
        sessionId: sys && sys.sessionId || '',
        queueIndex: null,
        payload: mainCurrent,
      });
    }
    var queue = mainQueue || [];
    for (var qi = 0; qi < queue.length; qi++) {
      var item = queue[qi];
      items.push({
        id: 'main-queue-' + (item.correlationId || qi),
        kind: item.cancelled ? 'cancelled' : 'queued',
        label: 'main',
        name: 'Main Director',
        state: item.cancelled ? 'cancelled' : 'queued',
        preview: item.preview || item.text || '',
        elapsedMs: item.timestamp ? Date.now() - item.timestamp : null,
        startedAt: item.timestamp || null,
        sessionId: sys && sys.sessionId || '',
        correlationId: item.correlationId || '',
        messageId: item.messageId || '',
        queueIndex: qi,
        payload: item,
      });
    }
    var pool = poolData || [];
    for (var pi = 0; pi < pool.length; pi++) {
      var p = pool[pi];
      if (!p || p.closed) continue;
      var current = p.currentMessage || null;
      if (current && current.preview) {
        items.push({
          id: (p.label || 'pool') + '-current',
          kind: 'current',
          label: p.label || '',
          name: p.groupName || p.label || 'Pool Director',
          state: p.activity || 'processing',
          preview: current.preview || '',
          elapsedMs: current.elapsedMs,
          startedAt: current.startedAt || null,
          sessionId: p.sessionId || '',
          queueIndex: null,
          payload: current,
        });
      }
      var poolQueue = p.queue || [];
      for (var pqi = 0; pqi < poolQueue.length; pqi++) {
        var pq = poolQueue[pqi];
        items.push({
          id: (p.label || 'pool') + '-queue-' + (pq.correlationId || pqi),
          kind: pq.cancelled ? 'cancelled' : 'queued',
          label: p.label || '',
          name: p.groupName || p.label || 'Pool Director',
          state: pq.cancelled ? 'cancelled' : 'queued',
          preview: pq.preview || pq.text || '',
          elapsedMs: pq.timestamp ? Date.now() - pq.timestamp : null,
          startedAt: pq.timestamp || null,
          sessionId: p.sessionId || '',
          correlationId: pq.correlationId || '',
          messageId: pq.messageId || '',
          queueIndex: pqi,
          payload: pq,
        });
      }
    }
    return items.sort(function(a, b) {
      var ak = a.kind === 'current' ? 0 : 1;
      var bk = b.kind === 'current' ? 0 : 1;
      if (ak !== bk) return ak - bk;
      return Number(a.startedAt || 0) - Number(b.startedAt || 0);
    });
  }

  function activeWorkBadgeClass(item) {
    if (!item) return 'pending';
    if (item.kind === 'current') return 'running';
    if (item.kind === 'cancelled') return 'cancelled';
    return 'pending';
  }

  function activeWorkPayload() {
    var sys = data && data.system || {};
    var act = data && data.activity || {};
    var items = runtimeActiveWorkItems(sys, data && data.pool || [], act, data && data.queue || []);
    return {
      exportedAt: new Date().toISOString(),
      summary: {
        active: items.filter(function(item) { return item.kind === 'current'; }).length,
        queued: items.filter(function(item) { return item.kind === 'queued'; }).length,
        cancelled: items.filter(function(item) { return item.kind === 'cancelled'; }).length,
      },
      items: items,
    };
  }

  function activeWorkItemById(id) {
    var items = activeWorkPayload().items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return items[i];
    }
    return null;
  }

  function renderRuntimeActiveWorkPanel(sys, poolData, act, queue) {
    var items = runtimeActiveWorkItems(sys, poolData, act, queue);
    var currentCount = items.filter(function(item) { return item.kind === 'current'; }).length;
    var queuedCount = items.filter(function(item) { return item.kind === 'queued'; }).length;
    var html = '<div class="workbench-panel wide runtime-active-work-panel">';
    html += '<div class="panel-title"><span>Active Work</span><div class="panel-actions"><span class="muted mono">' + currentCount + ' running · ' + queuedCount + ' queued</span>';
    html += '<button class="mini-btn" onclick="copyRuntimeActiveWork()">Copy Work</button>';
    html += '<button class="mini-btn" onclick="exportRuntimeActiveWork()">Export Work</button>';
    html += '</div></div>';
    if (!items.length) {
      html += '<div class="empty compact">No active or queued Director messages.</div></div>';
      return html;
    }
    html += '<div class="runtime-active-work-list">';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var elapsed = item.elapsedMs != null ? fmtDur(item.elapsedMs) : '--';
      var rowDomId = 'runtime-active-work-row-' + safeAssetName(item.id, 'work');
      var rowClass = 'runtime-active-work-row' + (item.kind === 'cancelled' ? ' cancelled' : '') + (item.id === runtimeActiveWorkFocusId ? ' focused' : '');
      html += '<div id="' + esc(rowDomId) + '" class="' + rowClass + '">';
      html += '<span class="badge ' + activeWorkBadgeClass(item) + '">' + esc(item.kind) + '</span>';
      html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(item.preview || '--') + '</div>';
      html += '<div class="panel-row-sub">' + esc(item.name || item.label || '--') + ' · ' + esc(item.state || '--') + ' · ' + esc(elapsed) + (item.correlationId ? ' · ' + esc(item.correlationId) : '') + '</div></div>';
      html += '<div class="panel-actions">';
      html += '<button class="chat-msg-action" onclick="openRuntimeActiveWorkDirector(\'' + jsq(item.id) + '\')">Open Director</button>';
      if (item.sessionId) html += '<button class="chat-msg-action" onclick="openRuntimeActiveWorkSession(\'' + jsq(item.id) + '\')">Open Session</button>';
      html += '<button class="chat-msg-action" onclick="copyRuntimeActiveWorkItem(\'' + jsq(item.id) + '\')">Copy</button>';
      html += '<button class="chat-msg-action" onclick="exportRuntimeActiveWorkItem(\'' + jsq(item.id) + '\')">Export</button>';
      html += '<button class="chat-msg-action" onclick="createTaskFromRuntimeActiveWorkItem(\'' + jsq(item.id) + '\')">Create Task</button>';
      if (item.kind === 'queued' && item.correlationId) {
        html += '<button class="chat-msg-action danger" onclick="cancelRuntimeActiveWorkItem(\'' + jsq(item.id) + '\')">Cancel</button>';
      }
      html += '</div></div>';
    }
    html += '</div></div>';
    return html;
  }

  function contextMetricRows() {
    var rows = [];
    var ctx = data && data.context || {};
    rows.push({
      label: 'main',
      name: 'Main Director',
      commandLabel: 'main',
      tokens: ctx.tokens,
      observedTokens: ctx.observedTokens,
      contextTokens: ctx.contextTokens,
      limit: ctx.limit,
      percent: ctx.percent,
      live: ctx.live !== false,
      lastFlushAgoMs: ctx.lastFlushAgoMs,
      flushLimit: ctx.flushLimit,
      contextWindow: ctx.contextWindow,
      autoFlushDisabled: !!ctx.autoFlushDisabled,
    });
    var pool = data && data.pool || [];
    for (var i = 0; i < pool.length; i++) {
      var p = pool[i];
      if (!p || !p.context || p.closed) continue;
      var pc = p.context || {};
      var limit = pc.limit || 0;
      var tokens = pc.tokens;
      var observed = pc.observedTokens;
      var contextTokens = pc.contextTokens;
      var calcTokens = tokens != null ? tokens : (observed != null ? observed : contextTokens);
      rows.push({
        label: p.groupName || p.label || 'pool',
        name: p.groupName || p.label || 'Pool Director',
        commandLabel: p.label || '',
        tokens: tokens,
        observedTokens: observed,
        contextTokens: contextTokens,
        limit: limit,
        percent: limit > 0 && calcTokens != null ? Math.round((calcTokens / limit) * 100) : 0,
        live: pc.live !== false,
        lastFlushAgoMs: pc.lastFlushAgoMs,
        flushLimit: pc.flushLimit,
        contextWindow: pc.contextWindow,
        autoFlushDisabled: !!pc.autoFlushDisabled,
      });
    }
    return rows.slice(0, 12);
  }

  function contextRowTokens(row) {
    if (row.tokens != null) return row.tokens;
    if (row.observedTokens != null) return row.observedTokens;
    if (row.contextTokens != null) return row.contextTokens;
    return null;
  }

  function contextRowPercent(row) {
    var limit = Number(row.limit || 0);
    var tokens = contextRowTokens(row);
    if (limit <= 0 || tokens == null) return 0;
    return Math.max(0, Math.round((Number(tokens) / limit) * 100));
  }

  function contextHealthState(row) {
    var pct = contextRowPercent(row);
    if (!row.live) return { label: 'stale', badge: 'pending', level: 'stale', note: 'metrics are cached or unavailable' };
    if (pct >= 95) return { label: 'critical', badge: 'failed', level: 'critical', note: 'context is near the model window' };
    if (pct >= 80) return { label: 'watch', badge: 'pending', level: 'watch', note: 'context is approaching the window' };
    if (row.autoFlushDisabled) return { label: 'manual', badge: 'pending', level: 'manual', note: 'auto flush is disabled' };
    return { label: 'live', badge: 'ok', level: 'ok', note: 'live context metrics available' };
  }

  function contextHealthPayload() {
    var rows = contextMetricRows();
    var liveCount = rows.filter(function(row) { return row.live; }).length;
    var staleCount = rows.length - liveCount;
    var disabledCount = rows.filter(function(row) { return row.autoFlushDisabled; }).length;
    var highest = rows.reduce(function(best, row) {
      return !best || contextRowPercent(row) > contextRowPercent(best) ? row : best;
    }, null);
    return {
      exportedAt: new Date().toISOString(),
      summary: {
        total: rows.length,
        live: liveCount,
        stale: staleCount,
        autoFlushDisabled: disabledCount,
        highestUsage: highest ? {
          label: highest.label,
          name: highest.name,
          percent: contextRowPercent(highest),
          tokens: contextRowTokens(highest),
          limit: highest.limit || 0,
          state: contextHealthState(highest),
        } : null,
      },
      rows: rows.map(function(row) {
        return Object.assign({}, row, {
          tokensEffective: contextRowTokens(row),
          percentEffective: contextRowPercent(row),
          state: contextHealthState(row),
        });
      }),
    };
  }

  function contextHealthRowPayload(index) {
    var report = contextHealthPayload();
    var row = report.rows[index] || null;
    return {
      exportedAt: new Date().toISOString(),
      index: index,
      row: row,
      report: report,
      runtime: {
        tasks: data && data.tasks && data.tasks.summary || null,
        directors: runtimeDirectorSnapshots(data && data.system || {}, data && data.pool || [], data && data.activity || {}),
      },
    };
  }

  function contextHealthTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench context health handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate context/cache live state before changing runtime behavior.',
      '- Review live/stale status, context window usage, flush limit, last flush age, auto-flush state, and related Director snapshot.',
      '- If context is stale, near the window, or auto flush is disabled unexpectedly, identify the likely cause and propose or implement a scoped fix.',
      '- Preserve runtime safety boundaries; flush/clear/restart actions should still go through the existing approval paths.',
      '',
      'Context health handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function createTaskFromContextHealthPayload(payload, description, sourceDirector) {
    if (!payload) {
      showToast('Context health evidence not found', false);
      return;
    }
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: sourceDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: shortText(description || 'Investigate context health', 120),
      prompt: contextHealthTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Context health handoff loaded into task form', true);
  }

  function renderRuntimeContextHealthPanel() {
    var rows = contextMetricRows();
    var liveCount = rows.filter(function(row) { return row.live; }).length;
    var staleCount = rows.length - liveCount;
    var disabledCount = rows.filter(function(row) { return row.autoFlushDisabled; }).length;
    var highest = rows.reduce(function(best, row) {
      return !best || contextRowPercent(row) > contextRowPercent(best) ? row : best;
    }, null);
    var highestPct = highest ? contextRowPercent(highest) : 0;
    var html = '<div class="workbench-panel wide context-health-panel">';
    html += '<div class="panel-title"><span>Context Health</span><div class="panel-actions"><span>' + liveCount + '/' + rows.length + ' live</span>';
    html += '<button class="mini-btn" onclick="copyContextHealthReport()">Copy Report</button>';
    html += '<button class="mini-btn" onclick="exportContextHealthReport()">Export Report</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromContextHealthReport()">Create Task</button>';
    html += '</div></div>';
    html += '<div class="context-health-summary">';
    html += '<div><span>Highest Usage</span><strong>' + esc(highest ? highest.label : '--') + '</strong><em>' + highestPct + '%</em></div>';
    html += '<div><span>Stale Metrics</span><strong>' + staleCount + '</strong><em>' + (staleCount ? 'needs traffic' : 'fresh') + '</em></div>';
    html += '<div><span>Auto Flush Off</span><strong>' + disabledCount + '</strong><em>' + (disabledCount ? 'manual watch' : 'enabled') + '</em></div>';
    html += '</div>';
    html += '<div class="context-health-list">';
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var state = contextHealthState(row);
      var pct = Math.min(100, contextRowPercent(row));
      var source = row.contextWindow > 0 ? 'model window' : 'flush limit';
      var tokenLabel = fmtTokens(contextRowTokens(row)) + ' / ' + fmtTokens(row.limit);
      html += '<div class="context-health-row ' + esc(state.level) + '">';
      html += '<div class="context-health-main"><span class="badge ' + esc(state.badge) + '">' + esc(state.label) + '</span><div class="panel-row-main">';
      html += '<div class="rate-row-head"><span>' + esc(row.name || row.label) + '</span><strong>' + (row.live ? pct + '%' : 'stale') + '</strong></div>';
      html += '<div class="rate-bar"><i style="width:' + pct + '%"></i></div>';
      html += '<div class="panel-row-sub">' + esc(tokenLabel) + ' · ' + esc(source) + ' · flush ' + esc(row.lastFlushAgoMs != null ? fmtAgoMs(row.lastFlushAgoMs) : '--') + '</div>';
      html += '<div class="context-health-note">' + esc(state.note) + (row.autoFlushDisabled ? ' · auto flush disabled' : '') + '</div>';
      html += '</div></div>';
      html += '<div class="panel-actions">';
      if (row.commandLabel === 'main') {
        html += '<button class="mini-btn" onclick="doCmd(\'flush\')">Flush</button>';
      } else if (row.commandLabel) {
        html += '<button class="mini-btn" onclick="runRuntimeDirectorCommand(\'' + jsq(row.commandLabel) + '\',\'flush\',\'' + jsq(row.name || row.label) + '\')">Flush</button>';
      }
      html += '<button class="mini-btn primary" onclick="createTaskFromContextHealthRow(' + i + ')">Create Task</button>';
      html += '</div></div>';
    }
    html += '</div></div>';
    return html;
  }

  function runtimeContextDirectors(sys, poolData) {
    var summary = settingsData.summary || {};
    var providers = summary.agents && summary.agents.providers || {};
    var personaDir = summary.director && summary.director.personaDir || '--';
    var directors = [{ label: 'main', name: 'Main Director', provider: sys.directorAgentName || '', role: sys.personaRole || 'director' }];
    for (var i = 0; i < (poolData || []).length; i++) {
      var p = poolData[i];
      if (p.closed) continue;
      directors.push({ label: p.label || '', name: p.groupName || p.label || 'Pool Director', provider: p.directorAgentName || '', role: p.personaRole || 'director' });
    }
    return directors.map(function(director) {
      var provider = providers[director.provider] || {};
      return Object.assign({}, director, {
        cwd: provider.cwd || personaDir,
        providerConfig: {
          type: provider.type || '',
          model: provider.model || '',
          cwd: provider.cwd || '',
          systemPromptFile: provider.systemPromptFile || '',
          agentFile: provider.agentFile || '',
        },
      });
    });
  }

  function runtimeContextPayload() {
    var sys = data && data.system || {};
    var poolData = data && data.pool || [];
    var mcpConfigs = configAssetsData.mcpConfigs || [];
    var promptFiles = runtimePromptFiles();
    return {
      exportedAt: new Date().toISOString(),
      directors: runtimeContextDirectors(sys, poolData),
      promptFiles: promptFiles,
      mcpConfigs: mcpConfigs,
      mcpServerCount: mcpConfigs.reduce(function(sum, cfg) { return sum + ((cfg.servers || []).length); }, 0),
      promptBundleRole: runtimeContextData.role || null,
      loading: {
        settings: !!settingsData.loading,
        configAssets: !!configAssetsData.loading,
        promptBundle: !!runtimeContextData.loading,
      },
      errors: {
        settings: settingsData.error || null,
        configAssets: configAssetsData.error || null,
        promptBundle: runtimeContextData.error || null,
      },
    };
  }

  function runtimeContextItemPayload(kind, index) {
    var payload = runtimeContextPayload();
    var item = null;
    if (kind === 'director') item = payload.directors[index] || null;
    else if (kind === 'promptFile') item = payload.promptFiles[index] || null;
    else if (kind === 'mcpConfig') item = payload.mcpConfigs[index] || null;
    return {
      exportedAt: new Date().toISOString(),
      kind: kind,
      index: index,
      item: item,
      report: payload,
      contextHealth: contextHealthPayload(),
      processMonitor: runtimeProcessesPayload(),
    };
  }

  function runtimeContextTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench runtime context handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate runtime context configuration before changing behavior.',
      '- Review Director cwd/provider/role, prompt injection files, MCP config status, context health, and process monitor evidence.',
      '- If a cwd, prompt file, MCP config, provider setting, or role binding looks wrong or missing, identify the likely cause and propose or implement a scoped fix.',
      '- Preserve existing runtime semantics, provider choices, and MCP server behavior unless the task prompt is edited.',
      '',
      'Runtime context handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function createTaskFromRuntimeContextPayload(payload, description, sourceDirector) {
    if (!payload) {
      showToast('Runtime context evidence not found', false);
      return;
    }
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: sourceDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: shortText(description || 'Investigate runtime context', 120),
      prompt: runtimeContextTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Runtime context handoff loaded into task form', true);
  }

  function renderRuntimeContextPanel(sys, poolData) {
    var mcpConfigs = configAssetsData.mcpConfigs || [];
    var mcpServerCount = mcpConfigs.reduce(function(sum, cfg) { return sum + ((cfg.servers || []).length); }, 0);
    var promptFiles = runtimePromptFiles();
    var directors = runtimeContextDirectors(sys, poolData);

    var html = '<div class="workbench-panel wide runtime-context-panel">';
    html += '<div class="panel-title"><span>Runtime Context</span><div class="panel-actions"><span>' + mcpServerCount + ' MCP servers</span>';
    html += '<button class="mini-btn" onclick="copyRuntimeContextReport()">Copy Report</button>';
    html += '<button class="mini-btn" onclick="exportRuntimeContextReport()">Export Report</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromRuntimeContextReport()">Create Task</button>';
    html += '<button class="mini-btn" onclick="refreshRuntimeContext()">Refresh</button></div></div>';
    if (settingsData.loading || configAssetsData.loading || runtimeContextData.loading) {
      html += '<div class="td-result-running"><div class="spinner"></div><span>Loading runtime context...</span></div>';
    }
    if (settingsData.error || configAssetsData.error || runtimeContextData.error) {
      html += '<div class="td-error compact">' + esc(settingsData.error || configAssetsData.error || runtimeContextData.error) + '</div>';
    }
    html += '<div class="runtime-context-grid">';
    html += '<div class="runtime-context-block"><div class="diagnostic-section-title">Workspace CWD</div>';
    html += '<div class="runtime-context-list">';
    for (var d = 0; d < directors.length; d++) {
      var director = directors[d];
      html += '<div class="runtime-context-row"><span class="badge pending">' + esc(director.label || 'main') + '</span><div class="panel-row-main">';
      html += '<div class="panel-row-title">' + esc(director.name || director.label || 'Director') + '</div>';
      html += '<div class="panel-row-sub">provider ' + esc(director.provider || '--') + ' · role ' + esc(director.role || '--') + '</div>';
      html += '<div class="file-path mono">' + esc(director.cwd || '--') + '</div></div>';
      html += '<div class="panel-actions"><button class="chat-msg-action" onclick="createTaskFromRuntimeContextDirector(' + d + ')">Create Task</button></div></div>';
    }
    html += '</div></div>';

    html += '<div class="runtime-context-block"><div class="diagnostic-section-title">Prompt Injection Files</div>';
    html += '<div class="runtime-context-list">';
    if (!promptFiles.length) {
      html += '<div class="empty compact">No prompt bundle files loaded yet.</div>';
    } else {
      for (var pf = 0; pf < promptFiles.length; pf++) {
        html += '<div class="runtime-context-row"><span class="badge completed">' + esc(promptFiles[pf].kind) + '</span><div class="panel-row-main">';
        html += '<div class="panel-row-title">' + esc(promptFiles[pf].name) + '</div><div class="file-path mono">' + esc(promptFiles[pf].path) + '</div></div>';
        html += '<div class="panel-actions"><button class="chat-msg-action" onclick="createTaskFromRuntimeContextPromptFile(' + pf + ')">Create Task</button></div></div>';
      }
    }
    var activeProvider = (directors[0] && directors[0].providerConfig) || {};
    if (activeProvider.systemPromptFile || activeProvider.agentFile) {
      html += '<div class="runtime-context-note">';
      if (activeProvider.systemPromptFile) html += '<span>provider system prompt: ' + esc(activeProvider.systemPromptFile) + '</span>';
      if (activeProvider.agentFile) html += '<span>agent file: ' + esc(activeProvider.agentFile) + '</span>';
      html += '</div>';
    }
    html += '</div></div>';

    html += '<div class="runtime-context-block"><div class="diagnostic-section-title">MCP Config Status</div>';
    html += '<div class="runtime-context-list">';
    if (!mcpConfigs.length) {
      html += '<div class="empty compact">No MCP config files found.</div>';
    } else {
      for (var mi = 0; mi < mcpConfigs.length; mi++) {
        var cfg = mcpConfigs[mi];
        var servers = cfg.servers || [];
        html += '<div class="runtime-context-row"><span class="badge ' + (cfg.exists ? 'completed' : 'cancelled') + '">' + (cfg.exists ? 'found' : 'missing') + '</span><div class="panel-row-main">';
        html += '<div class="panel-row-title">' + esc(cfg.label || 'mcp') + ' · ' + servers.length + ' servers</div>';
        html += '<div class="file-path mono">' + esc(cfg.path || '--') + '</div>';
        if (cfg.parseError) html += '<div class="td-error compact">' + esc(cfg.parseError) + '</div>';
        if (servers.length) {
          html += '<div class="runtime-mcp-server-strip">';
          for (var si = 0; si < Math.min(servers.length, 8); si++) {
            var server = servers[si];
            html += '<span class="badge ' + (server.disabled ? 'cancelled' : 'completed') + '">' + esc(server.name || '--') + '</span>';
          }
          if (servers.length > 8) html += '<span class="muted">+' + (servers.length - 8) + '</span>';
          html += '</div>';
        }
        html += '</div><div class="panel-actions"><button class="chat-msg-action" onclick="createTaskFromRuntimeContextMcpConfig(' + mi + ')">Create Task</button></div></div>';
      }
    }
    html += '</div></div></div></div>';
    return html;
  }

  function runtimePromptFiles() {
    var bundle = runtimeContextData.promptBundle;
    var files = [];
    if (!bundle || !bundle.files) return files;
    var base = bundle.files.base || [];
    var developer = bundle.files.developer || [];
    for (var i = 0; i < base.length; i++) files.push({ kind: 'base', path: base[i], name: base[i].split('/').pop() || base[i] });
    for (var j = 0; j < developer.length; j++) files.push({ kind: 'dev', path: developer[j], name: developer[j].split('/').pop() || developer[j] });
    return files;
  }

  window.refreshRuntimeContext = function() {
    settingsData.summary = null;
    settingsData.error = null;
    configAssetsData.configFiles = [];
    configAssetsData.mcpConfigs = [];
    configAssetsData.skills = [];
    configAssetsData.error = null;
    runtimeContextData.promptBundle = null;
    runtimeContextData.error = null;
    loadRuntimeControlMeta();
  };

  function renderRuntimeSwitchControls(label, agent, role, prefix) {
    var safeLabel = label || 'main';
    var html = '<div class="runtime-switch-controls" onclick="event.stopPropagation()">';
    html += '<label><span>Provider</span><select id="' + esc(prefix) + '-agent">' + providerOptionsHtml(agent) + '</select></label>';
    html += '<button class="mini-btn" onclick="switchRuntimeAgent(\'' + jsq(safeLabel) + '\',\'' + jsq(prefix) + '-agent\')">Switch Provider</button>';
    html += '<label><span>Persona</span><select id="' + esc(prefix) + '-role">' + personaRoleOptionsHtml(role) + '</select></label>';
    html += '<button class="mini-btn" onclick="switchRuntimePersona(\'' + jsq(safeLabel) + '\',\'' + jsq(prefix) + '-role\')">Switch Role</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromRuntimeSwitchIntent(\'' + jsq(safeLabel) + '\',\'' + jsq(prefix) + '\')">Create Task</button>';
    if (settingsData.loading) html += '<span class="muted">loading config...</span>';
    else if (settingsData.error) html += '<span class="muted">config unavailable</span>';
    html += '</div>';
    return html;
  }

  function renderRuntimeDirectorCommandActions(label, name) {
    var safeLabel = label || '';
    var safeName = name || label || '';
    var html = '<div class="panel-actions runtime-director-actions" onclick="event.stopPropagation()">';
    html += '<button class="mini-btn primary" onclick="createTaskFromPoolDirector(\'' + jsq(safeLabel) + '\')">Create Task</button>';
    html += '<button class="mini-btn" onclick="runRuntimeDirectorCommand(\'' + jsq(safeLabel) + '\',\'flush\',\'' + jsq(safeName) + '\')">Flush</button>';
    html += '<button class="mini-btn danger" onclick="runRuntimeDirectorCommand(\'' + jsq(safeLabel) + '\',\'clear\',\'' + jsq(safeName) + '\')">Clear</button>';
    html += '<button class="mini-btn" onclick="runRuntimeDirectorCommand(\'' + jsq(safeLabel) + '\',\'esc\',\'' + jsq(safeName) + '\')">Esc</button>';
    html += '<button class="mini-btn" onclick="runRuntimeDirectorCommand(\'' + jsq(safeLabel) + '\',\'restart\',\'' + jsq(safeName) + '\')">Restart</button>';
    html += '<button class="mini-btn danger" onclick="runRuntimeDirectorCommand(\'' + jsq(safeLabel) + '\',\'detach\',\'' + jsq(safeName) + '\')">Detach</button>';
    html += '<button class="mini-btn danger" onclick="shutdownRuntimeDirector(\'' + jsq(safeLabel) + '\',\'' + jsq(safeName) + '\')">Shutdown</button>';
    html += '</div>';
    return html;
  }

  function poolDirectorByLabel(label) {
    var pool = data && data.pool || [];
    for (var i = 0; i < pool.length; i++) {
      if (pool[i] && pool[i].label === label) return pool[i];
    }
    return null;
  }

  function poolDirectorHandoffPayload(label) {
    var poolItem = poolDirectorByLabel(label);
    var process = runtimeDirectorByLabel(label);
    var activeWork = activeWorkPayload();
    var contextRows = contextHealthPayload().rows || [];
    var runtimeContext = runtimeContextPayload();
    return {
      exportedAt: new Date().toISOString(),
      label: label,
      poolDirector: poolItem,
      process: process,
      activeWork: {
        summary: activeWork.summary || null,
        items: (activeWork.items || []).filter(function(item) { return item && item.label === label; }),
      },
      contextHealth: contextRows.filter(function(row) { return row && row.commandLabel === label; })[0] || null,
      runtimeContext: {
        director: (runtimeContext.directors || []).filter(function(item) { return item && item.label === label; })[0] || null,
        promptFiles: runtimeContext.promptFiles || [],
        mcpServerCount: runtimeContext.mcpServerCount || 0,
      },
      commandSurface: {
        available: poolItem && !poolItem.closed ? ['flush', 'clear', 'esc', 'restart', 'detach', 'shutdown', 'switch-provider', 'switch-role'] : [],
        safety: 'High-impact commands are gated by the existing approval queue.',
      },
      snapshot: runtimeSnapshotPayload(),
    };
  }

  function poolDirectorTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench Pool Director handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate this specific Pool Director before changing runtime behavior.',
      '- Review pool row state, process health, queue/current work, provider/persona binding, context health, runtime context, and available command surface.',
      '- If the Director is closed, stale, crash-prone, queue-backed-up, misconfigured, or on the wrong provider/persona, identify the likely cause and propose or implement a scoped fix.',
      '- Preserve runtime safety boundaries; flush/clear/restart/detach/shutdown/provider/persona switch actions should still go through existing approval paths.',
      '',
      'Pool Director handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromPoolDirector = function(label) {
    var payload = poolDirectorHandoffPayload(label);
    if (!payload.poolDirector) {
      showToast('Pool Director not found', false);
      return;
    }
    var item = payload.poolDirector;
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: item.label || label || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate Pool Director: ' + (item.groupName || item.label || 'Director') + ' · ' + (item.activity || (item.closed ? 'closed' : 'idle')) + ' · queue ' + String(item.queueLength || 0),
      prompt: poolDirectorTaskPromptPayload({
        type: 'poolDirector',
        evidence: payload,
      }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Pool Director handoff loaded into task form', true);
  };

  function runtimeOperationTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench runtime operation handoff as task context.',
      '',
      'Operator intent:',
      '- Review this runtime operation intent before changing Director state.',
      '- Compare current Director process, provider/persona binding, queue/current work, context health, runtime context, and selected command or switch target.',
      '- If the requested command or provider/persona switch is risky, stale, or likely to fail, identify the likely issue and propose or implement a scoped fix.',
      '- Preserve runtime safety boundaries; actual flush/clear/restart/detach/shutdown/provider/persona switch actions should still go through existing approval paths.',
      '',
      'Runtime operation handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function runtimeOperationDirectorEvidence(label) {
    var safeLabel = label || 'main';
    return {
      label: safeLabel,
      poolDirector: safeLabel === 'main' ? null : poolDirectorByLabel(safeLabel),
      process: runtimeDirectorByLabel(safeLabel),
      activeWork: activeWorkPayload(),
      contextHealth: contextHealthPayload(),
      runtimeContext: runtimeContextPayload(),
      snapshot: snapshotReportPayload(),
    };
  }

  function createTaskFromRuntimeOperationPayload(payload, description, sourceDirector) {
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: sourceDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: shortText(description || 'Review runtime operation intent', 120),
      prompt: runtimeOperationTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Runtime operation handoff loaded into task form', true);
  }

  window.createTaskFromRuntimeCommandSurface = function(label) {
    var safeLabel = label || 'main';
    var evidence = runtimeOperationDirectorEvidence(safeLabel);
    createTaskFromRuntimeOperationPayload({
      type: 'runtimeCommandSurface',
      intent: {
        director: safeLabel,
        availableCommands: safeLabel === 'main'
          ? ['flush', 'clear', 'esc', 'session-restart']
          : ['flush', 'clear', 'esc', 'restart', 'detach', 'shutdown'],
        safety: 'Commands remain gated by the existing approval queue.',
      },
      evidence: evidence,
    }, 'Review runtime command surface: ' + safeLabel, safeLabel);
  };

  window.createTaskFromRuntimeSwitchIntent = function(label, prefix) {
    var safeLabel = label || 'main';
    var agentSelect = $(String(prefix || '') + '-agent');
    var roleSelect = $(String(prefix || '') + '-role');
    var process = runtimeDirectorByLabel(safeLabel) || {};
    var targetAgent = agentSelect ? agentSelect.value : '';
    var targetRole = roleSelect ? roleSelect.value : '';
    createTaskFromRuntimeOperationPayload({
      type: 'runtimeSwitchIntent',
      intent: {
        director: safeLabel,
        currentProvider: process.provider || '',
        targetProvider: targetAgent,
        currentPersonaRole: process.personaRole || '',
        targetPersonaRole: targetRole,
        willCheckpointContext: true,
        safety: 'Switch actions remain gated by the existing approval queue.',
      },
      evidence: runtimeOperationDirectorEvidence(safeLabel),
    }, 'Review runtime switch: ' + safeLabel + ' -> ' + (targetAgent || process.provider || '--') + ' / ' + (targetRole || process.personaRole || '--'), safeLabel);
  };

  window.switchRuntimeAgent = async function(label, selectId) {
    var select = $(selectId);
    var agent = select ? select.value : '';
    if (!agent) {
      showToast('Provider is required', false);
      return;
    }
    queueDangerApproval({
      title: 'Switch Director provider',
      target: label + ' -> ' + agent,
      detail: 'Current context will be checkpointed before the provider switch.',
      severity: 'medium',
      payload: { director_label: label, agent: agent },
    }, async function() {
    try {
      var res = await fetch('/api/directors/switch-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ director_label: label, agent: agent }),
      });
      var body = await res.json().catch(function() { return {}; });
      if (!res.ok || body.error || body.ok === false) throw new Error(body.error || 'switch provider failed');
      showToast('Provider switched: ' + (body.agent || agent), true);
    } catch (err) {
      showToast('Switch failed: ' + err.message, false);
      throw err;
    }
    });
  };

  window.switchRuntimePersona = async function(label, selectId) {
    var select = $(selectId);
    var role = select ? select.value : '';
    if (!role) {
      showToast('Persona role is required', false);
      return;
    }
    queueDangerApproval({
      title: 'Switch Director persona',
      target: label + ' -> ' + role,
      detail: 'Current context will be checkpointed before the persona switch.',
      severity: 'medium',
      payload: { director_label: label, role: role },
    }, async function() {
    try {
      var res = await fetch('/api/directors/switch-persona', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ director_label: label, role: role }),
      });
      var body = await res.json().catch(function() { return {}; });
      if (!res.ok || body.error || body.ok === false) throw new Error(body.error || 'switch persona failed');
      showToast('Persona switched: ' + (body.role || role), true);
    } catch (err) {
      showToast('Switch failed: ' + err.message, false);
      throw err;
    }
    });
  };

  window.runRuntimeDirectorCommand = async function(label, command, name) {
    if (!label || label === 'main') {
      showToast('Use the Main Director controls for main commands', false);
      return;
    }
    var display = name || label;
    var prompts = {
      flush: 'Flush Pool Director "' + display + '"? Progress will be checkpointed.',
      clear: 'Clear Pool Director "' + display + '"? Current context will NOT be saved.',
      esc: 'Cancel the oldest queued message for "' + display + '"?',
      restart: 'Restart Pool Director "' + display + '"? In-flight processing will be interrupted.',
      detach: 'Detach Pool Director "' + display + '"? The underlying process will be left running but removed from this console.',
    };
    if (prompts[command]) {
      queueDangerApproval({
        title: 'Pool Director command: ' + command,
        target: display,
        detail: prompts[command],
        severity: command === 'flush' ? 'medium' : 'high',
        payload: { director_label: label, command: command, display: display },
      }, async function() {
        await executeRuntimeDirectorCommand(label, command, display);
      });
      return;
    }
    await executeRuntimeDirectorCommand(label, command, display);
  };

  async function executeRuntimeDirectorCommand(label, command, display) {
    try {
      var res = await fetch('/api/directors/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ director_label: label, command: command }),
      });
      var body = await res.json().catch(function() { return {}; });
      if (!res.ok || body.error || body.ok === false) throw new Error(body.error || body.message || 'command failed');
      showToast(body.message || 'Director command completed', true);
    } catch (err) {
      showToast('Command failed: ' + err.message, false);
      throw err;
    }
  }

  window.shutdownRuntimeDirector = async function(label, name) {
    if (!label || label === 'main') {
      showToast('Only Pool Directors can be shut down here', false);
      return;
    }
    var display = name || label;
    queueDangerApproval({
      title: 'Shutdown Pool Director',
      target: display,
      detail: 'Running process and queued work for this Director will stop.',
      severity: 'critical',
      payload: { director_label: label, display: display },
    }, async function() {
    try {
      var res = await fetch('/api/directors/shutdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ director_label: label }),
      });
      var body = await res.json().catch(function() { return {}; });
      if (!res.ok || body.error || body.ok === false) throw new Error(body.error || 'shutdown failed');
      showToast('Director shut down: ' + display, true);
    } catch (err) {
      showToast('Shutdown failed: ' + err.message, false);
      throw err;
    }
    });
  };

  function renderRuntimeQueue(queue) {
    if (!queue || queue.length === 0) return '<div class="empty">No queued messages</div>';
    var html = '<div class="panel-list runtime-queue-list">';
    for (var i = 0; i < queue.length; i++) {
      var item = queue[i];
      html += '<div class="panel-row runtime-queue-row' + (item.cancelled ? ' cancelled' : '') + '">';
      html += '<span class="badge ' + (item.cancelled ? 'cancelled' : 'pending') + '">' + (item.cancelled ? 'cancelled' : 'queued') + '</span>';
      html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(item.preview || item.text || '--') + '</div>';
      html += '<div class="panel-row-sub">' + esc(item.correlationId || '--') + ' · ' + esc(item.messageId || '--') + ' · ' + fmtAgo(item.timestamp) + '</div></div>';
      html += '<button class="mini-btn" onclick="copyRuntimeQueueItem(\'' + jsq(item.correlationId || String(i)) + '\')">Copy</button>';
      html += '<button class="mini-btn" onclick="exportRuntimeQueueItem(\'' + jsq(item.correlationId || String(i)) + '\')">Export</button>';
      html += '<button class="mini-btn" onclick="createTaskFromRuntimeQueueItem(\'' + jsq(item.correlationId || String(i)) + '\')">Create Task</button>';
      if (!item.cancelled) {
        html += '<button class="mini-btn danger" onclick="cancelQueueItem(\'' + jsq(item.correlationId) + '\')">Cancel</button>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function runtimeQueuePayload() {
    return {
      exportedAt: new Date().toISOString(),
      queue: data && data.queue || [],
    };
  }

  function runtimeProcessesPayload() {
    var sys = data && data.system || {};
    var act = data && data.activity || {};
    return {
      exportedAt: new Date().toISOString(),
      directors: runtimeDirectorSnapshots(sys, data && data.pool || [], act),
    };
  }

  function runtimeSnapshotPayload() {
    return {
      exportedAt: new Date().toISOString(),
      system: data && data.system || null,
      activity: data && data.activity || null,
      context: data && data.context || null,
      queue: data && data.queue || [],
      pool: data && data.pool || [],
      processMonitor: runtimeProcessesPayload().directors,
      activeWork: activeWorkPayload(),
      contextHealth: contextHealthPayload(),
      runtimeContext: runtimeContextPayload(),
    };
  }

  function runtimeTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench runtime handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate or continue from the current Director runtime state.',
      '- Review processMonitor, activeWork, queue, contextHealth, and runtimeContext before acting.',
      '- If runtime operations are needed, preserve safety boundaries and use the existing UI/API paths.',
      '',
      'Runtime handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function runtimeItemTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench runtime item handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate this specific runtime work item or queued message.',
      '- Use the item payload first, then compare it with the full runtime snapshot for surrounding state.',
      '- If cancellation, retry, or Director commands are needed, preserve safety boundaries and use the existing UI/API paths.',
      '',
      'Runtime item handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.copyContextHealthReport = function() {
    copyText(JSON.stringify(contextHealthPayload(), null, 2));
  };

  window.exportContextHealthReport = function() {
    downloadTextFile('persona-context-health-' + Date.now() + '.json', JSON.stringify(contextHealthPayload(), null, 2));
    showToast('Context health report exported', true);
  };

  window.createTaskFromContextHealthReport = function() {
    var payload = contextHealthPayload();
    var summary = payload.summary || {};
    var highest = summary.highestUsage || {};
    createTaskFromContextHealthPayload({
      type: 'contextHealthReport',
      report: payload,
      runtimeContext: runtimeContextPayload(),
      snapshot: snapshotReportPayload(),
    }, 'Investigate context health: ' + String(summary.live || 0) + '/' + String(summary.total || 0) + ' live · highest ' + (highest.label || '--') + ' ' + String(highest.percent || 0) + '%', 'main');
  };

  window.createTaskFromContextHealthRow = function(index) {
    var payload = contextHealthRowPayload(index);
    if (!payload.row) {
      showToast('Context health row not found', false);
      return;
    }
    var row = payload.row;
    createTaskFromContextHealthPayload({
      type: 'contextHealthRow',
      item: payload,
      runtimeContext: runtimeContextPayload(),
      snapshot: snapshotReportPayload(),
    }, 'Investigate context health: ' + (row.name || row.label || 'context') + ' · ' + (row.state && row.state.label || 'unknown') + ' · ' + String(row.percentEffective || 0) + '%', row.commandLabel || 'main');
  };

  window.copyRuntimeContextReport = function() {
    copyText(JSON.stringify(runtimeContextPayload(), null, 2));
  };

  window.exportRuntimeContextReport = function() {
    downloadTextFile('persona-runtime-context-' + Date.now() + '.json', JSON.stringify(runtimeContextPayload(), null, 2));
    showToast('Runtime context report exported', true);
  };

  window.createTaskFromRuntimeContextReport = function() {
    var payload = runtimeContextPayload();
    createTaskFromRuntimeContextPayload({
      type: 'runtimeContextReport',
      report: payload,
      contextHealth: contextHealthPayload(),
      processMonitor: runtimeProcessesPayload(),
      snapshot: snapshotReportPayload(),
    }, 'Investigate runtime context: ' + String((payload.directors || []).length) + ' directors · ' + String((payload.promptFiles || []).length) + ' prompt files · ' + String(payload.mcpServerCount || 0) + ' MCP servers', 'main');
  };

  window.createTaskFromRuntimeContextDirector = function(index) {
    var payload = runtimeContextItemPayload('director', index);
    if (!payload.item) {
      showToast('Runtime context director not found', false);
      return;
    }
    var item = payload.item;
    createTaskFromRuntimeContextPayload({
      type: 'runtimeContextDirector',
      item: payload,
      snapshot: snapshotReportPayload(),
    }, 'Investigate runtime context director: ' + (item.name || item.label || 'Director') + ' · ' + (item.provider || '--') + ' · ' + (item.role || '--'), item.label || 'main');
  };

  window.createTaskFromRuntimeContextPromptFile = function(index) {
    var payload = runtimeContextItemPayload('promptFile', index);
    if (!payload.item) {
      showToast('Runtime context prompt file not found', false);
      return;
    }
    var item = payload.item;
    createTaskFromRuntimeContextPayload({
      type: 'runtimeContextPromptFile',
      item: payload,
      promptBundle: runtimeContextData.promptBundle || null,
      snapshot: snapshotReportPayload(),
    }, 'Investigate runtime prompt file: ' + (item.name || item.path || 'prompt'), 'main');
  };

  window.createTaskFromRuntimeContextMcpConfig = function(index) {
    var payload = runtimeContextItemPayload('mcpConfig', index);
    if (!payload.item) {
      showToast('Runtime context MCP config not found', false);
      return;
    }
    var item = payload.item;
    var servers = item.servers || [];
    createTaskFromRuntimeContextPayload({
      type: 'runtimeContextMcpConfig',
      item: payload,
      snapshot: snapshotReportPayload(),
    }, 'Investigate runtime MCP config: ' + (item.label || item.path || 'mcp') + ' · ' + String(servers.length) + ' servers', 'main');
  };

  function runtimeDirectorByLabel(label) {
    var directors = runtimeProcessesPayload().directors || [];
    return directors.find(function(item) { return item.label === label; }) || null;
  }

  function runtimeProcessTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench runtime process handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate Director process health before changing runtime behavior.',
      '- Review alive/dead state, PID, restart/crash history, activity, provider, persona role, session, queue/current work, context health, and recent runtime event history.',
      '- If a Director is dead, crash-looping, stale, or attached to suspicious work, identify the likely cause and propose or implement a scoped fix.',
      '- Preserve runtime safety boundaries; restart/shutdown/clear operations should still go through the existing approval paths.',
      '',
      'Runtime process handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function createTaskFromRuntimeProcessPayload(payload, description, sourceDirector) {
    if (!payload) {
      showToast('Runtime process evidence not found', false);
      return;
    }
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: sourceDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: shortText(description || 'Investigate runtime process health', 120),
      prompt: runtimeProcessTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Runtime process handoff loaded into task form', true);
  }

  window.copyRuntimeSnapshot = function() {
    copyText(JSON.stringify(runtimeSnapshotPayload(), null, 2));
  };

  window.exportRuntimeSnapshot = function() {
    downloadTextFile('persona-runtime-snapshot-' + Date.now() + '.json', JSON.stringify(runtimeSnapshotPayload(), null, 2));
    showToast('Runtime snapshot exported', true);
  };

  window.createTaskFromRuntimeSnapshot = function() {
    var payload = runtimeSnapshotPayload();
    var sys = payload.system || {};
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate runtime state: ' + (sys.sessionName || sys.sessionId || 'main'),
      prompt: runtimeTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Runtime handoff loaded into task form', true);
  };

  window.copyRuntimeProcesses = function() {
    copyText(JSON.stringify(runtimeProcessesPayload(), null, 2));
  };

  window.exportRuntimeProcesses = function() {
    downloadTextFile('persona-runtime-processes-' + Date.now() + '.json', JSON.stringify(runtimeProcessesPayload(), null, 2));
    showToast('Runtime processes exported', true);
  };

  window.createTaskFromRuntimeProcesses = function() {
    var payload = runtimeProcessesPayload();
    var directors = payload.directors || [];
    var dead = directors.filter(function(item) { return item && !item.alive && !item.closed; }).length;
    var crashes = directors.filter(function(item) { return item && item.lastCrashAt; }).length;
    var restarts = directors.reduce(function(sum, item) { return sum + Number(item && item.recentRestartCount || 0); }, 0);
    createTaskFromRuntimeProcessPayload({
      type: 'runtimeProcesses',
      processes: payload,
      contextHealth: contextHealthPayload(),
      activeWork: activeWorkPayload(),
      runtimeEvents: runtimeEventHistoryPayload(),
      snapshot: snapshotReportPayload(),
    }, 'Investigate runtime processes: ' + String(dead) + ' dead · ' + String(crashes) + ' crashed · ' + String(restarts) + ' recent restarts', 'main');
  };

  window.copyRuntimeActiveWork = function() {
    copyText(JSON.stringify(activeWorkPayload(), null, 2));
  };

  window.exportRuntimeActiveWork = function() {
    downloadTextFile('persona-runtime-active-work-' + Date.now() + '.json', JSON.stringify(activeWorkPayload(), null, 2));
    showToast('Runtime active work exported', true);
  };

  window.copyRuntimeActiveWorkItem = function(id) {
    var item = activeWorkItemById(id);
    if (!item) {
      showToast('Active work item not found', false);
      return;
    }
    copyText(JSON.stringify(item, null, 2));
  };

  window.exportRuntimeActiveWorkItem = function(id) {
    var item = activeWorkItemById(id);
    if (!item) {
      showToast('Active work item not found', false);
      return;
    }
    var safe = String(item.id || 'active-work').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-runtime-active-work-' + safe + '-' + Date.now() + '.json', JSON.stringify(item, null, 2));
    showToast('Runtime active work item exported', true);
  };

  window.createTaskFromRuntimeActiveWorkItem = function(id) {
    var item = activeWorkItemById(id);
    if (!item) {
      showToast('Active work item not found', false);
      return;
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'activeWorkItem',
      item: item,
      runtime: runtimeSnapshotPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: item.label || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate active runtime work: ' + shortText(item.preview || item.correlationId || item.id || 'work item', 80),
      prompt: runtimeItemTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Runtime work item loaded into task form', true);
  };

  window.openRuntimeActiveWorkDirector = function(id) {
    var item = activeWorkItemById(id);
    if (!item) {
      showToast('Active work item not found', false);
      return;
    }
    if ((item.label || 'main') === 'main') selectSession(null);
    else selectPoolDirector(item.label, item.name || item.label);
  };

  window.openRuntimeActiveWorkSession = function(id) {
    var item = activeWorkItemById(id);
    if (!item || !item.sessionId) {
      showToast('Active work session not found', false);
      return;
    }
    if ((item.label || 'main') === 'main') selectSession(item.sessionId);
    else selectSubSession(item.label, item.sessionId, item.name || item.sessionId.slice(0, 16));
  };

  function focusRuntimeActiveWork(label, correlationId) {
    var directorLabel = label || 'main';
    var focusId = correlationId ? directorLabel + '-queue-' + correlationId : '';
    runtimeActiveWorkFocusId = focusId;
    selectNav('agents');
    if (!focusId) {
      showToast('Opened Runtime', true);
      return;
    }
    setTimeout(function() {
      var row = document.getElementById('runtime-active-work-row-' + safeAssetName(focusId, 'work'));
      if (row && row.scrollIntoView) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        showToast('Opened Runtime queue item', true);
      } else {
        showToast('Opened Runtime; queue item is no longer visible', false);
      }
    }, 120);
  }

  function markRuntimeActiveWorkCancelled(item) {
    if (!item || !item.correlationId || !data) return;
    if ((item.label || 'main') === 'main') {
      var queue = data.queue || [];
      for (var i = 0; i < queue.length; i++) {
        if (queue[i].correlationId === item.correlationId) queue[i].cancelled = true;
      }
    } else {
      var pool = data.pool || [];
      for (var pi = 0; pi < pool.length; pi++) {
        if (pool[pi].label !== item.label) continue;
        var poolQueue = pool[pi].queue || [];
        for (var qi = 0; qi < poolQueue.length; qi++) {
          if (poolQueue[qi].correlationId === item.correlationId) poolQueue[qi].cancelled = true;
        }
      }
    }
    if (viewMode === 'agents') renderRuntimeView();
  }

  window.cancelRuntimeActiveWorkItem = async function(id) {
    var item = activeWorkItemById(id);
    if (!item || item.kind !== 'queued' || !item.correlationId) {
      showToast('Queued work item not found', false);
      return;
    }
    queueDangerApproval({
      title: 'Cancel active work',
      target: (item.name || item.label || 'Director') + ' · ' + item.correlationId,
      detail: 'The queued work item will be cancelled. If it is at the head of the queue, its Director may be interrupted.',
      severity: 'high',
      payload: item,
    }, async function() {
      try {
        var label = item.label || 'main';
        var res;
        if (label === 'main') {
          res = await fetch('/api/queue/' + encodeURIComponent(item.correlationId) + '/cancel', { method: 'POST' });
        } else {
          res = await fetch('/api/directors/queue/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ director_label: label, correlation_id: item.correlationId }),
          });
        }
        var body = await readJsonResponse(res);
        markRuntimeActiveWorkCancelled(item);
        loadAuditLog();
        showToast(body.item && body.item.interrupted ? 'Work item cancelled and Director interrupted' : 'Work item cancelled', true);
      } catch (err) {
        showToast('Cancel failed: ' + err.message, false);
        throw err;
      }
    });
  };

  window.copyRuntimeDirectorJson = function(label) {
    var director = runtimeDirectorByLabel(label || 'main');
    if (!director) {
      showToast('Director runtime state not found', false);
      return;
    }
    copyText(JSON.stringify(director, null, 2));
  };

  window.exportRuntimeDirectorJson = function(label) {
    var director = runtimeDirectorByLabel(label || 'main');
    if (!director) {
      showToast('Director runtime state not found', false);
      return;
    }
    var safe = String(director.label || label || 'director').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-runtime-director-' + safe + '-' + Date.now() + '.json', JSON.stringify(director, null, 2));
    showToast('Director runtime state exported', true);
  };

  window.createTaskFromRuntimeDirector = function(label) {
    var director = runtimeDirectorByLabel(label || 'main');
    if (!director) {
      showToast('Director runtime state not found', false);
      return;
    }
    createTaskFromRuntimeProcessPayload({
      type: 'runtimeDirectorProcess',
      director: director,
      processes: runtimeProcessesPayload(),
      contextHealth: contextHealthPayload(),
      activeWork: activeWorkPayload(),
      runtimeEvents: runtimeEventHistoryPayload(),
      snapshot: snapshotReportPayload(),
    }, 'Investigate Director process: ' + (director.groupName || director.label || 'Director') + ' · ' + (director.alive ? 'alive' : 'dead') + ' · ' + String(director.recentRestartCount || 0) + ' recent restarts', director.label || 'main');
  };

  window.openRuntimeDirectorSession = function(label) {
    var director = runtimeDirectorByLabel(label || 'main');
    if (!director || !director.sessionId) {
      showToast('Director session not found', false);
      return;
    }
    if ((director.label || 'main') === 'main') {
      selectSession(director.sessionId);
    } else {
      selectSubSession(director.label, director.sessionId, director.groupName || director.sessionId.slice(0, 16));
    }
  };

  window.copyRuntimeQueue = function() {
    copyText(JSON.stringify(runtimeQueuePayload(), null, 2));
  };

  window.exportRuntimeQueue = function() {
    downloadTextFile('persona-runtime-queue-' + Date.now() + '.json', JSON.stringify(runtimeQueuePayload(), null, 2));
    showToast('Runtime queue exported', true);
  };

  function runtimeQueueTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench main queue handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate or review Main Director queue state before changing queued work.',
      '- Review queue items, cancellation state, runtime process health, active work, context health, and selected queue operation intent.',
      '- If queue pressure, stale items, duplicate messages, or a risky clear/cancel intent is present, identify the likely cause and propose or implement a scoped fix.',
      '- Preserve runtime safety boundaries; cancel or clear queue actions should still go through the existing approval paths.',
      '',
      'Main queue handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function runtimeQueueHandoffPayload(intent) {
    var queuePayload = runtimeQueuePayload();
    return {
      exportedAt: new Date().toISOString(),
      intent: intent || { kind: 'inspect', label: 'Inspect main queue' },
      queue: queuePayload,
      summary: {
        total: (queuePayload.queue || []).length,
        cancelled: (queuePayload.queue || []).filter(function(item) { return item && item.cancelled; }).length,
      },
      process: runtimeDirectorByLabel('main'),
      activeWork: activeWorkPayload(),
      contextHealth: contextHealthPayload(),
      snapshot: snapshotReportPayload(),
    };
  }

  function createTaskFromRuntimeQueuePayload(payload, description) {
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: shortText(description || 'Investigate main runtime queue', 120),
      prompt: runtimeQueueTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Runtime queue handoff loaded into task form', true);
  }

  window.createTaskFromRuntimeQueue = function() {
    var payload = runtimeQueueHandoffPayload({ kind: 'inspect', label: 'Inspect main queue' });
    createTaskFromRuntimeQueuePayload(payload, 'Investigate main runtime queue: ' + String(payload.summary.total || 0) + ' queued · ' + String(payload.summary.cancelled || 0) + ' cancelled');
  };

  window.createTaskFromRuntimeQueueClearIntent = function() {
    var payload = runtimeQueueHandoffPayload({
      kind: 'clear-intent',
      label: 'Review clear main queue before approval',
      safety: 'This task does not clear the queue; the destructive action still requires the existing approval path.',
    });
    if (!payload.summary.total) {
      showToast('Main queue is empty', false);
      return;
    }
    createTaskFromRuntimeQueuePayload(payload, 'Review clear main queue: ' + String(payload.summary.total || 0) + ' queued message(s)');
  };

  function runtimeQueueItemByCorrelation(correlationId) {
    var queue = data && data.queue || [];
    var item = queue.find(function(row) { return row.correlationId === correlationId; }) || null;
    if (!item && /^\d+$/.test(String(correlationId || ''))) item = queue[Number(correlationId)] || null;
    if (!item && queue.length === 1) item = queue[0];
    return item;
  }

  window.copyRuntimeQueueItem = function(correlationId) {
    var item = runtimeQueueItemByCorrelation(correlationId);
    if (!item) {
      showToast('Queue item not found', false);
      return;
    }
    copyText(JSON.stringify(item, null, 2));
  };

  window.exportRuntimeQueueItem = function(correlationId) {
    var item = runtimeQueueItemByCorrelation(correlationId);
    if (!item) {
      showToast('Queue item not found', false);
      return;
    }
    var safe = String(item.correlationId || item.messageId || 'queue-item').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-runtime-queue-item-' + safe + '-' + Date.now() + '.json', JSON.stringify(item, null, 2));
    showToast('Queue item exported', true);
  };

  window.createTaskFromRuntimeQueueItem = function(correlationId) {
    var item = runtimeQueueItemByCorrelation(correlationId);
    if (!item) {
      showToast('Queue item not found', false);
      return;
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'mainQueueItem',
      item: item,
      runtime: runtimeSnapshotPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate queued runtime message: ' + shortText(item.preview || item.text || item.correlationId || 'queue item', 80),
      prompt: runtimeItemTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Runtime queue item loaded into task form', true);
  };

  window.cancelQueueItem = async function(correlationId) {
    queueDangerApproval({
      title: 'Cancel queued message',
      target: correlationId,
      detail: 'The queued message will be cancelled. If it is currently being processed, the Director may be interrupted.',
      severity: 'high',
      payload: {
        correlationId: correlationId,
        queueItem: (data && data.queue || []).find(function(row) { return row.correlationId === correlationId; }) || null,
      },
    }, async function() {
    try {
      var res = await fetch('/api/queue/' + encodeURIComponent(correlationId) + '/cancel', { method: 'POST' });
      var body = await res.json();
      if (!res.ok || body.error || body.ok === false) throw new Error(body.error || 'cancel queue item failed');
      showToast(body.item && body.item.interrupted ? 'Queued message cancelled and Director interrupted' : 'Queued message cancelled', true);
    } catch (err) {
      showToast('Cancel failed: ' + err.message, false);
      throw err;
    }
    });
  };

  window.clearMainQueue = async function() {
    queueDangerApproval({
      title: 'Clear main queue',
      target: 'main',
      detail: 'All queued messages waiting for the Main Director will be removed.',
      severity: 'high',
      payload: runtimeQueuePayload(),
    }, async function() {
    try {
      var res = await fetch('/api/queue/clear', { method: 'POST' });
      var body = await res.json();
      if (!res.ok || body.error || body.ok === false) throw new Error(body.error || 'clear queue failed');
      showToast('Cleared ' + (body.cleared || 0) + ' queued message(s)', true);
    } catch (err) {
      showToast('Clear queue failed: ' + err.message, false);
      throw err;
    }
    });
  };

  function renderTasksHome() {
    if (!data) {
      $('detail-content').innerHTML = '<div class="empty">Waiting for tasks...</div>';
      return;
    }
    var tasks = data.tasks || {};
    var summary = tasks.summary || {};
    var list = filteredTaskCenterTasks();
    var html = '<div class="page-grid">';
    html += '<div class="workbench-panel wide"><div class="panel-title"><span>Mission Center</span><button class="mini-btn" onclick="toggleCreateTaskForm()">' + (createTaskOpen ? 'Close' : 'Create Task') + '</button></div>';
    html += '<div class="kv-grid">';
    html += '<div class="kv-card"><div class="kv-label">Running</div><div class="kv-value">' + (summary.running || 0) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Completed</div><div class="kv-value">' + (summary.completed || 0) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Failed</div><div class="kv-value">' + (summary.failed || 0) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Loaded</div><div class="kv-value">' + (taskCenterData.tasks.length || 0) + '</div></div>';
    html += '</div>';
    if (createTaskOpen) {
      html += renderCreateTaskForm();
    }
    html += renderTaskTrendPanel(list);
    html += renderTaskCleanupPanel();
    html += '</div>';
    html += '<div class="workbench-panel wide"><div class="panel-title"><span>Tasks</span><button class="mini-btn" onclick="loadTaskCenterTasks()">Refresh</button></div>';
    html += renderTaskFilters();
    html += renderTaskBulkToolbar(list);
    html += '<div class="panel-list task-center-list">';
    if (taskCenterData.loading) {
      html += '<div class="empty">Loading tasks...</div>';
    } else if (taskCenterData.error) {
      html += '<div class="td-error">' + esc(taskCenterData.error) + '</div>';
    } else if (list.length === 0) {
      html += '<div class="empty">No tasks</div>';
    } else {
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        var selected = !!taskCenterData.selected[t.id];
        html += '<div class="panel-row clickable task-center-row' + (selected ? ' selected' : '') + '" onclick="selectTask(\'' + jsq(t.id) + '\')">';
        html += '<input class="task-select-check" type="checkbox" ' + (selected ? 'checked ' : '') + 'onclick="event.stopPropagation()" onchange="toggleTaskSelection(\'' + jsq(t.id) + '\', this.checked)">';
        html += '<span class="badge ' + esc(t.status || 'pending') + '">' + esc(t.status || 'pending') + '</span>';
        html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(t.description || t.role || t.id) + '</div>';
        html += '<div class="panel-row-sub">' + esc(t.id) + ' · ' + esc(t.role || '--') + taskMetaText(t) + '</div></div>';
        html += '<span class="item-meta">' + taskTimeText(t) + '</span></div>';
      }
    }
    html += '</div></div></div>';
    $('detail-content').innerHTML = html;
  }

  function taskMetaText(t) {
    var parts = [];
    if (t.agent) parts.push('provider ' + t.agent);
    var model = taskExtraValue(t, 'model');
    if (model) parts.push('model ' + model);
    if (t.source_director) parts.push('source ' + t.source_director);
    else if (t.sourceDirector) parts.push('source ' + t.sourceDirector);
    if (t.cost_usd != null) parts.push(fmtCost(Number(t.cost_usd)));
    return parts.length ? ' · ' + parts.map(esc).join(' · ') : '';
  }

  function taskExtraValue(t, key) {
    return t && t.extra && t.extra[key] != null ? String(t.extra[key]) : '';
  }

  function taskTimeText(t) {
    var duration = t.duration_ms != null ? t.duration_ms : t.durationMs;
    if (duration != null) return fmtDur(Number(duration));
    var created = t.created_at || t.createdAt;
    return created ? fmtAgo(new Date(created).getTime()) : '--';
  }

  function taskTimestamp(t) {
    var value = t.completed_at || t.completedAt || t.started_at || t.startedAt || t.created_at || t.createdAt;
    var ts = value ? Date.parse(value) : NaN;
    return Number.isFinite(ts) ? ts : 0;
  }

  function taskCreatedDayKey(t) {
    var value = t && (t.created_at || t.createdAt);
    var ts = value ? Date.parse(value) : NaN;
    if (Number.isFinite(ts)) return localDayKey(ts);
    return value ? String(value).slice(0, 10) : 'unknown';
  }

  function localDayKey(ts) {
    if (!ts) return 'unknown';
    try {
      return new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    } catch (_) {
      return 'unknown';
    }
  }

  function taskCost(t) {
    var value = t.cost_usd != null ? t.cost_usd : t.costUsd;
    var n = Number(value || 0);
    return Number.isFinite(n) ? n : 0;
  }

  function taskDuration(t) {
    var value = t.duration_ms != null ? t.duration_ms : t.durationMs;
    var n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function incrementTaskMetric(map, key, task) {
    var name = key || 'unknown';
    if (!map[name]) map[name] = { name: name, total: 0, completed: 0, failed: 0, running: 0, cancelled: 0, costUsd: 0 };
    var row = map[name];
    var status = taskDisplayStatus(task);
    row.total += 1;
    if (status === 'completed') row.completed += 1;
    else if (status === 'failed') row.failed += 1;
    else if (status === 'cancelled') row.cancelled += 1;
    else if (status === 'running' || status === 'dispatched') row.running += 1;
    row.costUsd += taskCost(task);
  }

  function taskMetricRows(map) {
    return Object.keys(map).map(function(key) {
      var row = map[key];
      row.successRate = row.total ? Math.round((row.completed / row.total) * 100) : 0;
      row.failureRate = row.total ? Math.round((row.failed / row.total) * 100) : 0;
      return row;
    }).sort(function(a, b) {
      if (b.total !== a.total) return b.total - a.total;
      return String(a.name).localeCompare(String(b.name));
    }).slice(0, 8);
  }

  function taskTrendReport(tasks) {
    var list = tasks || [];
    var now = Date.now();
    var dayMs = 24 * 60 * 60 * 1000;
    var dayMap = {};
    var providerMap = {};
    var roleMap = {};
    var statusCounts = { dispatched: 0, running: 0, completed: 0, failed: 0, cancelled: 0, other: 0 };
    var durationTotal = 0;
    var durationCount = 0;
    var totalCost = 0;
    for (var d = 13; d >= 0; d--) {
      var day = localDayKey(now - d * dayMs);
      dayMap[day] = { day: day, total: 0, completed: 0, failed: 0, running: 0, cancelled: 0, costUsd: 0, avgDurationMs: 0, durationTotalMs: 0, durationCount: 0 };
    }
    for (var i = 0; i < list.length; i++) {
      var task = list[i];
      var status = taskDisplayStatus(task);
      if (statusCounts[status] == null) statusCounts.other += 1;
      else statusCounts[status] += 1;
      var cost = taskCost(task);
      totalCost += cost;
      var duration = taskDuration(task);
      if (duration != null) {
        durationTotal += duration;
        durationCount += 1;
      }
      incrementTaskMetric(providerMap, task.agent || 'default', task);
      incrementTaskMetric(roleMap, task.role || 'unknown', task);
      var ts = taskTimestamp(task);
      var dayKey = localDayKey(ts);
      if (!dayMap[dayKey]) continue;
      var row = dayMap[dayKey];
      row.total += 1;
      row.costUsd += cost;
      if (duration != null) {
        row.durationTotalMs += duration;
        row.durationCount += 1;
        row.avgDurationMs = Math.round(row.durationTotalMs / Math.max(1, row.durationCount));
      }
      if (status === 'completed') row.completed += 1;
      else if (status === 'failed') row.failed += 1;
      else if (status === 'cancelled') row.cancelled += 1;
      else if (status === 'running' || status === 'dispatched') row.running += 1;
    }
    var days = Object.keys(dayMap).sort().map(function(key) {
      var row = dayMap[key];
      return {
        day: row.day,
        total: row.total,
        completed: row.completed,
        failed: row.failed,
        running: row.running,
        cancelled: row.cancelled,
        costUsd: Number(row.costUsd.toFixed(6)),
        avgDurationMs: row.avgDurationMs,
      };
    });
    return {
      exportedAt: new Date().toISOString(),
      scope: 'tasks-current-filter',
      filters: taskCenterData.filters,
      loadedCount: (taskCenterData.tasks || []).length,
      visibleCount: list.length,
      statusCounts: statusCounts,
      totalCostUsd: Number(totalCost.toFixed(6)),
      avgDurationMs: durationCount ? Math.round(durationTotal / durationCount) : 0,
      days: days,
      providers: taskMetricRows(providerMap),
      roles: taskMetricRows(roleMap),
    };
  }

  function renderTaskTrendMiniBars(days) {
    if (!days || days.length === 0) return '<div class="mini-trend empty-trend"><span>No history</span></div>';
    var maxTotal = days.reduce(function(max, item) { return Math.max(max, Number(item.total || 0)); }, 0);
    if (maxTotal <= 0) return '<div class="mini-trend empty-trend"><span>No history</span></div>';
    var html = '<div class="mini-trend task-trend-bars">';
    for (var i = 0; i < days.length; i++) {
      var item = days[i];
      var h = Math.max(6, Math.round((Number(item.total || 0) / maxTotal) * 38));
      html += '<i title="' + esc(item.day + ': ' + item.total + ' task(s)') + '" class="' + ((item.failed || 0) > 0 ? 'has-failure' : '') + '" style="height:' + h + 'px"></i>';
    }
    html += '</div>';
    return html;
  }

  function renderTaskTrendBreakdown(title, items) {
    var html = '<div class="task-trend-breakdown"><div class="td-section-title">' + esc(title) + '</div>';
    if (!items || items.length === 0) {
      html += '<div class="empty compact">No data for the current filter.</div></div>';
      return html;
    }
    for (var i = 0; i < Math.min(items.length, 4); i++) {
      var item = items[i];
      html += '<div class="diagnostic-rate-row">';
      html += '<div class="rate-row-head"><span>' + esc(item.name || 'unknown') + '</span><strong>' + esc(pctText(item.successRate)) + '</strong></div>';
      html += '<div class="rate-bar"><i style="width:' + Math.max(0, Math.min(100, Number(item.successRate || 0))) + '%"></i></div>';
      html += '<div class="panel-row-sub">' + esc(String(item.total || 0)) + ' tasks · ' + esc(String(item.failed || 0)) + ' failed · ' + esc(fmtCost(item.costUsd || 0)) + '</div>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderTaskTrendPanel(tasks) {
    var report = taskTrendReport(tasks || []);
    var counts = report.statusCounts || {};
    var html = '<div class="task-trend-panel">';
    html += '<div class="panel-title"><span>Run Trends</span><div class="panel-actions">';
    html += '<span>' + esc(String(report.visibleCount || 0)) + ' visible</span>';
    html += '<button class="mini-btn" onclick="copyTaskTrendReport()">Copy Report</button>';
    html += '<button class="mini-btn" onclick="exportTaskTrendReport()">Export Report</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromTaskTrendReport()">Create Task</button>';
    html += '</div></div>';
    html += '<div class="metric-trend-grid task-trend-grid">';
    html += '<div class="metric-trend-card"><div class="metric-trend-head"><span>Throughput</span><strong>' + esc(String(report.visibleCount || 0)) + '</strong></div>' + renderTaskTrendMiniBars(report.days) + '<div class="panel-row-sub">14-day loaded task history</div></div>';
    html += '<div class="metric-trend-card"><div class="metric-trend-head"><span>Completed</span><strong>' + esc(String(counts.completed || 0)) + '</strong></div><div class="task-trend-status-row"><span class="badge completed">ok</span><span>' + esc(String(counts.failed || 0)) + ' failed</span><span>' + esc(String(counts.cancelled || 0)) + ' cancelled</span></div><div class="panel-row-sub">current filter status mix</div></div>';
    html += '<div class="metric-trend-card"><div class="metric-trend-head"><span>Avg Duration</span><strong>' + esc(fmtDur(report.avgDurationMs || 0)) + '</strong></div>' + renderMiniTrend(trendValues(report.days, 'avgDurationMs'), 'latency') + '<div class="panel-row-sub">completed/running tasks with duration</div></div>';
    html += '<div class="metric-trend-card"><div class="metric-trend-head"><span>Cost</span><strong>' + esc(fmtCost(report.totalCostUsd || 0)) + '</strong></div>' + renderMiniTrend(trendValues(report.days, 'costUsd'), 'cost') + '<div class="panel-row-sub">loaded task cost by day</div></div>';
    html += '</div>';
    html += '<div class="task-trend-columns">';
    html += renderTaskTrendBreakdown('Provider Success', report.providers);
    html += renderTaskTrendBreakdown('Role Success', report.roles);
    html += '</div>';
    html += '</div>';
    return html;
  }

  function filteredTaskCenterTasks() {
    var list = taskCenterData.tasks && taskCenterData.tasks.length ? taskCenterData.tasks : ((data && data.tasks && data.tasks.recent) || []);
    var f = taskCenterData.filters;
    return list.filter(function(t) {
      if (f.status && f.status !== 'all') {
        if (f.status === 'cancelled') {
          if (t.status !== 'failed' || t.error !== 'cancelled') return false;
        } else if (f.status === 'failed') {
          if (t.status !== 'failed' || t.error === 'cancelled') return false;
        } else if (t.status !== f.status) {
          return false;
        }
      }
      if (f.role) {
        if (String(t.role || '').toLowerCase().indexOf(f.role.toLowerCase()) < 0) return false;
      }
      if (f.source !== 'all') {
        var source = t.source_director || t.sourceDirector || '';
        if (f.source === 'none') {
          if (source) return false;
        } else if (source !== f.source) {
          return false;
        }
      }
      if (f.provider) {
        if (String(t.agent || '').toLowerCase().indexOf(f.provider.toLowerCase()) < 0) return false;
      }
      if (f.model) {
        if (taskExtraValue(t, 'model').toLowerCase().indexOf(f.model.toLowerCase()) < 0) return false;
      }
      if (f.cronJobId) {
        if (taskExtraValue(t, 'cronJobId') !== f.cronJobId) return false;
      }
      if (f.day) {
        if (taskCreatedDayKey(t) !== f.day) return false;
      }
      return true;
    });
  }

  function selectedTaskCenterTasks() {
    var selected = taskCenterData.selected || {};
    var byId = {};
    var loaded = taskCenterData.tasks && taskCenterData.tasks.length ? taskCenterData.tasks : ((data && data.tasks && data.tasks.recent) || []);
    for (var i = 0; i < loaded.length; i++) byId[loaded[i].id] = loaded[i];
    return Object.keys(selected).filter(function(id) { return !!selected[id] && byId[id]; }).map(function(id) { return byId[id]; });
  }

  function pruneTaskSelection() {
    var loaded = taskCenterData.tasks && taskCenterData.tasks.length ? taskCenterData.tasks : ((data && data.tasks && data.tasks.recent) || []);
    var ids = {};
    for (var i = 0; i < loaded.length; i++) ids[loaded[i].id] = true;
    var selected = {};
    var keys = Object.keys(taskCenterData.selected || {});
    for (var j = 0; j < keys.length; j++) {
      if (ids[keys[j]]) selected[keys[j]] = true;
    }
    taskCenterData.selected = selected;
  }

  function renderTaskBulkToolbar(list) {
    var selected = selectedTaskCenterTasks();
    var selectedCount = selected.length;
    var activeCount = selected.filter(function(t) { return t.status === 'running' || t.status === 'dispatched'; }).length;
    var failedCount = selected.filter(function(t) { return t.status === 'failed'; }).length;
    var visibleCount = list.length;
    var allVisibleSelected = visibleCount > 0 && list.every(function(t) { return !!taskCenterData.selected[t.id]; });
    var html = '<div class="task-bulk-toolbar">';
    html += '<label class="task-bulk-select"><input type="checkbox" ' + (allVisibleSelected ? 'checked ' : '') + (visibleCount ? '' : 'disabled ') + 'onchange="toggleVisibleTaskSelection(this.checked)"><span>Select visible</span></label>';
    html += '<span class="muted mono">' + selectedCount + ' selected · ' + visibleCount + ' visible</span>';
    html += '<div class="panel-actions">';
    html += '<button class="mini-btn" ' + (selectedCount ? '' : 'disabled ') + 'onclick="clearTaskSelection()">Clear</button>';
    html += '<button class="mini-btn danger" ' + (activeCount ? '' : 'disabled ') + 'onclick="bulkCancelSelectedTasks()">Cancel Active (' + activeCount + ')</button>';
    html += '<button class="mini-btn primary" ' + (failedCount ? '' : 'disabled ') + 'onclick="bulkRetrySelectedTasks()">Retry Failed (' + failedCount + ')</button>';
    html += '<button class="mini-btn" ' + (selectedCount ? '' : 'disabled ') + 'onclick="exportSelectedTasks()">Export JSON</button>';
    html += '<button class="mini-btn primary" ' + (selectedCount ? '' : 'disabled ') + 'onclick="createTaskFromSelectedTasks()">Create Task</button>';
    html += '</div></div>';
    return html;
  }

  function renderTaskCleanupPanel() {
    var cleanup = taskCenterData.cleanup || {};
    var preview = cleanup.preview;
    var count = preview ? Number(preview.eligibleCount || 0) : 0;
    var html = '<div class="task-cleanup-panel">';
    html += '<div class="panel-title"><span>History Cleanup</span><div class="panel-actions">';
    if (preview) {
      html += '<button class="mini-btn" onclick="copyTaskCleanupReport()">Copy Report</button>';
      html += '<button class="mini-btn" onclick="exportTaskCleanupReport()">Export Report</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromTaskCleanupReport()">Create Task</button>';
    }
    html += '<button class="mini-btn" onclick="previewTaskCleanup()">' + (cleanup.loading ? 'Checking...' : 'Preview') + '</button></div></div>';
    html += '<div class="task-cleanup-controls">';
    html += '<label><span>Older Than</span><input type="number" min="1" max="3650" value="' + esc(String(cleanup.olderThanDays || 30)) + '" onchange="setTaskCleanupField(\'olderThanDays\', this.value)"></label>';
    html += '<label><span>Status</span><select onchange="setTaskCleanupField(\'status\', this.value)">';
    var statuses = [['terminal', 'Completed + Failed'], ['completed', 'Completed'], ['failed', 'Failed'], ['cancelled', 'Cancelled']];
    for (var i = 0; i < statuses.length; i++) {
      html += '<option value="' + statuses[i][0] + '"' + (cleanup.status === statuses[i][0] ? ' selected' : '') + '>' + statuses[i][1] + '</option>';
    }
    html += '</select></label>';
    html += '<button class="mini-btn danger" ' + (count ? '' : 'disabled ') + 'onclick="cleanupTaskHistory()">Clean ' + count + '</button>';
    html += '</div>';
    html += '<div class="form-note">Only terminal task records are eligible. Running and dispatched tasks are never removed.</div>';
    if (cleanup.error) {
      html += '<div class="td-error compact">' + esc(cleanup.error) + '</div>';
    } else if (preview) {
      html += '<div class="kv-grid task-cleanup-preview">';
      html += '<div class="kv-card"><div class="kv-label">Eligible</div><div class="kv-value">' + esc(String(preview.eligibleCount || 0)) + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Cutoff</div><div class="kv-value">' + esc(preview.cutoff || '--') + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Oldest</div><div class="kv-value">' + esc(preview.oldestCreatedAt || '--') + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Newest</div><div class="kv-value">' + esc(preview.newestCreatedAt || '--') + '</div></div>';
      html += '</div>';
      if (preview.samples && preview.samples.length) {
        html += '<div class="task-cleanup-samples">';
        for (var j = 0; j < preview.samples.length; j++) {
          var t = preview.samples[j];
          html += '<div class="panel-row"><span class="badge ' + esc(t.error === 'cancelled' ? 'cancelled' : (t.status || 'pending')) + '">' + esc(t.error === 'cancelled' ? 'cancelled' : (t.status || 'pending')) + '</span>';
          html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(t.description || t.id) + '</div>';
          html += '<div class="panel-row-sub">' + esc(t.id) + ' · ' + esc(t.created_at || '--') + '</div></div></div>';
        }
        html += '</div>';
      }
    }
    html += '</div>';
    return html;
  }

  function renderTaskFilters() {
    var f = taskCenterData.filters;
    var sources = taskSourceOptions();
    var html = '<div class="task-filters">';
    html += '<label><span>Status</span><select onchange="setTaskFilter(\'status\', this.value)">';
    var statuses = [['all', 'All'], ['dispatched', 'Dispatched'], ['running', 'Running'], ['completed', 'Completed'], ['failed', 'Failed'], ['cancelled', 'Cancelled']];
    for (var i = 0; i < statuses.length; i++) {
      html += '<option value="' + statuses[i][0] + '"' + (f.status === statuses[i][0] ? ' selected' : '') + '>' + statuses[i][1] + '</option>';
    }
    html += '</select></label>';
    html += '<label><span>Role</span><input value="' + esc(f.role) + '" list="role-options" placeholder="all roles" onkeydown="if(event.key===\'Enter\')setTaskFilter(\'role\', this.value)" onblur="setTaskFilter(\'role\', this.value)"></label>';
    html += '<label><span>Provider</span><input value="' + esc(f.provider || '') + '" placeholder="all providers" onkeydown="if(event.key===\'Enter\')setTaskFilter(\'provider\', this.value)" onblur="setTaskFilter(\'provider\', this.value)"></label>';
    html += '<label><span>Model</span><input value="' + esc(f.model || '') + '" placeholder="all models" onkeydown="if(event.key===\'Enter\')setTaskFilter(\'model\', this.value)" onblur="setTaskFilter(\'model\', this.value)"></label>';
    html += '<label><span>Source</span><select onchange="setTaskFilter(\'source\', this.value)">';
    for (var j = 0; j < sources.length; j++) {
      html += '<option value="' + esc(sources[j][0]) + '"' + (f.source === sources[j][0] ? ' selected' : '') + '>' + esc(sources[j][1]) + '</option>';
    }
    html += '</select></label>';
    html += roleDatalistHtml();
    if (f.cronJobId) {
      html += '<div class="task-filter-pill"><span>Cron ' + esc(f.cronJobId) + '</span><button type="button" onclick="setTaskFilter(\'cronJobId\', \'\')">Clear</button></div>';
    }
    if (f.day) {
      html += '<div class="task-filter-pill"><span>Day ' + esc(f.day) + '</span><button type="button" onclick="setTaskFilter(\'day\', \'\')">Clear</button></div>';
    }
    html += '</div>';
    return html;
  }

  function taskSourceOptions() {
    var map = new Map();
    map.set('all', 'All sources');
    map.set('none', 'No source');
    var list = taskCenterData.tasks || [];
    for (var i = 0; i < list.length; i++) {
      var source = list[i].source_director || list[i].sourceDirector;
      if (source) map.set(source, source);
    }
    return Array.from(map.entries());
  }

  window.setTaskFilter = function(key, value) {
    taskCenterData.filters[key] = (value || '').trim();
    if (key === 'status' || key === 'role') {
      loadTaskCenterTasks();
    } else {
      renderTasksHome();
    }
  };

  function loadTaskCenterTasks() {
    taskCenterData.loading = true;
    taskCenterData.error = null;
    renderTasksHome();
    var params = new URLSearchParams();
    params.set('limit', '200');
    var f = taskCenterData.filters;
    if (f.status && f.status !== 'all') params.set('status', f.status === 'cancelled' ? 'failed' : f.status);
    if (f.role) params.set('role', f.role);
    fetch('/api/tasks?' + params.toString())
      .then(function(r) {
        if (!r.ok) return r.text().then(function(text) { throw new Error(text || 'tasks request failed'); });
        return r.json();
      })
      .then(function(list) {
        taskCenterData.tasks = Array.isArray(list) ? list : [];
        taskCenterData.loading = false;
        pruneTaskSelection();
        renderTasksHome();
      })
      .catch(function(err) {
        taskCenterData.loading = false;
        taskCenterData.error = String(err);
        renderTasksHome();
      });
  }

  window.loadTaskCenterTasks = loadTaskCenterTasks;

  window.toggleTaskSelection = function(taskId, checked) {
    taskCenterData.selected[taskId] = !!checked;
    if (!checked) delete taskCenterData.selected[taskId];
    renderTasksHome();
  };

  window.toggleVisibleTaskSelection = function(checked) {
    var list = filteredTaskCenterTasks();
    for (var i = 0; i < list.length; i++) {
      if (checked) taskCenterData.selected[list[i].id] = true;
      else delete taskCenterData.selected[list[i].id];
    }
    renderTasksHome();
  };

  window.clearTaskSelection = function() {
    taskCenterData.selected = {};
    renderTasksHome();
  };

  window.exportSelectedTasks = function() {
    var tasks = selectedTaskCenterTasks();
    if (!tasks.length) {
      showToast('No selected tasks to export', false);
      return;
    }
    downloadTextFile('persona-selected-tasks-' + Date.now() + '.json', JSON.stringify({
      exported_at: new Date().toISOString(),
      filters: taskCenterData.filters,
      count: tasks.length,
      tasks: tasks,
    }, null, 2));
    showToast('Selected tasks exported', true);
  };

  function selectedTasksTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench selected tasks handoff as task context.',
      '',
      'Operator intent:',
      '- Review this selected task set as a focused batch, not just as a trend summary.',
      '- Identify common failure causes, retry/cancel risks, provider/model/role patterns, cron links, parent Director/session links, and missing follow-up work.',
      '- Use the current filters, visible trend report, selected task summaries, full selected task records, runtime snapshot, and approval context before acting.',
      '- Do not retry, cancel, clean history, or alter task state unless the task prompt is explicitly edited.',
      '',
      'Selected tasks handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function selectedTasksSourceDirector(tasks) {
    var sources = {};
    for (var i = 0; i < tasks.length; i++) {
      var source = tasks[i].source_director || tasks[i].sourceDirector || '';
      if (source) sources[source] = true;
    }
    var keys = Object.keys(sources);
    return keys.length === 1 ? keys[0] : 'main';
  }

  window.createTaskFromSelectedTasks = function() {
    var tasks = selectedTaskCenterTasks();
    if (!tasks.length) {
      showToast('No selected tasks to turn into a task', false);
      return;
    }
    var visible = filteredTaskCenterTasks();
    var failed = tasks.filter(function(t) { return t.status === 'failed'; }).length;
    var active = tasks.filter(function(t) { return t.status === 'running' || t.status === 'dispatched'; }).length;
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'selectedTasks',
      filters: taskCenterData.filters || {},
      selectedCount: tasks.length,
      failedCount: failed,
      activeCount: active,
      selectedSummaries: tasks.map(taskTrendTaskSummary),
      selectedTasks: tasks,
      visibleTrend: taskTrendReport(visible),
      visibleSamples: visible.slice(0, 12).map(taskTrendTaskSummary),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: selectedTasksSourceDirector(tasks),
      project_dir: tasks.length === 1 ? (taskExtraValue(tasks[0], 'project_dir') || '') : '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review selected tasks: ' + String(tasks.length) + ' selected · ' + String(failed) + ' failed · ' + String(active) + ' active',
      prompt: selectedTasksTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Selected tasks loaded into task form', true);
  };

  window.copyTaskTrendReport = function() {
    var report = taskTrendReport(filteredTaskCenterTasks());
    copyText(JSON.stringify(report, null, 2));
  };

  window.exportTaskTrendReport = function() {
    var report = taskTrendReport(filteredTaskCenterTasks());
    downloadTextFile('persona-task-trends-' + Date.now() + '.json', JSON.stringify(report, null, 2));
    showToast('Task trend report exported', true);
  };

  function taskTrendTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench task trend handoff as task context.',
      '',
      'Operator intent:',
      '- Review the current Tasks Run Trends report and identify reliability, latency, cost, provider, or role issues.',
      '- Use the active filters, 14-day trend, provider/role success rows, visible task samples, selected task summaries, and cleanup preview before acting.',
      '- If follow-up work is needed, keep it scoped to the task execution surface and preserve existing task safety/approval behavior.',
      '- Do not retry, cancel, or clean task history unless the task prompt is explicitly edited.',
      '',
      'Task trend handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function taskTrendTaskSummary(t) {
    return {
      id: t.id || '',
      status: t.status || '',
      error: t.error || null,
      role: t.role || '',
      agent: t.agent || '',
      model: taskExtraValue(t, 'model') || '',
      sourceDirector: t.source_director || t.sourceDirector || '',
      cronJobId: taskExtraValue(t, 'cronJobId') || '',
      description: shortText(t.description || t.prompt || t.id || '', 180),
      createdAt: t.createdAt || t.created_at || null,
      durationMs: t.durationMs != null ? t.durationMs : null,
      costUsd: taskCost(t),
    };
  }

  window.createTaskFromTaskTrendReport = function() {
    var visible = filteredTaskCenterTasks();
    var selected = selectedTaskCenterTasks();
    var report = taskTrendReport(visible);
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'taskTrendReport',
      report: report,
      filters: taskCenterData.filters || {},
      selectedCount: selected.length,
      visibleSamples: visible.slice(0, 12).map(taskTrendTaskSummary),
      selectedTasks: selected.slice(0, 24).map(taskTrendTaskSummary),
      cleanupPreview: taskCleanupReportPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate task run trends: ' + String(report.visibleCount || 0) + ' visible · ' + String(report.statusCounts && report.statusCounts.failed || 0) + ' failed',
      prompt: taskTrendTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Task trend report loaded into task form', true);
  };

  function taskCleanupReportPayload() {
    var cleanup = taskCenterData.cleanup || {};
    var preview = cleanup.preview || null;
    return {
      exportedAt: new Date().toISOString(),
      olderThanDays: cleanup.olderThanDays || 30,
      status: cleanup.status || 'terminal',
      loading: !!cleanup.loading,
      error: cleanup.error || null,
      preview: preview,
      eligibleCount: preview ? Number(preview.eligibleCount || 0) : 0,
      deletedCount: preview && preview.deletedCount != null ? Number(preview.deletedCount || 0) : null,
      samples: preview && preview.samples || [],
      currentFilters: taskCenterData.filters || {},
    };
  }

  window.copyTaskCleanupReport = function() {
    if (!taskCenterData.cleanup || !taskCenterData.cleanup.preview) {
      showToast('Preview cleanup first', false);
      return;
    }
    copyText(JSON.stringify(taskCleanupReportPayload(), null, 2));
  };

  window.exportTaskCleanupReport = function() {
    if (!taskCenterData.cleanup || !taskCenterData.cleanup.preview) {
      showToast('Preview cleanup first', false);
      return;
    }
    downloadTextFile('persona-task-cleanup-' + Date.now() + '.json', JSON.stringify(taskCleanupReportPayload(), null, 2));
    showToast('Task cleanup report exported', true);
  };

  function taskCleanupTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench task cleanup handoff as task context.',
      '',
      'Operator intent:',
      '- Review the terminal task history cleanup preview before any destructive cleanup.',
      '- Check cutoff, status scope, eligible count, sample records, active task filters, task run trends, and approval history.',
      '- If cleanup looks risky, stale, or too broad, propose safer cleanup settings or supporting diagnostics.',
      '- Do not delete task history, retry tasks, or cancel tasks unless the task prompt is explicitly edited.',
      '',
      'Task cleanup handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromTaskCleanupReport = function() {
    if (!taskCenterData.cleanup || !taskCenterData.cleanup.preview) {
      showToast('Preview cleanup first', false);
      return;
    }
    var visible = filteredTaskCenterTasks();
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'taskCleanupReport',
      cleanup: taskCleanupReportPayload(),
      taskTrend: taskTrendReport(visible),
      visibleSamples: visible.slice(0, 12).map(taskTrendTaskSummary),
      selectedTasks: selectedTaskCenterTasks().slice(0, 24).map(taskTrendTaskSummary),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review task history cleanup: ' + String(payload.cleanup.eligibleCount || 0) + ' eligible',
      prompt: taskCleanupTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Task cleanup report loaded into task form', true);
  };

  window.setTaskCleanupField = function(key, value) {
    var cleanup = taskCenterData.cleanup;
    if (key === 'olderThanDays') {
      var days = Math.max(1, Math.min(3650, Math.floor(Number(value || 30))));
      cleanup.olderThanDays = Number.isFinite(days) ? days : 30;
    } else if (key === 'status') {
      cleanup.status = ['terminal', 'completed', 'failed', 'cancelled'].indexOf(value) >= 0 ? value : 'terminal';
    }
    cleanup.preview = null;
    cleanup.error = null;
    renderTasksHome();
  };

  window.previewTaskCleanup = async function() {
    var cleanup = taskCenterData.cleanup;
    cleanup.loading = true;
    cleanup.error = null;
    renderTasksHome();
    try {
      var params = new URLSearchParams();
      params.set('older_than_days', String(cleanup.olderThanDays || 30));
      params.set('status', cleanup.status || 'terminal');
      var res = await fetch('/api/tasks/cleanup?' + params.toString());
      var body = await readTaskActionResponse(res, 'task cleanup preview failed');
      cleanup.preview = body;
      showToast('Cleanup preview loaded: ' + (body.eligibleCount || 0), true);
    } catch (err) {
      cleanup.error = err.message || String(err);
      showToast('Cleanup preview failed', false);
    } finally {
      cleanup.loading = false;
      renderTasksHome();
    }
  };

  window.cleanupTaskHistory = async function() {
    var cleanup = taskCenterData.cleanup;
    var preview = cleanup.preview;
    var count = preview ? Number(preview.eligibleCount || 0) : 0;
    if (!count) {
      showToast('Preview cleanup first', false);
      return;
    }
    var label = cleanup.status || 'terminal';
    queueDangerApproval({
      title: 'Clean task history',
      target: count + ' ' + label + ' task records',
      detail: 'Delete task history records older than ' + (cleanup.olderThanDays || 30) + ' day(s). Result files are kept.',
      severity: 'critical',
      payload: {
        olderThanDays: cleanup.olderThanDays || 30,
        status: cleanup.status || 'terminal',
        preview: preview || null,
      },
    }, async function() {
    cleanup.loading = true;
    cleanup.error = null;
    renderTasksHome();
    try {
      var res = await fetch('/api/tasks/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          older_than_days: cleanup.olderThanDays || 30,
          status: cleanup.status || 'terminal',
          confirm: true,
        }),
      });
      var body = await readTaskActionResponse(res, 'task cleanup failed');
      cleanup.preview = body;
      taskCenterData.selected = {};
      showToast('Deleted ' + (body.deletedCount || 0) + ' task record(s)', true);
      loadTaskCenterTasks();
    } catch (err) {
      cleanup.error = err.message || String(err);
      showToast('Cleanup failed', false);
      throw err;
    } finally {
      cleanup.loading = false;
      renderTasksHome();
    }
    });
  };

  function renderCreateTaskForm() {
    var d = taskDraft || {};
    return '<form class="wb-form" id="create-task-form" onsubmit="submitCreateTask(event)">' +
      roleDatalistHtml() +
      '<div class="form-grid">' +
      '<label><span>Role</span><input name="role" list="role-options" value="' + esc(d.role || 'executor') + '" required></label>' +
      '<label><span>Provider</span><input name="agent" placeholder="default" value="' + esc(d.agent || '') + '"></label>' +
      '<label><span>Model</span><input name="model" placeholder="provider default" value="' + esc(d.model || '') + '"></label>' +
      '<label><span>Source</span><select name="source_director">' + sourceDirectorOptions(d.source_director || 'main') + '</select></label>' +
      '<label><span>Project Dir</span><input name="project_dir" placeholder="optional workspace path" value="' + esc(d.project_dir || '') + '"></label>' +
      '<label><span>Timeout Ms</span><input name="timeout_ms" type="number" min="1000" step="1000" placeholder="config default" value="' + esc(String(d.timeout_ms || '')) + '"></label>' +
      '<label><span>Max Retry</span><input name="max_retry" type="number" min="0" max="10" value="' + esc(String(d.max_retry == null ? 3 : d.max_retry)) + '"></label>' +
      '</div>' +
      '<label class="form-wide"><span>Description</span><input name="description" required placeholder="short task title" value="' + esc(d.description || '') + '"></label>' +
      '<label class="form-wide"><span>Prompt</span><textarea name="prompt" required rows="7" placeholder="full task briefing">' + esc(d.prompt || '') + '</textarea></label>' +
      '<div class="form-actions"><button class="mini-btn" type="button" onclick="toggleCreateTaskForm()">Cancel</button><button class="mini-btn primary" type="submit">Create & Run</button></div>' +
      '</form>';
  }

  window.toggleCreateTaskForm = function() {
    createTaskOpen = !createTaskOpen;
    if (!createTaskOpen) taskDraft = null;
    renderTasksHome();
  };

  window.submitCreateTask = async function(event) {
    event.preventDefault();
    var form = event.target;
    var fd = new FormData(form);
    var sourceDirector = String(fd.get('source_director') || 'main');
    var payload = {
      type: 'role',
      role: String(fd.get('role') || '').trim(),
      agent: String(fd.get('agent') || '').trim() || undefined,
      model: String(fd.get('model') || '').trim() || undefined,
      description: String(fd.get('description') || '').trim(),
      prompt: String(fd.get('prompt') || '').trim(),
      project_dir: String(fd.get('project_dir') || '').trim() || undefined,
      source_director: sourceDirector,
    };
    var timeout = Number(fd.get('timeout_ms') || 0);
    var retry = Number(fd.get('max_retry') || 0);
    if (timeout > 0) payload.timeout_ms = timeout;
    if (Number.isFinite(retry)) payload.max_retry = retry;

    try {
      queueDangerApproval({
        title: 'Create task run',
        target: payload.description || payload.role || 'task',
        detail: taskCreateApprovalDetail(payload),
        severity: taskCreateApprovalSeverity(payload),
        payload: payload,
      }, async function() {
        try {
          var res = await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          var body = await readTaskActionResponse(res, 'create task failed');
          createTaskOpen = false;
          taskDraft = null;
          showToast('Task created: ' + body.id, true);
          selectTask(body.id);
        } catch (err) {
          showToast('Create task failed: ' + err.message, false);
          throw err;
        }
      });
    } catch (err) {
      showToast('Create task failed: ' + err.message, false);
    }
  };

  function taskCreateApprovalSeverity(payload) {
    var retry = Number(payload && payload.max_retry != null ? payload.max_retry : 0);
    var timeout = Number(payload && payload.timeout_ms != null ? payload.timeout_ms : 0);
    if (retry > 3 || timeout >= 3600000) return 'high';
    return 'medium';
  }

  function taskCreateApprovalDetail(payload) {
    var parts = [
      'role ' + (payload.role || '--'),
      'source ' + (payload.source_director || 'main'),
    ];
    if (payload.agent) parts.push('provider ' + payload.agent);
    if (payload.model) parts.push('model ' + payload.model);
    if (payload.project_dir) parts.push('cwd ' + payload.project_dir);
    if (payload.timeout_ms) parts.push('timeout ' + payload.timeout_ms + 'ms');
    if (payload.max_retry != null) parts.push('max retry ' + payload.max_retry);
    parts.push('prompt ' + String(payload.prompt || '').length + ' chars');
    return parts.join(' · ');
  }

  function draftFromTask(t, prefix) {
    return {
      role: t.role || 'executor',
      agent: t.agent || '',
      model: taskExtraValue(t, 'model'),
      source_director: t.source_director || t.sourceDirector || 'main',
      project_dir: taskExtraValue(t, 'project_dir'),
      timeout_ms: t.timeout_ms || '',
      max_retry: t.max_retry == null ? 3 : t.max_retry,
      description: (prefix || '') + (t.description || t.id || ''),
      prompt: t.prompt || '',
    };
  }

  window.copyTaskAsNew = function(taskId) {
    var source = taskDetail && taskDetail.id === taskId ? taskDetail : null;
    if (!source) {
      source = (taskCenterData.tasks || []).find(function(t) { return t.id === taskId; }) || null;
    }
    if (!source) {
      showToast('Task data is not loaded yet', false);
      return;
    }
    taskDraft = draftFromTask(source, 'Copy: ');
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Task copied into create form', true);
  };

  window.retryTask = async function(taskId) {
    queueDangerApproval({
      title: 'Retry task',
      target: taskId,
      detail: 'Create and run a new task from the original task prompt and metadata.',
      severity: 'medium',
      payload: { taskId: taskId, sourceTask: taskDetail && taskDetail.id === taskId ? taskDetail : null },
    }, async function() {
      try {
        var res = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/retry', { method: 'POST' });
        var body = await readTaskActionResponse(res, 'retry task failed');
        showToast('Retry created: ' + body.id, true);
        selectTask(body.id);
      } catch (err) {
        showToast('Retry failed: ' + err.message, false);
        throw err;
      }
    });
  };

  async function readTaskActionResponse(res, fallback) {
    var text = await res.text();
    var body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (_) {
        body = { error: text };
      }
    }
    if (!res.ok || body.error || body.ok === false) throw new Error(body.error || fallback);
    return body;
  }

  window.bulkRetrySelectedTasks = async function() {
    var failed = selectedTaskCenterTasks().filter(function(t) { return t.status === 'failed'; });
    if (!failed.length) {
      showToast('No failed tasks selected', false);
      return;
    }
    queueDangerApproval({
      title: 'Retry failed tasks',
      target: failed.length + ' task(s)',
      detail: failed.map(function(t) { return t.id; }).slice(0, 8).join(', ') + (failed.length > 8 ? '...' : ''),
      severity: failed.length > 3 ? 'high' : 'medium',
      payload: { count: failed.length, taskIds: failed.map(function(t) { return t.id; }), tasks: failed },
    }, async function() {
      var created = [];
      var errors = [];
      for (var i = 0; i < failed.length; i++) {
        try {
          var res = await fetch('/api/tasks/' + encodeURIComponent(failed[i].id) + '/retry', { method: 'POST' });
          var body = await readTaskActionResponse(res, 'retry task failed');
          if (body.id) created.push(body.id);
        } catch (err) {
          errors.push(failed[i].id + ': ' + err.message);
        }
      }
      taskCenterData.selected = {};
      if (errors.length) {
        showToast('Retried ' + created.length + ', failed ' + errors.length, false);
        console.warn('Bulk retry errors', errors);
        throw new Error(errors.join('\n'));
      } else {
        showToast('Retry runs created: ' + created.length, true);
      }
      if (created.length === 1) selectTask(created[0]);
      else loadTaskCenterTasks();
    });
  };

  window.cancelTask = async function(taskId) {
    queueDangerApproval({
      title: 'Cancel task',
      target: taskId,
      detail: 'The running or dispatched task will be marked cancelled if it has not already finished.',
      severity: 'high',
      payload: { taskId: taskId, task: taskDetail && taskDetail.id === taskId ? taskDetail : null },
    }, async function() {
    try {
      var res = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/cancel', { method: 'POST' });
      var body = await res.json();
      if (!res.ok || body.error || body.ok === false) throw new Error(body.error || 'cancel task failed');
      showToast('Task cancelled', true);
      loadTaskDetail(taskId);
      loadTaskCenterTasks();
    } catch (err) {
      showToast('Cancel failed: ' + err.message, false);
      throw err;
    }
    });
  };

  window.bulkCancelSelectedTasks = async function() {
    var active = selectedTaskCenterTasks().filter(function(t) { return t.status === 'running' || t.status === 'dispatched'; });
    if (!active.length) {
      showToast('No active tasks selected', false);
      return;
    }
    queueDangerApproval({
      title: 'Bulk cancel active tasks',
      target: active.length + ' active task(s)',
      detail: active.map(function(t) { return t.id; }).join(', '),
      severity: 'critical',
      payload: { count: active.length, taskIds: active.map(function(t) { return t.id; }), tasks: active },
    }, async function() {
    var ok = 0;
    var errors = [];
    for (var i = 0; i < active.length; i++) {
      try {
        var res = await fetch('/api/tasks/' + encodeURIComponent(active[i].id) + '/cancel', { method: 'POST' });
        await readTaskActionResponse(res, 'cancel task failed');
        ok++;
      } catch (err) {
        errors.push(active[i].id + ': ' + err.message);
      }
    }
    taskCenterData.selected = {};
    if (errors.length) {
      showToast('Cancelled ' + ok + ', failed ' + errors.length, false);
      console.warn('Bulk cancel errors', errors);
    } else {
      showToast('Cancelled ' + ok + ' task(s)', true);
    }
    if (selectedTaskId) loadTaskDetail(selectedTaskId);
    loadTaskCenterTasks();
    });
  };

  function renderAutomationsView() {
    var visibleCronJobs = filteredCronJobs();
    var html = '<div class="page-grid">';
    var enabledCount = 0;
    var unhealthyCount = 0;
    for (var ci = 0; ci < cronJobs.length; ci++) {
      if (cronJobs[ci].enabled) enabledCount++;
      var healthForSummary = automationHealth(cronJobs[ci]);
      if (healthForSummary.level === 'failed' || healthForSummary.level === 'pending') unhealthyCount++;
    }
    html += '<div class="workbench-panel wide"><div class="panel-title"><span>Cron Jobs</span><div class="panel-actions"><button class="mini-btn" onclick="copyAutomationReport()">Copy Report</button><button class="mini-btn" onclick="exportAutomationReport()">Export Report</button><button class="mini-btn primary" onclick="createTaskFromAutomationReport()">Create Task</button><button class="mini-btn" onclick="refreshCronJobs()">Refresh</button><button class="mini-btn primary" onclick="toggleCreateCronForm()">' + (createCronOpen ? 'Close' : 'Create Cron') + '</button></div></div>';
    html += '<div class="automation-summary">';
    html += '<div><span>Active</span><strong>' + enabledCount + '</strong></div>';
    html += '<div><span>Total</span><strong>' + cronJobs.length + '</strong></div>';
    html += '<div><span>Visible</span><strong>' + visibleCronJobs.length + '</strong></div>';
    html += '<div><span>Runs</span><strong>' + cronRunData.tasks.length + '</strong></div>';
    html += '<div><span>Attention</span><strong>' + unhealthyCount + '</strong></div>';
    html += '<div><span>Scheduler</span><strong>' + esc(data && data.config && data.config.scheduler ? (data.config.scheduler.enabled === false ? 'disabled' : 'enabled') : 'unknown') + '</strong></div>';
    html += '</div>';
    html += renderAutomationFilters();
    if (createCronOpen) {
      html += renderCreateCronForm();
    }
    html += '<div class="panel-list automation-list">';
    if (cronJobs.length === 0) {
      html += '<div class="empty">No cron jobs</div>';
    } else if (visibleCronJobs.length === 0) {
      html += '<div class="empty">No cron jobs match the current filters.</div>';
    } else {
      for (var i = 0; i < visibleCronJobs.length; i++) {
        var c = visibleCronJobs[i];
        var selected = selectedAutomationCronId === c.id;
        var lastRun = c.last_run_at ? fmtAgo(new Date(c.last_run_at).getTime()) : '--';
        var updated = c.updated_at || '--';
        var nextRun = cronNextRunText(c);
        var health = automationHealth(c);
        html += '<div id="automation-row-' + esc(safeAssetName(c.id, 'cron')) + '" class="panel-row clickable automation-row' + (selected ? ' selected' : '') + '" onclick="selectAutomationCron(\'' + jsq(c.id) + '\')">';
        html += '<span class="item-icon" style="color:' + (c.enabled ? 'var(--green)' : 'var(--overlay0)') + '">&#9679;</span>';
        html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(c.name) + '</div>';
        html += '<div class="panel-row-sub">' + esc(c.schedule || '--') + ' · ' + esc(c.action_type || 'spawn_role') + ' · ' + esc(c.role || '--') + ' · last ' + esc(lastRun) + ' · next ' + esc(nextRun.label) + '</div></div>';
        html += '<span class="badge ' + esc(health.level) + '">' + esc(health.label) + '</span>';
        html += '<span class="badge ' + (c.enabled ? 'ok' : '') + '">' + (c.enabled ? 'enabled' : 'paused') + '</span>';
        html += '<div class="panel-actions" onclick="event.stopPropagation()">';
        html += '<button class="mini-btn primary" onclick="runCronNow(\'' + jsq(c.id) + '\',\'' + jsq(c.action_type || 'spawn_role') + '\',\'' + jsq(c.name || c.id) + '\')">Run Now</button>';
        html += '<button class="mini-btn" onclick="toggleCron(\'' + jsq(c.id) + '\')">' + (c.enabled ? 'Disable' : 'Enable') + '</button>';
        html += '<button class="mini-btn" onclick="toggleEditCron(\'' + jsq(c.id) + '\')">' + (editingCronId === c.id ? 'Close Edit' : 'Edit') + '</button>';
        html += '<button class="mini-btn" onclick="deleteCron(\'' + jsq(c.id) + '\')">Delete</button></div></div>';
        if (selected || editingCronId === c.id) {
          html += '<div class="automation-detail">';
          html += '<div class="kv-grid">';
          html += '<div class="kv-card"><div class="kv-label">ID</div><div class="kv-value">' + esc(c.id) + '</div></div>';
          html += '<div class="kv-card"><div class="kv-label">Source</div><div class="kv-value">' + esc(c.source_director || 'main') + '</div></div>';
          html += '<div class="kv-card"><div class="kv-label">Provider</div><div class="kv-value">' + esc(c.agent || 'default') + '</div></div>';
          html += '<div class="kv-card"><div class="kv-label">Retry / Timeout</div><div class="kv-value">' + esc(String(c.max_retry == null ? 3 : c.max_retry)) + ' / ' + esc(c.timeout_ms ? String(c.timeout_ms) + 'ms' : 'default') + '</div></div>';
          html += '<div class="kv-card"><div class="kv-label">Last Run</div><div class="kv-value">' + esc(c.last_run_at || '--') + '</div></div>';
          html += '<div class="kv-card"><div class="kv-label">Next Run</div><div class="kv-value">' + esc(nextRun.detail) + '</div></div>';
          html += '<div class="kv-card"><div class="kv-label">Health</div><div class="kv-value">' + esc(health.detail) + '</div></div>';
          html += '<div class="kv-card"><div class="kv-label">Updated</div><div class="kv-value">' + esc(updated) + '</div></div>';
          html += '</div>';
          if (health.lastError) html += '<div class="automation-copy automation-error"><div class="kv-label">Latest Error</div>' + esc(health.lastError) + '</div>';
          if (c.description) html += '<div class="automation-copy"><div class="kv-label">Description</div>' + esc(c.description) + '</div>';
          if (c.prompt) html += '<div class="automation-copy"><div class="kv-label">Prompt</div>' + esc(c.prompt) + '</div>';
          if (c.message) html += '<div class="automation-copy"><div class="kv-label">Director Message</div>' + esc(c.message) + '</div>';
          if (c.action_name) html += renderShellActionRisk(c.action_name, true);
          html += '<div class="panel-actions automation-detail-actions">';
          html += '<button class="mini-btn primary" onclick="createTaskFromCronJob(\'' + jsq(c.id) + '\')">Create Task</button>';
          html += '<button class="mini-btn" onclick="copyCronJobJson(\'' + jsq(c.id) + '\')">Copy Job JSON</button>';
          html += '<button class="mini-btn" onclick="exportCronJobJson(\'' + jsq(c.id) + '\')">Export Job</button>';
          html += '<button class="mini-btn" onclick="openCronSourceDirector(\'' + jsq(c.id) + '\')">Open Source Director</button>';
          html += '<button class="mini-btn" onclick="openCronRunsInTasks(\'' + jsq(c.id) + '\')">Show Runs in Tasks</button>';
          html += '</div>';
          html += renderCronRunHistory(c);
          html += renderCronAuditTrail(c);
          if (editingCronId === c.id) html += renderEditCronForm(c);
          html += '</div>';
        }
      }
    }
    html += '</div></div></div>';
    $('detail-content').innerHTML = html;
  }

  function cronHealthFilterValue(c) {
    var health = automationHealth(c);
    if (!c.enabled) return 'paused';
    if (health.label === 'critical') return 'critical';
    if (health.label === 'attention') return 'attention';
    if (health.label === 'new') return 'new';
    if (health.label === 'running') return 'running';
    if (health.label === 'healthy') return 'healthy';
    return health.level || 'unknown';
  }

  function cronSearchText(c) {
    var health = automationHealth(c);
    return [
      c.id,
      c.name,
      c.schedule,
      c.action_type,
      c.role,
      c.agent,
      c.source_director || 'main',
      c.description,
      c.prompt,
      c.message,
      c.action_name,
      c.enabled ? 'enabled' : 'paused',
      health.label,
      health.detail,
      health.lastError,
    ].filter(Boolean).join('\n').toLowerCase();
  }

  function filteredCronJobs() {
    var filters = automationFilters || {};
    var query = String(filters.query || '').trim().toLowerCase();
    return (cronJobs || []).filter(function(c) {
      if ((filters.status || 'all') === 'enabled' && !c.enabled) return false;
      if ((filters.status || 'all') === 'paused' && c.enabled) return false;
      if ((filters.action || 'all') !== 'all' && (c.action_type || 'spawn_role') !== filters.action) return false;
      if ((filters.source || 'all') !== 'all' && (c.source_director || 'main') !== filters.source) return false;
      if ((filters.health || 'all') !== 'all' && cronHealthFilterValue(c) !== filters.health) return false;
      if (query && cronSearchText(c).indexOf(query) < 0) return false;
      return true;
    });
  }

  function automationJobReport(c) {
    var runs = cronRunsFor(c.id);
    var health = automationHealth(c);
    var nextRun = cronNextRunText(c);
    return {
      id: c.id || '',
      name: c.name || '',
      enabled: !!c.enabled,
      schedule: c.schedule || '',
      actionType: c.action_type || 'spawn_role',
      role: c.role || '',
      agent: c.agent || '',
      model: c.model || '',
      sourceDirector: c.source_director || 'main',
      description: c.description || '',
      promptPreview: c.prompt ? shortText(c.prompt, 600) : '',
      messagePreview: c.message ? shortText(c.message, 600) : '',
      shellAction: c.action_name || '',
      lastRunAt: c.last_run_at || '',
      nextRun: nextRun,
      health: health,
      recentRuns: runs.map(function(t) {
        return {
          id: t.id || '',
          status: t.status || 'pending',
          role: t.role || '',
          agent: t.agent || '',
          model: taskExtraValue(t, 'model'),
          createdAt: t.created_at || t.createdAt || '',
          startedAt: t.started_at || t.startedAt || '',
          completedAt: t.completed_at || t.completedAt || '',
          durationMs: t.duration_ms != null ? t.duration_ms : t.durationMs,
          costUsd: t.cost_usd != null ? t.cost_usd : t.costUsd,
          resultFile: t.result_file || t.resultFile || '',
          error: t.error || '',
        };
      }),
      audit: cronAuditEntriesFor(c.id),
    };
  }

  function automationReportPayload() {
    var visible = filteredCronJobs();
    var enabledCount = 0;
    var attention = [];
    for (var i = 0; i < cronJobs.length; i++) {
      if (cronJobs[i].enabled) enabledCount++;
      var health = automationHealth(cronJobs[i]);
      if (health.level === 'failed' || health.level === 'pending') attention.push({ id: cronJobs[i].id, name: cronJobs[i].name, health: health });
    }
    return {
      exportedAt: new Date().toISOString(),
      filters: Object.assign({}, automationFilters || {}),
      scheduler: data && data.config && data.config.scheduler ? data.config.scheduler : null,
      summary: {
        total: cronJobs.length,
        enabled: enabledCount,
        visible: visible.length,
        recentRuns: cronRunData.tasks.length,
        attention: attention.length,
      },
      attention: attention,
      visibleJobs: visible.map(automationJobReport),
      runData: {
        loading: !!cronRunData.loading,
        error: cronRunData.error || '',
        loadedTasks: cronRunData.tasks.length,
      },
      audit: {
        loading: !!auditData.loading,
        error: auditData.error || '',
        loadedEntries: (auditData.entries || []).length,
      },
    };
  }

  function automationReportTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench automation report as task context.',
      '',
      'Operator intent:',
      '- Review the currently filtered automation inventory, scheduler state, health summary, recent runs, and audit loading state.',
      '- Identify failing, stale, noisy, unsafe, or misconfigured Cron jobs and propose or implement scoped fixes.',
      '- If the report is filtered, respect that scope first, then mention any broader risk that is visible in the summary.',
      '- Preserve existing schedule/action semantics unless the task prompt is edited.',
      '',
      'Automation report handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.copyAutomationReport = function() {
    copyText(JSON.stringify(automationReportPayload(), null, 2));
  };

  window.exportAutomationReport = function() {
    downloadTextFile('persona-automations-report-' + Date.now() + '.json', JSON.stringify(automationReportPayload(), null, 2));
    showToast('Automation report exported', true);
  };

  window.createTaskFromAutomationReport = function() {
    var report = automationReportPayload();
    var handoff = {
      type: 'automationReport',
      report: report,
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review automations report: ' + (report.summary.visible || 0) + ' visible / ' + (report.summary.attention || 0) + ' attention',
      prompt: automationReportTaskPromptPayload(handoff),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Automation report loaded into task form', true);
  };

  function cronFilterOptions(field) {
    var seen = {};
    var options = [];
    for (var i = 0; i < cronJobs.length; i++) {
      var c = cronJobs[i];
      var value = '';
      if (field === 'action') value = c.action_type || 'spawn_role';
      if (field === 'source') value = c.source_director || 'main';
      if (field === 'health') value = cronHealthFilterValue(c);
      if (!value || seen[value]) continue;
      seen[value] = true;
      options.push(value);
    }
    return options.sort();
  }

  function renderAutomationFilters() {
    var filters = automationFilters || {};
    var actions = cronFilterOptions('action');
    var sources = cronFilterOptions('source');
    var healthOptions = cronFilterOptions('health');
    var healthLabels = {
      healthy: 'Healthy',
      running: 'Running',
      attention: 'Attention',
      critical: 'Critical',
      new: 'New',
      paused: 'Paused',
    };
    var html = '<div class="automation-filters">';
    html += '<label class="automation-filter-search"><span>Search</span><input value="' + esc(filters.query || '') + '" placeholder="name, prompt, action, source..." oninput="setAutomationFilter(\'query\', this.value)"></label>';
    html += '<label><span>Status</span><select onchange="setAutomationFilter(\'status\', this.value)">';
    var statuses = [['all', 'All'], ['enabled', 'Enabled'], ['paused', 'Paused']];
    for (var s = 0; s < statuses.length; s++) {
      html += '<option value="' + statuses[s][0] + '"' + ((filters.status || 'all') === statuses[s][0] ? ' selected' : '') + '>' + statuses[s][1] + '</option>';
    }
    html += '</select></label>';
    html += '<label><span>Action</span><select onchange="setAutomationFilter(\'action\', this.value)"><option value="all"' + ((filters.action || 'all') === 'all' ? ' selected' : '') + '>All actions</option>';
    for (var ai = 0; ai < actions.length; ai++) {
      html += '<option value="' + esc(actions[ai]) + '"' + (filters.action === actions[ai] ? ' selected' : '') + '>' + esc(actions[ai]) + '</option>';
    }
    html += '</select></label>';
    html += '<label><span>Health</span><select onchange="setAutomationFilter(\'health\', this.value)"><option value="all"' + ((filters.health || 'all') === 'all' ? ' selected' : '') + '>All health</option>';
    for (var hi = 0; hi < healthOptions.length; hi++) {
      html += '<option value="' + esc(healthOptions[hi]) + '"' + (filters.health === healthOptions[hi] ? ' selected' : '') + '>' + esc(healthLabels[healthOptions[hi]] || healthOptions[hi]) + '</option>';
    }
    html += '</select></label>';
    html += '<label><span>Source</span><select onchange="setAutomationFilter(\'source\', this.value)"><option value="all"' + ((filters.source || 'all') === 'all' ? ' selected' : '') + '>All sources</option>';
    for (var si = 0; si < sources.length; si++) {
      html += '<option value="' + esc(sources[si]) + '"' + (filters.source === sources[si] ? ' selected' : '') + '>' + esc(sources[si]) + '</option>';
    }
    html += '</select></label>';
    html += '<button class="mini-btn" onclick="clearAutomationFilters()">Clear</button>';
    html += '</div>';
    return html;
  }

  window.setAutomationFilter = function(key, value) {
    automationFilters = automationFilters || { query: '', status: 'all', action: 'all', health: 'all', source: 'all' };
    if (key === 'query') automationFilters.query = String(value || '');
    if (key === 'status') automationFilters.status = value || 'all';
    if (key === 'action') automationFilters.action = value || 'all';
    if (key === 'health') automationFilters.health = value || 'all';
    if (key === 'source') automationFilters.source = value || 'all';
    renderAutomationsView();
  };

  window.clearAutomationFilters = function() {
    automationFilters = { query: '', status: 'all', action: 'all', health: 'all', source: 'all' };
    renderAutomationsView();
  };

  function cronRunMatchesJob(task, job, cronId) {
    if (!task) return false;
    var extra = task.extra || {};
    if (extra.cronJobId === cronId) return true;
    if (!job || task.type !== 'cron' || extra.cronJobId) return false;
    if (job.description && task.description === job.description) return true;
    var daily = String(job.schedule || '').match(/^daily\s+(\d{2}):(\d{2})$/);
    var taskHour = String(task.id || '').match(/^T-\d{4}-(\d{2})-/);
    if (daily && taskHour && taskHour[1] === daily[1]) return true;
    return false;
  }

  function cronRunsFor(cronId) {
    var job = cronJobById(cronId);
    return (cronRunData.tasks || []).filter(function(t) {
      return cronRunMatchesJob(t, job, cronId);
    }).sort(function(a, b) {
      var at = new Date(a.completed_at || a.started_at || a.created_at || a.createdAt || 0).getTime();
      var bt = new Date(b.completed_at || b.started_at || b.created_at || b.createdAt || 0).getTime();
      return bt - at;
    }).slice(0, 8);
  }

  function fmtFuture(ts) {
    if (!ts) return '--';
    if (uiPreferences && uiPreferences.timeFormat === 'absolute') return fmtTimestamp(ts);
    var d = ts - Date.now();
    if (d <= 0) return 'due now';
    if (d < 60000) return 'in ' + Math.ceil(d / 1000) + 's';
    if (d < 3600000) return 'in ' + Math.ceil(d / 60000) + 'm';
    if (d < 86400000) return 'in ' + Math.ceil(d / 3600000) + 'h';
    return 'in ' + Math.ceil(d / 86400000) + 'd';
  }

  function cronNextRunAt(c) {
    if (!c || !c.enabled) return null;
    var schedule = String(c.schedule || '').trim();
    var now = new Date();
    var every = schedule.match(/^every\s+(\d+)([mh])$/i);
    if (every) {
      var n = Number(every[1]);
      var unit = every[2].toLowerCase();
      var interval = n * (unit === 'h' ? 3600000 : 60000);
      var base = c.last_run_at ? new Date(c.last_run_at).getTime() : Date.now();
      var next = base + interval;
      if (!c.last_run_at || next <= Date.now()) return Date.now();
      return next;
    }
    var daily = schedule.match(/^daily\s+(\d{2}):(\d{2})$/);
    if (daily) {
      var target = new Date(now);
      target.setHours(Number(daily[1]), Number(daily[2]), 0, 0);
      var last = c.last_run_at ? new Date(c.last_run_at) : null;
      var ranToday = last &&
        last.getFullYear() === now.getFullYear() &&
        last.getMonth() === now.getMonth() &&
        last.getDate() === now.getDate();
      if (ranToday || target.getTime() <= Date.now()) {
        if (!ranToday && target.getTime() <= Date.now()) return Date.now();
        target.setDate(target.getDate() + 1);
      }
      return target.getTime();
    }
    return null;
  }

  function cronNextRunText(c) {
    if (!c.enabled) return { label: 'paused', detail: 'Paused' };
    var next = cronNextRunAt(c);
    if (!next) return { label: 'unknown', detail: 'Unknown schedule' };
    var label = fmtFuture(next);
    return { label: label, detail: label + ' · ' + fmtTimestamp(next) };
  }

  function automationHealth(c) {
    if (!c.enabled) return { level: 'cancelled', label: 'paused', detail: 'Paused', failures: 0, lastError: '' };
    var runs = cronRunsFor(c.id);
    var running = runs.some(function(t) { return t.status === 'running' || t.status === 'dispatched'; });
    if (running) return { level: 'running', label: 'running', detail: 'Run in progress', failures: 0, lastError: '' };
    var failures = 0;
    var lastError = '';
    for (var i = 0; i < runs.length; i++) {
      if (runs[i].status === 'failed' || runs[i].error) {
        failures++;
        if (!lastError) lastError = runs[i].error || runs[i].description || runs[i].id || '';
      } else {
        break;
      }
    }
    if (failures >= 3) return { level: 'failed', label: 'critical', detail: failures + ' consecutive failures', failures: failures, lastError: lastError };
    if (failures > 0) return { level: 'pending', label: 'attention', detail: failures + ' recent failure' + (failures > 1 ? 's' : ''), failures: failures, lastError: lastError };
    if (runs.length === 0) return { level: 'pending', label: 'new', detail: 'No recent linked runs', failures: 0, lastError: '' };
    return { level: 'ok', label: 'healthy', detail: 'Latest linked runs are healthy', failures: 0, lastError: '' };
  }

  function renderCronRunHistory(c) {
    var runs = cronRunsFor(c.id);
    var html = '<div class="cron-run-history">';
    html += '<div class="panel-title"><span>Recent Runs</span><div class="panel-actions"><span>' + runs.length + '</span>';
    if (runs.length > 0) {
      html += '<button class="mini-btn" onclick="event.stopPropagation();copyCronRuns(\'' + jsq(c.id) + '\')">Copy Runs</button>';
      html += '<button class="mini-btn" onclick="event.stopPropagation();exportCronRuns(\'' + jsq(c.id) + '\')">Export Runs</button>';
      html += '<button class="mini-btn primary" onclick="event.stopPropagation();createTaskFromCronRuns(\'' + jsq(c.id) + '\')">Create Task</button>';
    }
    html += '<button class="mini-btn" onclick="event.stopPropagation();loadCronRuns()">Refresh Runs</button></div></div>';
    if (cronRunData.loading) {
      html += '<div class="empty">Loading runs...</div>';
    } else if (cronRunData.error) {
      html += '<div class="td-error">' + esc(cronRunData.error) + '</div>';
    } else if (runs.length === 0) {
      html += '<div class="empty">No linked task runs found in the recent task window.</div>';
    } else {
      html += '<div class="panel-list cron-run-list">';
      for (var i = 0; i < runs.length; i++) {
        var t = runs[i];
        html += '<div class="panel-row clickable cron-run-row" onclick="event.stopPropagation();selectTask(\'' + jsq(t.id) + '\')">';
        html += '<span class="badge ' + esc(t.status || 'pending') + '">' + esc(t.status || 'pending') + '</span>';
        html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(t.description || t.id) + '</div>';
        html += '<div class="panel-row-sub">' + esc(t.id) + ' · ' + taskTimeText(t) + taskMetaText(t) + (t.result_file ? ' · result ready' : '') + (t.error ? ' · error ' + esc(shortText(t.error, 80)) : '') + '</div></div>';
        html += '<div class="cron-run-actions">';
	        html += '<button class="mini-btn" onclick="event.stopPropagation();selectTask(\'' + jsq(t.id) + '\')">Open</button>';
	        if (t.result_file) html += '<button class="mini-btn" onclick="event.stopPropagation();openWorkbenchFile(\'' + jsq(t.result_file) + '\')">Result</button>';
	        if (t.result_file) html += '<button class="mini-btn" onclick="event.stopPropagation();sendWorkbenchFile(\'' + jsq(t.result_file) + '\')">Send Result</button>';
        html += '<button class="mini-btn" onclick="event.stopPropagation();copyCronRunLogs(\'' + jsq(t.id) + '\')">Copy Logs</button>';
        html += '<button class="mini-btn" onclick="event.stopPropagation();exportCronRunLogs(\'' + jsq(t.id) + '\')">Export Logs</button>';
        html += '<button class="mini-btn" onclick="event.stopPropagation();copyCronRunJson(\'' + jsq(t.id) + '\')">Copy</button>';
        html += '<button class="mini-btn" onclick="event.stopPropagation();exportCronRunJson(\'' + jsq(t.id) + '\')">Export JSON</button>';
        html += '<button class="mini-btn primary" onclick="event.stopPropagation();createTaskFromCronRun(\'' + jsq(t.id) + '\')">Create Task</button>';
        html += '</div></div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function cronAuditEntriesFor(cronId) {
    return (auditData.entries || []).filter(function(entry) {
      if (!entry || String(entry.action || '').indexOf('cron.') !== 0) return false;
      var detail = entry.detail || {};
      if (entry.target === cronId || detail.target === cronId) return true;
	      var result = detail.result || {};
	      var task = result && result.task || {};
	      var extra = task && task.extra || {};
	      return result && (result.cronJobId === cronId || extra.cronJobId === cronId);
    }).slice(0, 12);
  }

	  function cronEvidencePayload(cronId) {
	    var job = cronJobById(cronId);
	    return {
      exportedAt: new Date().toISOString(),
      cronId: cronId,
      job: job,
      health: job ? automationHealth(job) : null,
      runs: cronRunsFor(cronId),
      audit: cronAuditEntriesFor(cronId),
	      auditError: auditData.error || null,
	    };
	  }

  function cronTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench cron handoff as task context.',
      '',
      'Operator intent:',
      '- Review this automation configuration, health state, recent runs, and audit trail.',
      '- If it is failing or stale, identify the likely cause and propose or implement a concrete fix.',
      '- Preserve the existing schedule/action semantics unless the task explicitly changes them.',
      '',
      'Cron handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function cronRunTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench cron run handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate or follow up this specific automation run.',
      '- Review the run record, logs, linked Cron job, health, recent runs, and audit trail before acting.',
      '- If the run failed or produced a suspicious result, identify the likely cause and propose or implement a concrete fix.',
      '- Preserve the existing schedule/action semantics unless the task prompt is edited.',
      '',
      'Cron run handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function cronRunsTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench cron runs report as task context.',
      '',
      'Operator intent:',
      '- Review this automation run history as a batch, not only one run.',
      '- Identify repeated failures, flaky runs, stale schedules, missing result artifacts, noisy outputs, or provider/model/role patterns.',
      '- Compare the run history with the Cron job configuration, health, audit trail, runtime snapshot, and approval context before acting.',
      '- Preserve the existing schedule/action semantics unless the task prompt is edited.',
      '',
      'Cron runs handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function cronAuditTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench cron audit handoff as task context.',
      '',
      'Operator intent:',
      '- Review this specific automation audit event.',
      '- If it failed, identify the likely cause and propose or implement a scoped fix.',
      '- If it succeeded but changed schedule/action state, verify the resulting Cron job behavior.',
      '- Use the audit entry first, then compare it with the Cron job evidence, recent runs, and audit trail.',
      '',
      'Cron audit handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function cronEvidenceTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench cron evidence bundle as task context.',
      '',
      'Operator intent:',
      '- Review this automation evidence bundle, including configuration, health, recent runs, and audit events.',
      '- If the automation is failing, stale, noisy, or unsafe, identify the likely cause and propose or implement a scoped fix.',
      '- Cross-check the evidence with the current runtime snapshot and approval state before making changes.',
      '- Preserve the existing schedule/action semantics unless the task prompt is edited.',
      '',
      'Cron evidence handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

	  function cronAuditEntryTarget(entry, fallbackCronId) {
	    var detail = entry && entry.detail || {};
	    var result = detail.result || {};
	    var task = result.task || {};
	    if (result.taskId) return { kind: 'task', id: result.taskId };
	    if (task.id) return { kind: 'task', id: task.id };
	    if (task.result_file || task.resultFile) return { kind: 'file', path: task.result_file || task.resultFile };
	    if (result.director) return { kind: 'director', label: result.director };
	    if (detail.sourceDirector) return { kind: 'director', label: detail.sourceDirector };
	    if (entry && entry.target || fallbackCronId) return { kind: 'cron', id: entry && entry.target || fallbackCronId };
	    return null;
	  }

	  function cronAuditEntryCanOpen(entry) {
	    return !!cronAuditEntryTarget(entry);
	  }

	  function cronRunsPayload(cronId) {
    var job = cronJobById(cronId);
    var runs = cronRunsFor(cronId);
    return {
      cronId: cronId,
      exportedAt: new Date().toISOString(),
      job: job ? automationJobReport(job) : null,
      filters: Object.assign({}, automationFilters || {}),
      runData: {
        loading: !!cronRunData.loading,
        error: cronRunData.error || '',
        loadedTasks: (cronRunData.tasks || []).length,
      },
      runs: runs,
    };
  }

  function renderCronAuditTrail(c) {
    var entries = cronAuditEntriesFor(c.id);
    var html = '<div class="cron-audit-trail">';
    html += '<div class="panel-title"><span>Audit Trail</span><div class="panel-actions">';
    html += '<span>' + entries.length + '</span>';
    html += '<button class="mini-btn" onclick="event.stopPropagation();loadAuditLog()">' + (auditData.loading ? 'Loading...' : 'Refresh Audit') + '</button>';
    html += '<button class="mini-btn" onclick="event.stopPropagation();copyCronEvidenceBundle(\'' + jsq(c.id) + '\')">Copy Evidence</button>';
    html += '<button class="mini-btn" onclick="event.stopPropagation();exportCronEvidenceBundle(\'' + jsq(c.id) + '\')">Export Evidence</button>';
    html += '<button class="mini-btn primary" onclick="event.stopPropagation();createTaskFromCronEvidenceBundle(\'' + jsq(c.id) + '\')">Create Task</button>';
    html += '</div></div>';
    if (auditData.loading) {
      html += '<div class="empty">Loading audit trail...</div>';
    } else if (auditData.error) {
      html += '<div class="td-error compact">' + esc(auditData.error) + '</div>';
    } else if (entries.length === 0) {
      html += '<div class="empty compact">No Web Console cron operations found for this job in the recent audit window.</div>';
    } else {
      html += '<div class="audit-list cron-audit-list">';
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var detail = entry.detail || {};
        var detailParts = [];
        if (detail.actionType) detailParts.push('action ' + detail.actionType);
        if (detail.schedule) detailParts.push('schedule ' + detail.schedule);
        if (detail.enabled != null) detailParts.push(detail.enabled ? 'enabled' : 'paused');
        if (detail.error) detailParts.push('error ' + shortText(detail.error, 120));
        if (detail.result && detail.result.taskId) detailParts.push('task ' + detail.result.taskId);
        html += '<div class="audit-row cron-audit-row">';
        html += '<span class="badge ' + (entry.ok ? 'completed' : 'failed') + '">' + (entry.ok ? 'ok' : 'fail') + '</span>';
        html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(entry.action || 'cron.operation') + '</div>';
	        html += '<div class="panel-row-sub">' + esc(fmtTimestamp(Date.parse(entry.timestamp)) || entry.timestamp || '--') + (detailParts.length ? ' · ' + esc(detailParts.join(' · ')) : '') + '</div></div>';
	        html += '<div class="audit-row-actions">';
	        if (cronAuditEntryCanOpen(entry)) html += '<button class="chat-msg-action" onclick="event.stopPropagation();openCronAuditTarget(\'' + jsq(c.id) + '\',' + i + ')">Open Target</button>';
	        html += '<button class="chat-msg-action" onclick="event.stopPropagation();copyCronAuditEntry(\'' + jsq(c.id) + '\',' + i + ')">Copy</button>';
        html += '<button class="chat-msg-action" onclick="event.stopPropagation();exportCronAuditEntry(\'' + jsq(c.id) + '\',' + i + ')">Export</button>';
        html += '<button class="chat-msg-action" onclick="event.stopPropagation();createTaskFromCronAuditEntry(\'' + jsq(c.id) + '\',' + i + ')">Create Task</button>';
        html += '</div>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function cronRunById(taskId) {
    return (cronRunData.tasks || []).find(function(t) { return t && t.id === taskId; }) || null;
  }

  function cronIdForRun(run) {
    if (!run) return '';
    var extra = run.extra || {};
    if (extra.cronJobId) return extra.cronJobId;
    for (var i = 0; i < (cronJobs || []).length; i++) {
      var job = cronJobs[i];
      if (job && cronRunMatchesJob(run, job, job.id)) return job.id;
    }
    return '';
  }

  function cronJobById(cronId) {
    return (cronJobs || []).find(function(c) { return c && c.id === cronId; }) || null;
  }

  window.copyCronJobJson = function(cronId) {
    var job = cronJobById(cronId);
    if (!job) {
      showToast('Cron job not found', false);
      return;
    }
    copyText(JSON.stringify(job, null, 2));
  };

  window.exportCronJobJson = function(cronId) {
    var job = cronJobById(cronId);
    if (!job) {
      showToast('Cron job not found', false);
      return;
    }
    downloadTextFile('persona-cron-job-' + String(cronId || 'cron').replace(/[^a-z0-9._-]+/gi, '-') + '-' + Date.now() + '.json', JSON.stringify(job, null, 2));
    showToast('Cron job exported', true);
  };

  window.createTaskFromCronJob = function(cronId) {
    var job = cronJobById(cronId);
    if (!job) {
      showToast('Cron job not found', false);
      return;
    }
    var payload = cronEvidencePayload(cronId);
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: job.source_director || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Follow up automation: ' + (job.name || cronId),
      prompt: cronTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Cron handoff loaded into task form', true);
  };

  window.createTaskFromCronEvidenceBundle = function(cronId) {
    var payload = cronEvidencePayload(cronId);
    var job = payload.job || cronJobById(cronId);
    if (!job) {
      showToast('Cron evidence not found', false);
      return;
    }
    var handoff = {
      type: 'cronEvidenceBundle',
      evidence: payload,
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: job.source_director || job.sourceDirector || 'main',
      project_dir: job.project_dir || job.projectDir || job.cwd || '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review cron evidence: ' + (job.name || cronId),
      prompt: cronEvidenceTaskPromptPayload(handoff),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Cron evidence loaded into task form', true);
  };

  window.openCronSourceDirector = function(cronId) {
    var job = cronJobById(cronId);
    if (!job) {
      showToast('Cron job not found', false);
      return;
    }
    var director = job.source_director || 'main';
    if (director && director !== 'main') {
      selectPoolDirector(director, director);
    } else {
      selectSession(null);
    }
  };

  window.openCronRunsInTasks = function(cronId) {
    taskCenterData.filters = {
      status: 'all',
      role: '',
      source: 'all',
      provider: '',
      model: '',
      cronJobId: cronId || '',
      day: '',
    };
    taskCenterData.selected = {};
    selectNav('tasks');
  };

  window.copyCronRunJson = function(taskId) {
    var run = cronRunById(taskId);
    if (!run) {
      showToast('Cron run not found', false);
      return;
    }
    copyText(JSON.stringify(run, null, 2));
  };

  window.exportCronRunJson = function(taskId) {
    var run = cronRunById(taskId);
    if (!run) {
      showToast('Cron run not found', false);
      return;
    }
    var safe = String(taskId || 'cron-run').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-cron-run-' + safe + '-' + Date.now() + '.json', JSON.stringify(run, null, 2));
    showToast('Cron run exported', true);
  };

  window.createTaskFromCronRun = async function(taskId) {
    var run = cronRunById(taskId);
    if (!run) {
      showToast('Cron run not found', false);
      return;
    }
    var cronId = cronIdForRun(run);
    var logs = null;
    try {
      logs = await fetchCronRunLogs(taskId);
    } catch (err) {
      logs = { error: String(err && err.message || err), entries: [] };
      showToast('Creating cron run task without logs: ' + logs.error, false);
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'cronRun',
      cronId: cronId || null,
      run: run,
      logs: logs,
      evidence: cronId ? cronEvidencePayload(cronId) : null,
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: run.source_director || run.sourceDirector || (cronId && cronJobById(cronId) && cronJobById(cronId).source_director) || 'main',
      project_dir: taskExtraValue(run, 'project_dir') || '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Follow up cron run: ' + (run.description || run.id || taskId),
      prompt: cronRunTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Cron run handoff loaded into task form', true);
  };

  async function fetchCronRunLogs(taskId) {
    var res = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/logs');
    var body = await res.json().catch(function() { return {}; });
    if (!res.ok || body.error) throw new Error(body.error || 'cron run logs request failed');
    return {
      exportedAt: new Date().toISOString(),
      taskId: taskId,
      totalLines: body.totalLines || 0,
      entries: (body.entries || []).map(function(entry) {
        return {
          line: entry.line,
          type: taskLogType(entry),
          rawType: entry.type,
          content: entry.content || '',
          meta: entry.meta || null,
        };
      }),
    };
  }

  window.copyCronRunLogs = async function(taskId) {
    try {
      var logs = await fetchCronRunLogs(taskId);
      if (!logs.entries.length) {
        showToast('No cron run logs to copy', false);
        return;
      }
      copyText(JSON.stringify(logs, null, 2));
    } catch (err) {
      showToast('Copy logs failed: ' + err.message, false);
    }
  };

  window.exportCronRunLogs = async function(taskId) {
    try {
      var logs = await fetchCronRunLogs(taskId);
      if (!logs.entries.length) {
        showToast('No cron run logs to export', false);
        return;
      }
      var safe = String(taskId || 'cron-run').replace(/[^a-z0-9._-]+/gi, '-');
      downloadTextFile('persona-' + safe + '-cron-run-logs-' + Date.now() + '.json', JSON.stringify(logs, null, 2));
      showToast('Cron run logs exported', true);
    } catch (err) {
      showToast('Export logs failed: ' + err.message, false);
    }
  };

  window.exportCronRuns = function(cronId) {
    var runs = cronRunsFor(cronId);
    if (!runs.length) {
      showToast('No cron runs to export', false);
      return;
    }
    downloadTextFile('persona-cron-runs-' + String(cronId || 'cron').replace(/[^a-z0-9._-]+/gi, '-') + '-' + Date.now() + '.json', JSON.stringify(cronRunsPayload(cronId), null, 2));
    showToast('Cron runs exported', true);
  };

  window.copyCronRuns = function(cronId) {
    var runs = cronRunsFor(cronId);
    if (!runs.length) {
      showToast('No cron runs to copy', false);
      return;
    }
    copyText(JSON.stringify(cronRunsPayload(cronId), null, 2));
  };

  window.createTaskFromCronRuns = function(cronId) {
    var payload = cronRunsPayload(cronId);
    var runs = payload.runs || [];
    if (!runs.length) {
      showToast('No cron runs to turn into a task', false);
      return;
    }
    var job = cronJobById(cronId);
    var failed = runs.filter(function(run) { return run.status === 'failed' || run.error; }).length;
    var active = runs.filter(function(run) { return run.status === 'running' || run.status === 'dispatched'; }).length;
    var handoff = {
      exportedAt: new Date().toISOString(),
      type: 'cronRunsReport',
      runsReport: payload,
      evidence: cronEvidencePayload(cronId),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: job && (job.source_director || job.sourceDirector) || 'main',
      project_dir: job && (job.project_dir || job.projectDir || job.cwd) || '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review cron run history: ' + (job && job.name || cronId) + ' · ' + String(runs.length) + ' run(s) · ' + String(failed) + ' failed · ' + String(active) + ' active',
      prompt: cronRunsTaskPromptPayload(handoff),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Cron runs loaded into task form', true);
  };

  function cronAuditEntryPayload(cronId, index) {
    var entries = cronAuditEntriesFor(cronId);
    var entry = entries[index] || null;
    return {
      exportedAt: new Date().toISOString(),
      cronId: cronId,
      index: index,
      job: cronJobById(cronId),
      entry: entry,
      auditError: auditData.error || null,
    };
  }

	  window.copyCronAuditEntry = function(cronId, index) {
	    var payload = cronAuditEntryPayload(cronId, index);
	    if (!payload.entry) {
	      showToast('Cron audit entry not found', false);
      return;
    }
	    copyText(JSON.stringify(payload, null, 2));
	  };

	  window.openCronAuditTarget = function(cronId, index) {
	    var entry = cronAuditEntriesFor(cronId)[index];
	    var target = cronAuditEntryTarget(entry, cronId);
	    if (!target) {
	      showToast('Cron audit target not found', false);
	      return;
	    }
	    if (target.kind === 'task') {
	      selectTask(target.id);
	      return;
	    }
	    if (target.kind === 'file') {
	      openWorkbenchFile(target.path);
	      return;
	    }
	    if (target.kind === 'director') {
	      if (target.label && target.label !== 'main') selectPoolDirector(target.label, target.label);
	      else selectSession(null);
	      return;
	    }
	    if (target.kind === 'cron') {
	      selectedAutomationCronId = target.id || cronId;
	      editingCronId = null;
	      selectNav('automations');
	    }
	  };

  window.createTaskFromCronAuditEntry = function(cronId, index) {
    var payload = cronAuditEntryPayload(cronId, index);
    if (!payload.entry) {
      showToast('Cron audit entry not found', false);
      return;
    }
    var entry = payload.entry || {};
    var job = payload.job || {};
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: job.source_director || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: (entry.ok ? 'Review cron audit: ' : 'Investigate cron audit failure: ') + shortText((entry.action || 'cron operation') + ' ' + (job.name || cronId || ''), 80),
      prompt: cronAuditTaskPromptPayload({
        type: 'cronAuditEntry',
        auditEntry: payload,
        evidence: cronEvidencePayload(cronId),
        target: cronAuditEntryTarget(entry, cronId),
      }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Cron audit handoff loaded into task form', true);
  };

	  window.exportCronAuditEntry = function(cronId, index) {
    var payload = cronAuditEntryPayload(cronId, index);
    if (!payload.entry) {
      showToast('Cron audit entry not found', false);
      return;
    }
    downloadTextFile('persona-cron-audit-' + String(cronId || 'cron').replace(/[^a-z0-9._-]+/gi, '-') + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Cron audit entry exported', true);
  };

  window.copyCronEvidenceBundle = function(cronId) {
    copyText(JSON.stringify(cronEvidencePayload(cronId), null, 2));
  };

  window.exportCronEvidenceBundle = function(cronId) {
    downloadTextFile('persona-cron-evidence-' + String(cronId || 'cron').replace(/[^a-z0-9._-]+/gi, '-') + '-' + Date.now() + '.json', JSON.stringify(cronEvidencePayload(cronId), null, 2));
    showToast('Cron evidence exported', true);
  };

  function renderCreateCronForm() {
    return '<form class="wb-form" id="create-cron-form" onsubmit="submitCreateCron(event)">' +
      roleDatalistHtml() +
      renderCronTemplates() +
      '<div class="form-grid">' +
      '<label><span>Name</span><input name="name" required placeholder="daily report"></label>' +
      '<label><span>Schedule</span><input name="schedule" required placeholder="daily 09:00 / every 30m"></label>' +
      '<label><span>Action</span><select name="action_type" onchange="renderCronActionHint(this.value,\'cron-action-hint\',this)">' +
      '<option value="spawn_role">spawn_role</option>' +
      '<option value="director_msg">director_msg</option>' +
      '<option value="shell_action">shell_action</option>' +
      '</select></label>' +
      '<label><span>Role</span><input name="role" list="role-options" value="executor" required></label>' +
      '<label><span>Provider</span><input name="agent" placeholder="default"></label>' +
      '<label><span>Source</span><select name="source_director">' + sourceDirectorOptions('main') + '</select></label>' +
      '<label><span>Timeout Ms</span><input name="timeout_ms" type="number" min="1000" step="1000" placeholder="action default"></label>' +
      '<label><span>Max Retry</span><input name="max_retry" type="number" min="0" max="10" value="3"></label>' +
      '</div>' +
      '<label class="form-wide"><span>Description</span><input name="description" required placeholder="short automation description"></label>' +
      '<label class="form-wide"><span>Prompt</span><textarea name="prompt" required rows="5" placeholder="spawn_role task prompt; for other actions, keep a short audit note"></textarea></label>' +
      '<label class="form-wide"><span>Director Message</span><textarea name="message" rows="3" placeholder="used by director_msg; supports {today} and {yesterday}"></textarea></label>' +
      '<label class="form-wide"><span>Shell Action</span><input name="action_name" placeholder="flush / check_feishu / !cd /path && ./script.sh" oninput="renderShellActionRiskPreview(this.value,\'cron-action-risk\',this.form && this.form.querySelector(\'[name=action_type]\') ? this.form.querySelector(\'[name=action_type]\').value : \'spawn_role\')"></label>' +
      renderSchedulePresets() +
      '<div class="form-note" id="cron-action-hint">spawn_role creates a background task on schedule.</div>' +
      '<div id="cron-action-risk"></div>' +
      '<div class="form-actions"><button class="mini-btn" type="button" onclick="toggleCreateCronForm()">Cancel</button><button class="mini-btn primary" type="submit">Create Cron</button></div>' +
      '</form>';
  }

  function cronTemplateDefinitions() {
    return [
      {
        key: 'daily-report',
        label: '日报',
        detail: '每天 18:00 汇总任务、产物、风险和明日重点',
        values: {
          name: '每日运行日报',
          schedule: 'daily 18:00',
          action_type: 'spawn_role',
          role: 'executor',
          description: '汇总当天 persona-shell 的任务、产物、自动化和待处理风险。',
          prompt: '请生成今天的运行日报：汇总已完成/失败/运行中的任务、重要产物、自动化状态、需要人工处理的风险，以及明天优先关注事项。输出结构化 Markdown，保持简洁可执行。',
          message: '',
          action_name: '',
          timeout_ms: '1800000',
          max_retry: '1',
        },
      },
      {
        key: 'weekly-report',
        label: '周报',
        detail: '每 168 小时生成一份阶段回顾和下周计划',
        values: {
          name: '每周运行周报',
          schedule: 'every 168h',
          action_type: 'spawn_role',
          role: 'executor',
          description: '汇总最近一周的任务进展、关键产物、问题和下一步计划。',
          prompt: '请生成最近一周的运行周报：按项目/主题总结关键进展、已交付产物、失败与阻塞、自动化健康状态、下周计划和需要用户决策的事项。输出 Markdown。',
          message: '',
          action_name: '',
          timeout_ms: '3600000',
          max_retry: '1',
        },
      },
      {
        key: 'health-check',
        label: '定期巡检',
        detail: '每小时检查任务、日志、Cron 和环境风险',
        values: {
          name: '定期运行巡检',
          schedule: 'every 1h',
          action_type: 'spawn_role',
          role: 'executor',
          description: '巡检 persona-shell 的任务队列、自动化、日志错误和环境可用性。',
          prompt: '请做一次 persona-shell 运行巡检：检查最近失败任务、运行中任务、Cron 健康状态、日志错误聚合、环境检查结果，并给出需要立即处理的事项。若没有异常，简短说明当前状态。',
          message: '',
          action_name: '',
          timeout_ms: '1800000',
          max_retry: '0',
        },
      },
      {
        key: 'scheduled-flush',
        label: '定期 Flush',
        detail: '每天 03:00 触发内置 flush shell action',
        values: {
          name: '每日上下文刷新',
          schedule: 'daily 03:00',
          action_type: 'shell_action',
          role: 'executor',
          description: '定时触发 Main 和 Pool Director 的上下文刷新。',
          prompt: '定时 flush 自动化。用于审计记录；实际动作由 shell_action=flush 执行。',
          message: '',
          action_name: 'flush',
          timeout_ms: '1800000',
          max_retry: '0',
        },
      },
      {
        key: 'data-sync',
        label: '数据同步',
        detail: '每小时派发数据同步检查任务',
        values: {
          name: '定期数据同步检查',
          schedule: 'every 1h',
          action_type: 'spawn_role',
          role: 'executor',
          description: '检查并推进本地数据同步任务，发现异常时输出修复建议。',
          prompt: '请执行一次数据同步巡检：确认当前仓库/数据任务是否有需要同步、补跑或校验的内容；如需运行命令，请先说明计划再执行；完成后输出同步状态、异常和后续动作。',
          message: '',
          action_name: '',
          timeout_ms: '3600000',
          max_retry: '1',
        },
      },
    ];
  }

  function renderCronTemplates() {
    var templates = cronTemplateDefinitions();
    var html = '<div class="cron-template-grid">';
    for (var i = 0; i < templates.length; i++) {
      var t = templates[i];
      html += '<button type="button" class="cron-template-card" onclick="applyCronTemplate(\'' + jsq(t.key) + '\')">';
      html += '<strong>' + esc(t.label) + '</strong>';
      html += '<span>' + esc(t.detail) + '</span>';
      html += '</button>';
    }
    html += '</div>';
    return html;
  }

  function renderEditCronForm(c) {
    var action = c.action_type || 'spawn_role';
    return '<form class="wb-form" id="edit-cron-form" onsubmit="submitEditCron(event,\'' + jsq(c.id) + '\')">' +
      roleDatalistHtml() +
      '<div class="form-grid">' +
      '<label><span>Name</span><input name="name" required value="' + esc(c.name) + '"></label>' +
      '<label><span>Schedule</span><input name="schedule" required value="' + esc(c.schedule) + '"></label>' +
      '<label><span>Action</span><select name="action_type" onchange="renderCronActionHint(this.value,\'edit-cron-action-hint\',this)">' +
      '<option value="spawn_role"' + (action === 'spawn_role' ? ' selected' : '') + '>spawn_role</option>' +
      '<option value="director_msg"' + (action === 'director_msg' ? ' selected' : '') + '>director_msg</option>' +
      '<option value="shell_action"' + (action === 'shell_action' ? ' selected' : '') + '>shell_action</option>' +
      '</select></label>' +
      '<label><span>Role</span><input name="role" list="role-options" value="' + esc(c.role || 'executor') + '" required></label>' +
      '<label><span>Provider</span><input name="agent" placeholder="default" value="' + esc(c.agent || '') + '"></label>' +
      '<label><span>Source</span><select name="source_director">' + sourceDirectorOptions(c.source_director || 'main') + '</select></label>' +
      '<label><span>Timeout Ms</span><input name="timeout_ms" type="number" min="1000" step="1000" value="' + esc(String(c.timeout_ms || '')) + '" placeholder="action default"></label>' +
      '<label><span>Max Retry</span><input name="max_retry" type="number" min="0" max="10" value="' + esc(String(c.max_retry == null ? 3 : c.max_retry)) + '"></label>' +
      '<label><span>Enabled</span><select name="enabled"><option value="true"' + (c.enabled ? ' selected' : '') + '>enabled</option><option value="false"' + (!c.enabled ? ' selected' : '') + '>paused</option></select></label>' +
      '</div>' +
      '<label class="form-wide"><span>Description</span><input name="description" required value="' + esc(c.description || '') + '"></label>' +
      '<label class="form-wide"><span>Prompt</span><textarea name="prompt" required rows="5">' + esc(c.prompt || c.description || '') + '</textarea></label>' +
      '<label class="form-wide"><span>Director Message</span><textarea name="message" rows="3">' + esc(c.message || '') + '</textarea></label>' +
      '<label class="form-wide"><span>Shell Action</span><input name="action_name" value="' + esc(c.action_name || '') + '" oninput="renderShellActionRiskPreview(this.value,\'edit-cron-action-risk\',this.form && this.form.querySelector(\'[name=action_type]\') ? this.form.querySelector(\'[name=action_type]\').value : \'spawn_role\')"></label>' +
      renderSchedulePresets() +
      '<div class="form-note" id="edit-cron-action-hint">' + esc(cronActionHintText(action)) + '</div>' +
      '<div id="edit-cron-action-risk">' + (action === 'shell_action' ? renderShellActionRisk(c.action_name || '', false) : '') + '</div>' +
      '<div class="form-actions"><button class="mini-btn" type="button" onclick="toggleEditCron(\'' + jsq(c.id) + '\')">Cancel</button><button class="mini-btn primary" type="submit">Save Changes</button></div>' +
      '</form>';
  }

  function renderSchedulePresets() {
    return '<div class="cron-presets">' +
      '<button type="button" class="mini-btn" onclick="setCronSchedulePreset(this,\'every 30m\')">30m</button>' +
      '<button type="button" class="mini-btn" onclick="setCronSchedulePreset(this,\'every 1h\')">Hourly</button>' +
      '<button type="button" class="mini-btn" onclick="setCronSchedulePreset(this,\'daily 09:00\')">09:00</button>' +
      '<button type="button" class="mini-btn" onclick="setCronSchedulePreset(this,\'daily 18:00\')">18:00</button>' +
      '</div>';
  }

  function cronActionHintText(value) {
    if (value === 'director_msg') return 'director_msg sends the Director Message to the selected source Director.';
    if (value === 'shell_action') return 'shell_action runs a built-in action or a command starting with !.';
    return 'spawn_role creates a background task on schedule.';
  }

  function shellActionRisk(actionName) {
    var action = String(actionName || '').trim();
    if (!action) {
      return {
        level: 'pending',
        label: 'not set',
        title: 'No shell action configured',
        detail: 'shell_action requires an explicit built-in action or a command starting with !.',
        command: '',
      };
    }
    if (action.charAt(0) === '!') {
      var command = action.slice(1).trim();
      return {
        level: 'critical',
        label: 'bash',
        title: 'Local command execution',
        detail: command ? 'This will run through the local shell when the cron fires.' : 'The command is empty after !.',
        command: command,
      };
    }
    var builtins = {
      flush: 'Flushes Main and Pool Director context.',
      check_feishu: 'Acknowledges the reserved Feishu connectivity check action.',
      check_flush: 'Acknowledges the reserved flush health check action.',
    };
    if (Object.prototype.hasOwnProperty.call(builtins, action)) {
      return {
        level: 'medium',
        label: 'built-in',
        title: 'Built-in shell action',
        detail: builtins[action],
        command: '',
      };
    }
    return {
      level: 'high',
      label: 'custom',
      title: 'Unknown shell action',
      detail: 'This name is not in the known built-in list. Verify the backend handler before scheduling it.',
      command: '',
    };
  }

  function shellActionBadgeClass(level) {
    if (level === 'critical' || level === 'high') return 'failed';
    if (level === 'medium') return 'pending';
    return 'cancelled';
  }

  function renderShellActionRisk(actionName, compact) {
    var risk = shellActionRisk(actionName);
    var html = '<div class="shell-action-risk ' + esc(risk.level) + (compact ? ' compact' : '') + '">';
    html += '<span class="badge ' + shellActionBadgeClass(risk.level) + '">' + esc(risk.label) + '</span>';
    html += '<div class="shell-action-risk-body">';
    html += '<div class="shell-action-risk-title">' + esc(risk.title) + '</div>';
    html += '<div class="shell-action-risk-detail">' + esc(risk.detail) + '</div>';
    if (risk.command) html += '<pre class="shell-action-command">' + esc(risk.command) + '</pre>';
    html += '</div></div>';
    return html;
  }

  window.renderShellActionRiskPreview = function(value, id, actionType) {
    var el = $(id || 'cron-action-risk');
    if (!el) return;
    if (actionType && actionType !== 'shell_action') {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = renderShellActionRisk(value, false);
  };

  function updateCronActionRiskFromForm(form, riskId, actionType) {
    if (!form) return;
    var input = form.querySelector('[name="action_name"]');
    renderShellActionRiskPreview(input ? input.value : '', riskId, actionType);
  }

  window.renderCronActionHint = function(value) {
    var id = arguments.length > 1 ? arguments[1] : 'cron-action-hint';
    var control = arguments.length > 2 ? arguments[2] : null;
    var el = $(id);
    if (!el) return;
    el.textContent = cronActionHintText(value);
    var riskId = id === 'edit-cron-action-hint' ? 'edit-cron-action-risk' : 'cron-action-risk';
    updateCronActionRiskFromForm(control && control.closest ? control.closest('form') : el.closest('form'), riskId, value);
  };

  window.setCronSchedulePreset = function(button, schedule) {
    var form = button.closest('form');
    if (!form) return;
    var input = form.querySelector('[name="schedule"]');
    if (input) input.value = schedule;
  };

  window.applyCronTemplate = function(key) {
    var form = $('create-cron-form');
    if (!form) return;
    var template = cronTemplateDefinitions().find(function(item) { return item.key === key; });
    if (!template) return;
    Object.keys(template.values).forEach(function(name) {
      var field = form.querySelector('[name="' + name + '"]');
      if (field) field.value = template.values[name];
    });
    renderCronActionHint(template.values.action_type || 'spawn_role');
    updateCronActionRiskFromForm(form, 'cron-action-risk', template.values.action_type || 'spawn_role');
    showToast('Cron template applied: ' + template.label, true);
  };

  window.toggleCreateCronForm = function() {
    createCronOpen = !createCronOpen;
    if (createCronOpen) editingCronId = null;
    renderAutomationsView();
  };

  window.selectAutomationCron = function(cronId) {
    selectedAutomationCronId = selectedAutomationCronId === cronId ? null : cronId;
    renderAutomationsView();
  };

  window.toggleEditCron = function(cronId) {
    editingCronId = editingCronId === cronId ? null : cronId;
    selectedAutomationCronId = cronId;
    if (editingCronId) createCronOpen = false;
    renderAutomationsView();
  };

  function collectCronPayload(form, requireEnabled) {
    var fd = new FormData(form);
    var actionType = String(fd.get('action_type') || 'spawn_role');
    var description = String(fd.get('description') || '').trim();
    var prompt = String(fd.get('prompt') || '').trim();
    var payload = {
      name: String(fd.get('name') || '').trim(),
      role: String(fd.get('role') || '').trim(),
      agent: String(fd.get('agent') || '').trim() || null,
      description: description,
      prompt: prompt || description,
      schedule: String(fd.get('schedule') || '').trim(),
      action_type: actionType,
      source_director: String(fd.get('source_director') || 'main'),
      message: String(fd.get('message') || '').trim() || null,
      action_name: String(fd.get('action_name') || '').trim() || null,
    };
    if (requireEnabled) payload.enabled = String(fd.get('enabled') || 'true') === 'true';
    var timeout = Number(fd.get('timeout_ms') || 0);
    var retry = Number(fd.get('max_retry') || 0);
    payload.timeout_ms = timeout > 0 ? timeout : null;
    payload.max_retry = Number.isFinite(retry) ? retry : 3;

    if (actionType === 'director_msg' && !payload.message) {
      throw new Error('Director Message is required for director_msg');
    }
    if (actionType === 'shell_action' && !payload.action_name) {
      throw new Error('Shell Action is required for shell_action');
    }
    if (!/^every\s+\d+[mh]$/i.test(payload.schedule) && !/^daily\s+\d{2}:\d{2}$/.test(payload.schedule)) {
      throw new Error('Schedule must be "every Nm", "every Nh", or "daily HH:MM"');
    }
    return payload;
  }

  function cronMutationApprovalSeverity(payload) {
    if (!payload) return 'medium';
    if (payload.action_type === 'shell_action') return 'critical';
    if (payload.action_type === 'director_msg') return 'high';
    return 'medium';
  }

  function cronMutationApprovalDetail(verb, payload, cronId) {
    var parts = [
      verb + ' ' + (payload.action_type || 'spawn_role') + ' automation',
      'schedule ' + (payload.schedule || '--'),
      'source ' + (payload.source_director || 'main'),
      'role ' + (payload.role || '--'),
    ];
    if (cronId) parts.push('job ' + cronId);
    if (payload.enabled != null) parts.push(payload.enabled ? 'enabled' : 'paused');
    if (payload.action_type === 'shell_action') parts.push('shell action ' + (payload.action_name || '--'));
    if (payload.action_type === 'director_msg') parts.push('director message will be sent on schedule');
    return parts.join(' · ');
  }

  window.submitCreateCron = async function(event) {
    event.preventDefault();
    var form = event.target;

    try {
      var payload = collectCronPayload(form, false);
      queueDangerApproval({
        title: 'Create cron job',
        target: payload.name || 'new cron',
        detail: cronMutationApprovalDetail('create', payload),
        severity: cronMutationApprovalSeverity(payload),
        payload: payload,
      }, async function() {
        try {
          var res = await fetch('/api/cron-jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          var body = await readJsonResponse(res);
          createCronOpen = false;
          showToast('Cron created: ' + body.id, true);
          loadCronJobs();
          loadAuditLog();
        } catch (err) {
          showToast('Create cron failed: ' + err.message, false);
          throw err;
        }
      });
    } catch (err) {
      showToast('Create cron failed: ' + err.message, false);
    }
  };

  window.submitEditCron = async function(event, cronId) {
    event.preventDefault();
    var form = event.target;
    try {
      var payload = collectCronPayload(form, true);
      queueDangerApproval({
        title: 'Edit cron job',
        target: payload.name || cronId,
        detail: cronMutationApprovalDetail('edit', payload, cronId),
        severity: cronMutationApprovalSeverity(payload),
        payload: {
          cronId: cronId,
          changes: payload,
        },
      }, async function() {
        try {
          var res = await fetch('/api/cron-jobs/' + encodeURIComponent(cronId), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          var body = await readJsonResponse(res);
          editingCronId = null;
          selectedAutomationCronId = cronId;
          showToast('Cron updated: ' + body.id, true);
          loadCronJobs();
          loadAuditLog();
        } catch (err) {
          showToast('Update cron failed: ' + err.message, false);
          throw err;
        }
      });
    } catch (err) {
      showToast('Update cron failed: ' + err.message, false);
    }
  };

  window.runCronNow = async function(cronId, actionType, name) {
    var action = actionType || 'spawn_role';
    var label = name || cronId;
    var message = action === 'shell_action'
      ? 'Run shell automation "' + label + '" now? This can execute local commands.'
      : 'Run automation "' + label + '" now?';
    queueDangerApproval({
      title: 'Run automation now',
      target: label,
      detail: message,
      severity: action === 'shell_action' ? 'critical' : 'medium',
      payload: { cronId: cronId, actionType: action, name: label },
    }, async function() {
    try {
      var res = await fetch('/api/cron-jobs/' + encodeURIComponent(cronId) + '/run', { method: 'POST' });
      var body = await res.json().catch(function() { return {}; });
      if (!res.ok || body.error || body.ok === false) throw new Error(body.error || 'run cron failed');
      showToast(body.taskId ? 'Cron run created: ' + body.taskId : 'Cron run executed', true);
      loadCronJobs();
      loadCronRuns();
      loadAuditLog();
      if (body.taskId) {
        selectTask(body.taskId);
      } else if (viewMode === 'automations') {
        renderAutomationsView();
      }
    } catch (err) {
      showToast('Run failed: ' + err.message, false);
      throw err;
    }
    });
  };

  function loadCronRuns() {
    cronRunData.loading = true;
    cronRunData.error = null;
    if (viewMode === 'automations') renderAutomationsView();
    fetch('/api/tasks?limit=200')
      .then(function(r) {
        if (!r.ok) return r.text().then(function(text) { throw new Error(text || 'cron runs request failed'); });
        return r.json();
      })
      .then(function(list) {
        cronRunData.tasks = Array.isArray(list) ? list.filter(function(t) { return t.type === 'cron' || (t.extra && t.extra.cronJobId); }) : [];
        cronRunData.loading = false;
        if (viewMode === 'automations') renderAutomationsView();
      })
      .catch(function(err) {
        cronRunData.tasks = [];
        cronRunData.loading = false;
        cronRunData.error = String(err);
        if (viewMode === 'automations') renderAutomationsView();
      });
  }

  window.loadCronRuns = loadCronRuns;

  function loadPersonaWorkbenchData() {
    $('detail-content').innerHTML = '<div class="empty">Loading persona...</div>';
    Promise.all([
      fetch('/api/persona/roles').then(function(r) { return r.json(); }).catch(function() { return { roles: [] }; }),
      fetch('/api/state').then(function(r) { return r.json(); }).catch(function() { return { state: '', todo: '' }; }),
      fetch('/api/persona/session-links')
        .then(function(r) {
          if (!r.ok) throw new Error('GET /api/persona/session-links returned ' + r.status);
          return r.json();
        })
        .catch(function(err) { return { links: {}, error: String(err) }; }),
      fetch('/api/persona/docs')
        .then(function(r) {
          if (!r.ok) throw new Error('GET /api/persona/docs returned ' + r.status);
          return r.json();
        })
        .catch(function(err) { return { docs: [], root: '', error: String(err) }; }),
    ]).then(function(parts) {
      var roles = parts[0].roles || [];
      var selectedRole = personaData.selectedRole || (roles[0] && roles[0].role) || 'director';
      var docs = parts[3].docs || [];
      var selectedDoc = personaData.selectedDoc && docs.some(function(doc) { return doc.path === personaData.selectedDoc; })
        ? personaData.selectedDoc
        : (docs[0] && docs[0].path) || null;
      personaData = {
        roles: roles,
        state: parts[1].state || '',
        todo: parts[1].todo || '',
        selectedRole: selectedRole,
        promptBundle: null,
        promptLoading: false,
        editingDoc: personaData.editingDoc || null,
        sessionLinks: parts[2].links || {},
        sessionLinksError: parts[2].error || null,
        sessionLinkDraft: personaData.sessionLinkDraft || personaSessionLinkDefaults(selectedRole),
        docs: docs,
        docsRoot: parts[3].root || '',
        selectedDoc: selectedDoc,
        assetFilters: personaData.assetFilters || { query: '', category: 'all', freshness: 'all' },
        docPreview: null,
        docEditing: false,
        docError: parts[3].error || null,
      };
      personaLoaded = true;
      renderPersonaView();
      if (personaData.selectedRole) loadPersonaPromptBundle(personaData.selectedRole);
      if (personaData.selectedDoc) loadPersonaAssetDoc(personaData.selectedDoc);
    });
  }

  function loadPersonaPromptBundle(role) {
    personaData.selectedRole = role;
    personaData.promptLoading = true;
    personaData.promptBundle = null;
    renderPersonaView();
    fetch('/api/persona/prompt?role=' + encodeURIComponent(role))
      .then(function(r) {
        if (!r.ok) {
          return r.text().then(function(text) {
            throw new Error('GET /api/persona/prompt returned ' + r.status + ': ' + text);
          });
        }
        return r.json();
      })
      .then(function(bundle) {
        personaData.promptBundle = bundle;
        personaData.promptLoading = false;
        renderPersonaView();
      })
      .catch(function(err) {
        personaData.promptBundle = { error: String(err), role: role, baseInstructions: '', developerInstructions: '', files: { base: [], developer: [] } };
        personaData.promptLoading = false;
        renderPersonaView();
      });
  }

  window.selectPersonaRole = function(role) {
    if (personaData.sessionLinkDraft) personaData.sessionLinkDraft.role = role;
    loadPersonaPromptBundle(role);
  };

  function selectedPersonaRoleRecord() {
    var role = personaData.selectedRole;
    return (personaData.roles || []).find(function(item) { return item.role === role; }) || null;
  }

  function personaRolePreviewPayload() {
    var role = selectedPersonaRoleRecord();
    var bundle = personaData.promptBundle || {};
    var baseFiles = bundle.files && bundle.files.base || [];
    var developerFiles = bundle.files && bundle.files.developer || [];
    return {
      exportedAt: new Date().toISOString(),
      role: personaData.selectedRole || '',
      roleRecord: role,
      targetDirector: activeDirectorLabel(),
      runtimeSessionId: activeRuntimeSessionId(),
      prompt: {
        loading: !!personaData.promptLoading,
        error: bundle.error || null,
        baseFileCount: baseFiles.length,
        developerFileCount: developerFiles.length,
        baseFiles: baseFiles,
        developerFiles: developerFiles,
        baseInstructionChars: String(bundle.baseInstructions || '').length,
        developerInstructionChars: String(bundle.developerInstructions || '').length,
      },
      sessionLinkDraft: personaData.sessionLinkDraft || null,
    };
  }

  function personaPromptBundlePayload() {
    var role = selectedPersonaRoleRecord();
    var bundle = personaData.promptBundle || {};
    var baseInstructions = String(bundle.baseInstructions || '');
    var developerInstructions = String(bundle.developerInstructions || '');
    var baseFiles = bundle.files && bundle.files.base || [];
    var developerFiles = bundle.files && bundle.files.developer || [];
    return {
      exportedAt: new Date().toISOString(),
      role: personaData.selectedRole || '',
      roleRecord: role,
      activeDirector: activeDirectorLabel(),
      runtimeSessionId: activeRuntimeSessionId(),
      loading: !!personaData.promptLoading,
      error: bundle.error || null,
      files: {
        base: baseFiles,
        developer: developerFiles,
        total: baseFiles.length + developerFiles.length,
      },
      stats: {
        baseInstructionChars: baseInstructions.length,
        developerInstructionChars: developerInstructions.length,
        totalInstructionChars: baseInstructions.length + developerInstructions.length,
      },
      baseInstructions: baseInstructions,
      developerInstructions: developerInstructions,
    };
  }

  function personaAssetBundlePayload(path, loadedPreview) {
    var doc = personaDocByPath(path || personaData.selectedDoc);
    var preview = loadedPreview || (personaData.docPreview && doc && personaData.docPreview.path === doc.path ? personaData.docPreview : null);
    return {
      exportedAt: new Date().toISOString(),
      selectedRole: personaData.selectedRole || '',
      activeDirector: activeDirectorLabel(),
      runtimeSessionId: activeRuntimeSessionId(),
      docsRoot: personaData.docsRoot || '',
      doc: doc,
      categoryLabel: doc ? personaDocCategoryLabel(doc.category) : '',
      freshness: doc ? personaDocFreshness(doc) : '',
      preview: preview ? {
        loaded: true,
        path: preview.path || '',
        editable: !!preview.editable,
        category: preview.category || (doc && doc.category) || '',
        contentLength: preview.content ? String(preview.content).length : 0,
        content: preview.content || '',
      } : {
        loaded: false,
        error: personaData.docError || '',
      },
    };
  }

  function personaDocByPath(path) {
    return (personaData.docs || []).find(function(doc) { return doc.path === path; }) || null;
  }

  function personaMemoryDoc() {
    var docs = personaData.docs || [];
    var memoryDocs = docs.filter(function(doc) { return doc.category === 'memory'; });
    return memoryDocs.find(function(doc) { return /(^|\/)MEMORY\.md$/i.test(doc.path || ''); })
      || memoryDocs.find(function(doc) { return /\.md$/i.test(doc.path || ''); })
      || memoryDocs[0]
      || null;
  }

  function personaMemoryBundlePayload(loadedPreview) {
    var doc = personaMemoryDoc();
    if (!doc) {
      return {
        exportedAt: new Date().toISOString(),
        selectedRole: personaData.selectedRole || '',
        activeDirector: activeDirectorLabel(),
        runtimeSessionId: activeRuntimeSessionId(),
        docsRoot: personaData.docsRoot || '',
        doc: null,
        state: { markdownLength: String(personaData.state || '').length, hasContent: !!personaData.state },
        todo: { markdownLength: String(personaData.todo || '').length, hasContent: !!personaData.todo },
      };
    }
    var payload = personaAssetBundlePayload(doc.path, loadedPreview);
    payload.companions = {
      state: { path: 'daily/state.md', markdownLength: String(personaData.state || '').length, hasContent: !!personaData.state },
      todo: { path: 'TODO.md', markdownLength: String(personaData.todo || '').length, hasContent: !!personaData.todo },
    };
    return payload;
  }

  function personaDocCategoryLabel(category) {
    var labels = {
      core: 'Core',
      roles: 'Roles',
      prompts: 'Prompts',
      memory: 'Memory',
      daily: 'Daily',
      workspace: 'Workspace',
      session: 'Sessions',
      skills: 'Skills',
      config: 'Config',
    };
    return labels[category] || category || 'Other';
  }

  function personaDocAgeMs(doc) {
    var ts = Number(doc && doc.mtimeMs);
    if (!isFinite(ts) || ts <= 0) return Infinity;
    return Math.max(0, Date.now() - ts);
  }

  function personaDocFreshness(doc) {
    var age = personaDocAgeMs(doc);
    if (age <= 86400000) return 'hot';
    if (age <= 604800000) return 'recent';
    return 'quiet';
  }

  function recentPersonaDocs(docs) {
    return (docs || [])
      .filter(function(doc) { return isFinite(Number(doc && doc.mtimeMs)); })
      .slice()
      .sort(function(a, b) { return Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0); })
      .slice(0, 5);
  }

  function renderPersonaRecentChanges(docs) {
    if (!docs || docs.length === 0) return '';
    var recent = recentPersonaDocs(docs);
    var workspaceCount = docs.filter(function(doc) { return doc.category === 'workspace'; }).length;
    var sessionCount = docs.filter(function(doc) { return doc.category === 'session'; }).length;
    var html = '<div class="persona-change-strip">';
    html += '<button class="persona-change-card summary" onclick="loadPersonaWorkbenchData()"><span class="persona-change-label">Context Index</span><strong>' + workspaceCount + ' workspace · ' + sessionCount + ' session</strong><span>Refresh persona assets and memory surfaces</span></button>';
    if (recent.length === 0) {
      html += '<div class="persona-change-card muted"><span class="persona-change-label">Recent Changes</span><strong>No timestamps</strong><span>Persona docs did not report modified times.</span></div>';
    } else {
      for (var i = 0; i < recent.length; i++) {
        var doc = recent[i];
        var freshness = personaDocFreshness(doc);
        html += '<button class="persona-change-card ' + freshness + '" onclick="selectPersonaAssetDoc(\'' + jsq(doc.path) + '\')">';
        html += '<span class="persona-change-label">' + esc(personaDocCategoryLabel(doc.category)) + '</span>';
        html += '<strong>' + esc(doc.name || doc.path) + '</strong>';
        html += '<span>' + esc(fmtAgo(doc.mtimeMs)) + ' · ' + esc(shortText(doc.path || '', 54)) + '</span>';
        html += '</button>';
      }
    }
    html += '</div>';
    return html;
  }

  function personaAssetFilters() {
    if (!personaData.assetFilters) personaData.assetFilters = { query: '', category: 'all', freshness: 'all' };
    return personaData.assetFilters;
  }

  function filteredPersonaAssetDocs() {
    var filters = personaAssetFilters();
    var query = String(filters.query || '').trim().toLowerCase();
    var category = filters.category || 'all';
    var freshness = filters.freshness || 'all';
    return (personaData.docs || []).filter(function(doc) {
      if (category !== 'all' && doc.category !== category) return false;
      if (freshness !== 'all' && personaDocFreshness(doc) !== freshness) return false;
      if (!query) return true;
      var haystack = [
        doc.name,
        doc.path,
        doc.category,
        personaDocCategoryLabel(doc.category),
        doc.editable ? 'editable' : 'readonly',
      ].filter(Boolean).join('\n').toLowerCase();
      return haystack.indexOf(query) >= 0;
    });
  }

  function personaAssetCategoryOptions(docs) {
    var seen = {};
    var options = [];
    for (var i = 0; i < (docs || []).length; i++) {
      var category = docs[i].category || 'other';
      if (!seen[category]) {
        seen[category] = true;
        options.push([category, personaDocCategoryLabel(category)]);
      }
    }
    return options.sort(function(a, b) { return a[1].localeCompare(b[1]); });
  }

  function renderPersonaAssetFilters(allDocs, visibleDocs) {
    var filters = personaAssetFilters();
    var categories = personaAssetCategoryOptions(allDocs);
    var html = '<div class="file-filters persona-asset-filters">';
    html += '<label class="file-filter-search"><span>Search</span><input value="' + esc(filters.query || '') + '" placeholder="name, path, category..." oninput="setPersonaAssetFilter(\'query\', this.value)"></label>';
    html += '<label><span>Category</span><select onchange="setPersonaAssetFilter(\'category\', this.value)">';
    html += '<option value="all"' + ((filters.category || 'all') === 'all' ? ' selected' : '') + '>All categories</option>';
    for (var i = 0; i < categories.length; i++) {
      html += '<option value="' + esc(categories[i][0]) + '"' + (filters.category === categories[i][0] ? ' selected' : '') + '>' + esc(categories[i][1]) + '</option>';
    }
    html += '</select></label>';
    html += '<label><span>Freshness</span><select onchange="setPersonaAssetFilter(\'freshness\', this.value)">';
    var freshnessOptions = [['all', 'All freshness'], ['hot', 'Hot'], ['recent', 'Recent'], ['quiet', 'Quiet']];
    for (var j = 0; j < freshnessOptions.length; j++) {
      html += '<option value="' + freshnessOptions[j][0] + '"' + ((filters.freshness || 'all') === freshnessOptions[j][0] ? ' selected' : '') + '>' + freshnessOptions[j][1] + '</option>';
    }
    html += '</select></label>';
    html += '<button class="mini-btn" onclick="clearPersonaAssetFilters()">Clear</button>';
    html += '<div class="filter-count">' + visibleDocs.length + '/' + (allDocs || []).length + ' visible</div>';
    html += '</div>';
    return html;
  }

  function personaAssetManifestPayload() {
    return {
      exportedAt: new Date().toISOString(),
      selectedRole: personaData.selectedRole || '',
      activeDirector: activeDirectorLabel(),
      runtimeSessionId: activeRuntimeSessionId(),
      docsRoot: personaData.docsRoot || '',
      filters: personaAssetFilters(),
      totalDocs: (personaData.docs || []).length,
      visibleDocs: filteredPersonaAssetDocs().map(function(doc) {
        return {
          name: doc.name || '',
          path: doc.path || '',
          category: doc.category || '',
          categoryLabel: personaDocCategoryLabel(doc.category),
          editable: !!doc.editable,
          size: doc.size || 0,
          mtimeMs: doc.mtimeMs || null,
          freshness: personaDocFreshness(doc),
        };
      }),
    };
  }

  function loadPersonaAssetDoc(path) {
    if (!path) return;
    personaData.selectedDoc = path;
    personaData.docEditing = false;
    personaData.docPreview = null;
    personaData.docError = null;
    if (viewMode === 'persona') renderPersonaView();
    fetch('/api/persona/docs/content?path=' + encodeURIComponent(path))
      .then(function(r) {
        if (!r.ok) return r.text().then(function(text) { throw new Error(text || 'persona doc request failed'); });
        return r.json();
      })
      .then(function(doc) {
        personaData.docPreview = doc;
        personaData.docError = null;
        if (viewMode === 'persona') renderPersonaView();
      })
      .catch(function(err) {
        personaData.docPreview = null;
        personaData.docError = String(err);
        if (viewMode === 'persona') renderPersonaView();
      });
  }

  window.selectPersonaAssetDoc = function(path) {
    loadPersonaAssetDoc(path);
  };

  function fetchPersonaAssetContent(path) {
    return fetch('/api/persona/docs/content?path=' + encodeURIComponent(path))
      .then(function(r) {
        if (!r.ok) return r.text().then(function(text) { throw new Error(text || 'persona doc request failed'); });
        return r.json();
      });
  }

  window.openPersonaMemoryDoc = function() {
    var doc = personaMemoryDoc();
    if (!doc) {
      showToast('No memory document found', false);
      return;
    }
    personaData.assetFilters = { query: '', category: 'all', freshness: 'all' };
    loadPersonaAssetDoc(doc.path);
  };

  window.copyPersonaMemoryMarkdown = async function() {
    var doc = personaMemoryDoc();
    if (!doc) {
      showToast('No memory document found', false);
      return;
    }
    var preview = personaData.docPreview && personaData.docPreview.path === doc.path ? personaData.docPreview : null;
    try {
      if (!preview) preview = await fetchPersonaAssetContent(doc.path);
      copyText(preview.content || '');
    } catch (err) {
      showToast('Copy memory failed: ' + err.message, false);
    }
  };

  window.copyPersonaMemoryBundle = async function() {
    var doc = personaMemoryDoc();
    if (!doc) {
      copyText(JSON.stringify(personaMemoryBundlePayload(null), null, 2));
      return;
    }
    var preview = personaData.docPreview && personaData.docPreview.path === doc.path ? personaData.docPreview : null;
    try {
      if (!preview) preview = await fetchPersonaAssetContent(doc.path);
      copyText(JSON.stringify(personaMemoryBundlePayload(preview), null, 2));
    } catch (err) {
      copyText(JSON.stringify(personaMemoryBundlePayload(null), null, 2));
      showToast('Memory bundle copied without content: ' + err.message, false);
    }
  };

  window.exportPersonaMemoryBundle = async function() {
    var doc = personaMemoryDoc();
    var preview = null;
    if (doc) {
      preview = personaData.docPreview && personaData.docPreview.path === doc.path ? personaData.docPreview : null;
      try {
        if (!preview) preview = await fetchPersonaAssetContent(doc.path);
      } catch (err) {
        showToast('Memory bundle exported without content: ' + err.message, false);
      }
    }
    downloadTextFile('persona-memory-bundle-' + Date.now() + '.json', JSON.stringify(personaMemoryBundlePayload(preview), null, 2));
    showToast('Memory bundle exported', true);
  };

  function personaMemoryTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench memory snapshot handoff as task context.',
      '',
      'Operator intent:',
      '- Review current persona memory, state, TODO, workspace docs, and session docs before changing persistent context.',
      '- Use the memory bundle, asset manifest, role preview, prompt bundle, context graph, runtime snapshot, and approval context before acting.',
      '- If memory is stale, missing, inconsistent, or overloaded, propose or implement a scoped memory/state/TODO cleanup.',
      '- Do not edit persona documents, state, TODO, or session links unless the task prompt is explicitly edited.',
      '',
      'Persona memory snapshot handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromPersonaMemoryBundle = async function() {
    var doc = personaMemoryDoc();
    var preview = null;
    if (doc) {
      preview = personaData.docPreview && personaData.docPreview.path === doc.path ? personaData.docPreview : null;
      try {
        if (!preview) preview = await fetchPersonaAssetContent(doc.path);
      } catch (err) {
        showToast('Creating memory task without memory content: ' + err.message, false);
      }
    }
    var bundle = personaMemoryBundlePayload(preview);
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'personaMemorySnapshot',
      memory: bundle,
      assetManifest: personaAssetManifestPayload(),
      rolePreview: personaRolePreviewPayload(),
      promptBundle: personaData.promptBundle && !personaData.promptLoading ? personaPromptBundlePayload() : null,
      contextGraph: personaContextGraphPayload(),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: bundle.activeDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review persona memory snapshot: ' + (bundle.doc && bundle.doc.path || 'state/TODO'),
      prompt: personaMemoryTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Persona memory snapshot loaded into task form', true);
  };

  window.setPersonaAssetFilter = function(key, value) {
    var filters = personaAssetFilters();
    if (key === 'query') filters.query = String(value || '');
    if (key === 'category') filters.category = value || 'all';
    if (key === 'freshness') filters.freshness = value || 'all';
    var visible = filteredPersonaAssetDocs();
    if (!visible.some(function(doc) { return doc.path === personaData.selectedDoc; })) {
      personaData.selectedDoc = visible[0] && visible[0].path || null;
      personaData.docPreview = null;
      if (personaData.selectedDoc) loadPersonaAssetDoc(personaData.selectedDoc);
    }
    renderPersonaView();
  };

  window.clearPersonaAssetFilters = function() {
    personaData.assetFilters = { query: '', category: 'all', freshness: 'all' };
    var visible = filteredPersonaAssetDocs();
    if (!visible.some(function(doc) { return doc.path === personaData.selectedDoc; })) {
      personaData.selectedDoc = visible[0] && visible[0].path || null;
      personaData.docPreview = null;
      if (personaData.selectedDoc) loadPersonaAssetDoc(personaData.selectedDoc);
    }
    renderPersonaView();
  };

  window.copyPersonaAssetManifest = function() {
    if (!filteredPersonaAssetDocs().length) {
      showToast('No visible persona assets to copy', false);
      return;
    }
    copyText(JSON.stringify(personaAssetManifestPayload(), null, 2));
  };

  window.exportPersonaAssetManifest = function() {
    if (!filteredPersonaAssetDocs().length) {
      showToast('No visible persona assets to export', false);
      return;
    }
    downloadTextFile('persona-asset-manifest-' + Date.now() + '.json', JSON.stringify(personaAssetManifestPayload(), null, 2));
    showToast('Persona asset manifest exported', true);
  };

  function personaAssetManifestTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench asset manifest handoff as task context.',
      '',
      'Operator intent:',
      '- Review the visible persona asset manifest and decide whether context, memory, workspace, or session documents need attention.',
      '- Use the active filters, selected document bundle, memory bundle, role preview, context graph, runtime snapshot, and approval context before acting.',
      '- If documents are stale, missing, too broad, or inconsistent with the active role/session, propose or implement a scoped documentation or context fix.',
      '- Do not edit persona documents, switch persona roles, or delete session links unless the task prompt is explicitly edited.',
      '',
      'Persona asset manifest handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromPersonaAssetManifest = async function() {
    if (!filteredPersonaAssetDocs().length) {
      showToast('No visible persona assets to use', false);
      return;
    }
    var selectedPath = personaData.selectedDoc || (filteredPersonaAssetDocs()[0] && filteredPersonaAssetDocs()[0].path) || '';
    var selectedPreview = selectedPath && personaData.docPreview && personaData.docPreview.path === selectedPath ? personaData.docPreview : null;
    var memoryDoc = personaMemoryDoc();
    var memoryPreview = memoryDoc && personaData.docPreview && personaData.docPreview.path === memoryDoc.path ? personaData.docPreview : null;
    try {
      if (selectedPath && !selectedPreview) selectedPreview = await fetchPersonaAssetContent(selectedPath);
    } catch (err) {
      showToast('Creating manifest task without selected asset content: ' + err.message, false);
    }
    try {
      if (memoryDoc && !memoryPreview) memoryPreview = await fetchPersonaAssetContent(memoryDoc.path);
    } catch (err) {
      showToast('Creating manifest task without memory content: ' + err.message, false);
    }
    var manifest = personaAssetManifestPayload();
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'personaAssetManifest',
      manifest: manifest,
      selectedAsset: selectedPath ? personaAssetBundlePayload(selectedPath, selectedPreview) : null,
      memory: personaMemoryBundlePayload(memoryPreview),
      rolePreview: personaRolePreviewPayload(),
      promptBundle: personaData.promptBundle && !personaData.promptLoading ? personaPromptBundlePayload() : null,
      contextGraph: personaContextGraphPayload(),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: manifest.activeDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review persona assets: ' + String((manifest.visibleDocs || []).length) + '/' + String(manifest.totalDocs || 0) + ' visible',
      prompt: personaAssetManifestTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Persona asset manifest loaded into task form', true);
  };

  function personaAssetTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench document handoff as task context.',
      '',
      'Operator intent:',
      '- Review the selected persona document and decide whether it needs cleanup, refresh, consolidation, or a scoped correction.',
      '- Compare the selected document bundle with the asset manifest, memory bundle, role preview, prompt bundle, context graph, runtime snapshot, and approval context before acting.',
      '- If the document is stale, overloaded, contradictory, missing session/workspace context, or misaligned with the active role, propose or implement a scoped document/context fix.',
      '- Do not edit persona documents, switch roles, delete session links, or change MCP/provider routing unless the task prompt is explicitly edited.',
      '',
      'Persona document handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromPersonaAssetBundle = async function(path) {
    var doc = personaDocByPath(path || personaData.selectedDoc);
    if (!doc) {
      showToast('Persona asset is not selected', false);
      return;
    }
    var selectedPreview = personaData.docPreview && personaData.docPreview.path === doc.path ? personaData.docPreview : null;
    var memoryDoc = personaMemoryDoc();
    var memoryPreview = memoryDoc && personaData.docPreview && personaData.docPreview.path === memoryDoc.path ? personaData.docPreview : null;
    try {
      if (!selectedPreview) selectedPreview = await fetchPersonaAssetContent(doc.path);
    } catch (err) {
      showToast('Creating document task without selected content: ' + err.message, false);
    }
    try {
      if (memoryDoc && !memoryPreview) memoryPreview = memoryDoc.path === doc.path ? selectedPreview : await fetchPersonaAssetContent(memoryDoc.path);
    } catch (err) {
      showToast('Creating document task without memory content: ' + err.message, false);
    }
    var bundle = personaAssetBundlePayload(doc.path, selectedPreview);
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'personaAssetDocument',
      selectedAsset: bundle,
      manifest: personaAssetManifestPayload(),
      memory: personaMemoryBundlePayload(memoryPreview),
      rolePreview: personaRolePreviewPayload(),
      promptBundle: personaData.promptBundle && !personaData.promptLoading ? personaPromptBundlePayload() : null,
      contextGraph: personaContextGraphPayload(),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: bundle.activeDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review persona document: ' + (doc.path || doc.name || 'asset'),
      prompt: personaAssetTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Persona document loaded into task form', true);
  };

  window.editPersonaAssetDoc = function(editing) {
    personaData.docEditing = !!editing;
    renderPersonaView();
  };

  window.savePersonaAssetDoc = async function() {
    var preview = personaData.docPreview;
    if (!preview || !preview.editable) {
      showToast('Selected persona doc is not editable', false);
      return;
    }
    var editor = $('persona-asset-editor');
    if (!editor) return;
    var content = editor.value;
    queueDangerApproval({
      title: 'Save persona asset',
      target: preview.path || 'persona doc',
      detail: 'Update editable persona markdown asset with ' + String(content || '').length + ' character(s).',
      severity: 'medium',
      payload: {
        path: preview.path || '',
        category: preview.category || null,
        contentLength: String(content || '').length,
        preview: shortText(content || '', 240),
      },
    }, async function() {
      try {
        var res = await fetch('/api/persona/docs/content', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: preview.path, content: content }),
        });
        var body = await readJsonResponse(res);
        personaData.docPreview = Object.assign({}, preview, { content: body.content });
        personaData.docEditing = false;
        showToast('Persona doc saved', true);
        if (viewMode === 'persona') renderPersonaView();
      } catch (err) {
        showToast('Save failed: ' + err.message, false);
        throw err;
      }
    });
  };

  window.copyPersonaAssetBundle = function(path) {
    var doc = personaDocByPath(path || personaData.selectedDoc);
    if (!doc) {
      showToast('Persona asset is not selected', false);
      return;
    }
    copyText(JSON.stringify(personaAssetBundlePayload(doc.path), null, 2));
  };

  window.exportPersonaAssetBundle = function(path) {
    var doc = personaDocByPath(path || personaData.selectedDoc);
    if (!doc) {
      showToast('Persona asset is not selected', false);
      return;
    }
    var safe = String(doc.path || doc.name || 'persona-asset').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-asset-' + safe + '-' + Date.now() + '.json', JSON.stringify(personaAssetBundlePayload(doc.path), null, 2));
    showToast('Persona asset bundle exported', true);
  };

  function personaSessionLinkDefaults(role) {
    var runtimeSessionId = activeRuntimeSessionId();
    return {
      channel: 'web',
      external_id: runtimeSessionId || 'web-console',
      persona_session_id: runtimeSessionId || '',
      codex_thread_id: '',
      director_label: activeDirectorLabel(),
      role: role || personaData.selectedRole || 'director',
    };
  }

  function personaSessionLinksArray() {
    var links = personaData.sessionLinks || {};
    return Object.keys(links).map(function(key) {
      return links[key];
    }).sort(function(a, b) {
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
  }

  function personaSessionLinkByKey(key) {
    return (personaData.sessionLinks || {})[key] || null;
  }

  function personaSessionLinkKeyFromParts(channel, externalId) {
    return String(channel || '') + ':' + String(externalId || '');
  }

  function personaSessionLinkKeyFromAudit(entry) {
    var detail = entry && entry.detail || {};
    var target = String(entry && entry.target || '');
    if (detail.channel || detail.externalId) {
      return personaSessionLinkKeyFromParts(detail.channel || '', detail.externalId || '');
    }
    return target;
  }

  function scrollPersonaSessionLinkIntoView(key) {
    if (!key) return;
    setTimeout(function() {
      var row = document.getElementById('persona-session-link-' + safeAssetName(key, 'link'));
      if (row && row.scrollIntoView) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        showToast('Opened session link', true);
      } else {
        showToast('Opened Persona; session link is not currently visible', false);
      }
    }, 180);
  }

  function personaSessionLinksPayload() {
    var links = personaSessionLinksArray();
    return {
      exportedAt: new Date().toISOString(),
      count: links.length,
      activeDirector: activeDirectorLabel(),
      runtimeSessionId: activeRuntimeSessionId(),
      selectedRole: personaData.selectedRole || '',
      links: links.map(function(link) {
        return Object.assign({}, link, { openTarget: personaSessionLinkOpenTarget(link) });
      }),
      draft: personaData.sessionLinkDraft || null,
      error: personaData.sessionLinksError || null,
    };
  }

  function personaSessionLinkOpenTarget(link) {
    if (!link) return null;
    var director = link.directorLabel || 'main';
    var sessionId = link.personaSessionId || '';
    return {
      kind: sessionId ? 'session' : 'director',
      director: director,
      sessionId: sessionId,
      label: sessionId ? (director + ' / ' + sessionId) : director,
    };
  }

  function personaContextGraphPayload() {
    var links = personaSessionLinksArray();
    var runtimeSessionId = activeRuntimeSessionId();
    var directorLabel = activeDirectorLabel();
    var role = personaData.selectedRole || 'director';
    var currentLink = links.find(function(link) {
      return (link.directorLabel || 'main') === directorLabel && link.personaSessionId === runtimeSessionId;
    }) || links.find(function(link) {
      return (link.directorLabel || 'main') === directorLabel && link.role === role;
    }) || null;
    var promptFiles = personaPromptFileList();
    var docs = personaData.docs || [];
    return {
      exportedAt: new Date().toISOString(),
      activeDirector: directorLabel,
      runtimeSessionId: runtimeSessionId,
      selectedRole: role,
      currentLink: currentLink,
      promptFiles: promptFiles,
      docs: {
        total: docs.length,
        workspace: docs.filter(function(doc) { return doc.category === 'workspace'; }).length,
        session: docs.filter(function(doc) { return doc.category === 'session'; }).length,
        memory: docs.filter(function(doc) { return doc.category === 'memory'; }).length,
      },
      sessionLinks: links,
    };
  }

  function personaHandoffPromptPayload() {
    if (!personaData.promptBundle || personaData.promptLoading) {
      return {
        loading: !!personaData.promptLoading,
        selectedRole: personaData.selectedRole || '',
        loaded: false,
        error: personaData.promptBundle && personaData.promptBundle.error || null,
      };
    }
    return Object.assign({ loaded: true }, personaPromptBundlePayload());
  }

  function personaRuntimeHandoffPayload(loadedMemoryPreview) {
    var docs = personaData.docs || [];
    var memoryDoc = personaMemoryDoc();
    var graph = personaContextGraphPayload();
    var selectedSkill = personaSkillByPath(configAssetsData.selectedSkillPath) || (configAssetsData.skills || [])[0] || null;
    return {
      exportedAt: new Date().toISOString(),
      activeDirector: activeDirectorLabel(),
      runtimeSessionId: activeRuntimeSessionId(),
      selectedRole: personaData.selectedRole || '',
      rolePreview: personaRolePreviewPayload(),
      prompt: personaHandoffPromptPayload(),
      memory: personaMemoryBundlePayload(loadedMemoryPreview),
      state: personaDocPanelBundlePayload('state'),
      todo: personaDocPanelBundlePayload('todo'),
      contextGraph: graph,
      sessionLinks: personaSessionLinksPayload(),
      assets: {
        docsRoot: personaData.docsRoot || '',
        selectedDoc: personaData.selectedDoc || '',
        filters: personaAssetFilters(),
        totalDocs: docs.length,
        visibleDocs: filteredPersonaAssetDocs().length,
        recentDocs: recentPersonaDocs(docs).map(function(doc) {
          return {
            name: doc.name || '',
            path: doc.path || '',
            category: doc.category || '',
            categoryLabel: personaDocCategoryLabel(doc.category),
            freshness: personaDocFreshness(doc),
            editable: !!doc.editable,
            size: doc.size || 0,
            mtimeMs: doc.mtimeMs || null,
          };
        }),
      },
      skillsMcp: {
        inventory: personaMcpInventory(),
        selectedSkill: selectedSkill ? {
          name: selectedSkill.name || '',
          path: selectedSkill.path || '',
          source: selectedSkill.source || '',
          description: selectedSkill.description || '',
        } : null,
      },
      readiness: [
        { key: 'role', ok: !!personaData.selectedRole, detail: personaData.selectedRole || 'missing' },
        { key: 'prompt', ok: !!(personaData.promptBundle && !personaData.promptLoading && !personaData.promptBundle.error), detail: personaData.promptLoading ? 'loading' : (personaData.promptBundle && personaData.promptBundle.error || 'loaded') },
        { key: 'memory', ok: !!memoryDoc, detail: memoryDoc ? memoryDoc.path : 'missing' },
        { key: 'state', ok: !!personaData.state, detail: String(personaData.state || '').length + ' chars' },
        { key: 'todo', ok: !!personaData.todo, detail: String(personaData.todo || '').length + ' chars' },
        { key: 'sessionLink', ok: !!graph.currentLink, detail: graph.currentLink ? ((graph.currentLink.channel || '--') + ':' + (graph.currentLink.externalId || '--')) : 'no exact link' },
      ],
    };
  }

  function personaRuntimeHandoffTaskPrompt(payload) {
    return [
      'Use the following Persona runtime handoff as the working context for this task.',
      '',
      'Operator intent:',
      '- Continue from the current Persona Workbench runtime context.',
      '- Check the readiness entries before acting.',
      '- Preserve the active Director, role, memory, state, TODO, and session-link context unless the task prompt says otherwise.',
      '',
      'Runtime handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function personaContextGraphTaskPrompt(payload) {
    return [
      'Use the following Persona Workbench context graph as task context.',
      '',
      'Operator intent:',
      '- Review the active Director, runtime session, selected role, prompt files, memory docs, and session-link mapping as a graph.',
      '- Identify missing, stale, duplicated, or misaligned context edges before changing persona/runtime state.',
      '- Use the readiness checks, session links, role preview, prompt bundle, asset manifest, runtime snapshot, and approval context before acting.',
      '- Do not retarget sessions, edit memory, or switch roles unless the task prompt is explicitly edited.',
      '',
      'Persona context graph handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.resetPersonaSessionLinkDraft = function() {
    personaData.sessionLinkDraft = personaSessionLinkDefaults(personaData.selectedRole);
    renderPersonaView();
  };

  window.updatePersonaSessionLinkDraft = function(field, value) {
    if (!personaData.sessionLinkDraft) {
      personaData.sessionLinkDraft = personaSessionLinkDefaults(personaData.selectedRole);
    }
    personaData.sessionLinkDraft[field] = value;
  };

  window.savePersonaSessionLink = async function() {
    var draft = personaData.sessionLinkDraft || personaSessionLinkDefaults(personaData.selectedRole);
    var channel = String(draft.channel || '').trim();
    var externalId = String(draft.external_id || '').trim();
    if (!channel || !externalId) {
      showToast('Channel and external id are required', false);
      return;
    }
    try {
      var res = await fetch('/api/persona/session-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: channel,
          external_id: externalId,
          persona_session_id: String(draft.persona_session_id || '').trim() || null,
          codex_thread_id: String(draft.codex_thread_id || '').trim() || null,
          director_label: String(draft.director_label || '').trim() || null,
          role: String(draft.role || '').trim() || null,
        }),
      });
      var body = await res.json().catch(function() { return {}; });
      if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
      var key = body.channel + ':' + body.externalId;
      personaData.sessionLinks = Object.assign({}, personaData.sessionLinks || {});
      personaData.sessionLinks[key] = body;
      personaData.sessionLinksError = null;
      personaData.sessionLinkDraft = {
        channel: body.channel || channel,
        external_id: body.externalId || externalId,
        persona_session_id: body.personaSessionId || '',
        codex_thread_id: body.codexThreadId || '',
        director_label: body.directorLabel || '',
        role: body.role || personaData.selectedRole || '',
      };
      showToast('Session link saved', true);
      renderPersonaView();
    } catch (err) {
      showToast('Save failed: ' + err.message, false);
    }
  };

  window.usePersonaSessionLink = function(key) {
    var link = personaSessionLinkByKey(key);
    if (!link) return;
    personaData.sessionLinkDraft = {
      channel: link.channel || '',
      external_id: link.externalId || '',
      persona_session_id: link.personaSessionId || '',
      codex_thread_id: link.codexThreadId || '',
      director_label: link.directorLabel || 'main',
      role: link.role || personaData.selectedRole || '',
    };
    renderPersonaView();
  };

  window.openPersonaSessionLinkContext = function(key) {
    var link = personaSessionLinkByKey(key);
    if (!link) {
      showToast('Session link not found', false);
      return;
    }
    var target = personaSessionLinkOpenTarget(link);
    if (!target) {
      showToast('Session link target is empty', false);
      return;
    }
    if (target.sessionId) {
      if (target.director && target.director !== 'main') {
        selectSubSession(target.director, target.sessionId, target.sessionId.slice(0, 16));
      } else {
        selectSession(target.sessionId);
      }
      return;
    }
    if (target.director && target.director !== 'main') {
      selectPoolDirector(target.director, target.director);
    } else {
      selectSession(null);
    }
  };

  window.focusPersonaSessionLink = function(key) {
    personaSessionLinkFocusKey = key || '';
    if (viewMode !== 'persona') selectNav('persona');
    else renderPersonaView();
    scrollPersonaSessionLinkIntoView(personaSessionLinkFocusKey);
  };

  window.copyPersonaSessionLinks = function() {
    copyText(JSON.stringify(personaSessionLinksPayload(), null, 2));
  };

  window.exportPersonaSessionLinks = function() {
    downloadTextFile('persona-session-links-' + Date.now() + '.json', JSON.stringify(personaSessionLinksPayload(), null, 2));
    showToast('Session links exported', true);
  };

  function personaSessionLinkBundlePayload(link) {
    if (!link) return null;
    return Object.assign({}, link, { openTarget: personaSessionLinkOpenTarget(link) });
  }

  window.copyPersonaSessionLink = function(key) {
    var link = personaSessionLinkByKey(key);
    if (!link) {
      showToast('Session link not found', false);
      return;
    }
    copyText(JSON.stringify(personaSessionLinkBundlePayload(link), null, 2));
  };

  window.exportPersonaSessionLink = function(key) {
    var link = personaSessionLinkByKey(key);
    if (!link) {
      showToast('Session link not found', false);
      return;
    }
    var name = String((link.channel || 'link') + '-' + (link.externalId || 'session')).replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-session-link-' + name + '-' + Date.now() + '.json', JSON.stringify(personaSessionLinkBundlePayload(link), null, 2));
    showToast('Session link exported', true);
  };

  function personaSessionLinksTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench session-link handoff as task context.',
      '',
      'Operator intent:',
      '- Review external session mappings, active runtime session, selected persona role, and open targets before changing any session-link state.',
      '- Use the selected link or whole link report with the context graph, runtime snapshot, role preview, prompt bundle, asset manifest, and approval context before acting.',
      '- If links are stale, duplicated, missing, pointed at the wrong Director/session, or misaligned with the active role, propose or implement a scoped link/context fix.',
      '- Do not create, edit, delete, or retarget session links unless the task prompt is explicitly edited.',
      '',
      'Persona session-link handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function personaSessionLinksTaskContext(selectedLink) {
    return {
      exportedAt: new Date().toISOString(),
      type: selectedLink ? 'personaSessionLink' : 'personaSessionLinksReport',
      sessionLinks: personaSessionLinksPayload(),
      selectedLink: selectedLink ? personaSessionLinkBundlePayload(selectedLink) : null,
      rolePreview: personaRolePreviewPayload(),
      promptBundle: personaData.promptBundle && !personaData.promptLoading ? personaPromptBundlePayload() : null,
      assetManifest: personaAssetManifestPayload(),
      contextGraph: personaContextGraphPayload(),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
  }

  window.createTaskFromPersonaSessionLinks = function() {
    var report = personaSessionLinksPayload();
    var payload = personaSessionLinksTaskContext(null);
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: report.activeDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review persona session links: ' + String(report.count || 0) + ' link(s)',
      prompt: personaSessionLinksTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Persona session links loaded into task form', true);
  };

  window.createTaskFromPersonaSessionLink = function(key) {
    var link = personaSessionLinkByKey(key);
    if (!link) {
      showToast('Session link not found', false);
      return;
    }
    var payload = personaSessionLinksTaskContext(link);
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: link.directorLabel || payload.sessionLinks.activeDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review persona session link: ' + (link.channel || 'link') + ' / ' + (link.externalId || 'session'),
      prompt: personaSessionLinksTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Persona session link loaded into task form', true);
  };

  window.copyPersonaContextGraph = function() {
    copyText(JSON.stringify(personaContextGraphPayload(), null, 2));
  };

  window.exportPersonaContextGraph = function() {
    downloadTextFile('persona-context-graph-' + Date.now() + '.json', JSON.stringify(personaContextGraphPayload(), null, 2));
    showToast('Context graph exported', true);
  };

  window.createTaskFromPersonaContextGraph = function() {
    var graph = personaContextGraphPayload();
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'personaContextGraph',
      contextGraph: graph,
      readiness: personaRuntimeHandoffPayload(null).readiness || [],
      sessionLinks: personaSessionLinksPayload(),
      rolePreview: personaRolePreviewPayload(),
      promptBundle: personaData.promptBundle && !personaData.promptLoading ? personaPromptBundlePayload() : null,
      assetManifest: personaAssetManifestPayload(),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: graph.activeDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review persona context graph: ' + (graph.selectedRole || 'role') + ' / ' + (graph.activeDirector || 'main'),
      prompt: personaContextGraphTaskPrompt(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Persona context graph loaded into task form', true);
  };

  window.copyPersonaRuntimeHandoff = async function() {
    var doc = personaMemoryDoc();
    var preview = doc && personaData.docPreview && personaData.docPreview.path === doc.path ? personaData.docPreview : null;
    try {
      if (doc && !preview) preview = await fetchPersonaAssetContent(doc.path);
    } catch (err) {
      showToast('Runtime handoff copied without memory content: ' + err.message, false);
    }
    copyText(JSON.stringify(personaRuntimeHandoffPayload(preview), null, 2));
  };

  window.exportPersonaRuntimeHandoff = async function() {
    var doc = personaMemoryDoc();
    var preview = doc && personaData.docPreview && personaData.docPreview.path === doc.path ? personaData.docPreview : null;
    try {
      if (doc && !preview) preview = await fetchPersonaAssetContent(doc.path);
    } catch (err) {
      showToast('Runtime handoff exported without memory content: ' + err.message, false);
    }
    downloadTextFile('persona-runtime-handoff-' + safeAssetName(personaData.selectedRole || 'role', 'role') + '-' + Date.now() + '.json', JSON.stringify(personaRuntimeHandoffPayload(preview), null, 2));
    showToast('Runtime handoff exported', true);
  };

  window.createTaskFromPersonaRuntimeHandoff = async function() {
    var doc = personaMemoryDoc();
    var preview = doc && personaData.docPreview && personaData.docPreview.path === doc.path ? personaData.docPreview : null;
    try {
      if (doc && !preview) preview = await fetchPersonaAssetContent(doc.path);
    } catch (err) {
      showToast('Creating handoff task without memory content: ' + err.message, false);
    }
    var payload = personaRuntimeHandoffPayload(preview);
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: payload.activeDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Continue from Persona handoff: ' + (payload.selectedRole || 'runtime'),
      prompt: personaRuntimeHandoffTaskPrompt(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Persona handoff loaded into task form', true);
  };

  window.deletePersonaSessionLink = async function(key) {
    var link = personaSessionLinkByKey(key);
    if (!link) return;
    queueDangerApproval({
      title: 'Delete session link',
      target: link.channel + ' / ' + link.externalId,
      detail: 'The external session mapping will be removed from persona session links.',
      severity: 'medium',
      payload: link,
    }, async function() {
    try {
      var res = await fetch('/api/persona/session-links?channel=' + encodeURIComponent(link.channel) + '&external_id=' + encodeURIComponent(link.externalId), {
        method: 'DELETE',
      });
      var body = await res.json().catch(function() { return {}; });
      if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
      personaData.sessionLinks = Object.assign({}, personaData.sessionLinks || {});
      delete personaData.sessionLinks[key];
      showToast('Session link deleted', true);
      renderPersonaView();
    } catch (err) {
      showToast('Delete failed: ' + err.message, false);
      throw err;
    }
    });
  };

  function renderPersonaView() {
    if (!personaLoaded) {
      $('detail-content').innerHTML = '<div class="empty">Loading persona...</div>';
      return;
    }
    var html = '<div class="page-grid">';
    html += '<div class="workbench-panel"><div class="panel-title"><span>Roles</span><span>' + personaData.roles.length + '</span></div><div class="panel-list">';
    if (personaData.roles.length === 0) {
      html += '<div class="empty">No roles found</div>';
      html += '<button class="mini-btn" onclick="selectPersonaRole(\'director\')">Preview director fallback</button>';
    } else {
      for (var i = 0; i < personaData.roles.length; i++) {
        var r = personaData.roles[i];
        var selected = personaData.selectedRole === r.role;
        html += '<div class="panel-row clickable' + (selected ? ' selected' : '') + '" onclick="selectPersonaRole(\'' + jsq(r.role) + '\')"><div class="panel-row-main"><div class="panel-row-title">' + esc(r.name || r.role) + '</div>';
        html += '<div class="panel-row-sub">' + esc(r.role) + (r.description ? ' · ' + esc(r.description) : '') + '</div></div></div>';
      }
    }
    html += '</div>' + renderPersonaRoleSwitchPreview() + '</div>';
    html += '<div class="workbench-panel"><div class="panel-title"><span>Prompt Bundle</span><div class="panel-actions"><span class="muted">' + esc(personaData.selectedRole || '--') + '</span>';
    if (personaData.promptBundle && !personaData.promptLoading) {
      html += '<button class="mini-btn" onclick="copyPersonaPromptBundle()">Copy Bundle</button>';
      html += '<button class="mini-btn" onclick="exportPersonaPromptBundle()">Export Bundle</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromPersonaPromptBundle()">Create Task</button>';
    }
    html += '</div></div>';
    html += renderPromptBundlePanel();
    html += '</div>';
    html += renderPersonaSkillsMcpPanel();
    html += renderPersonaAssetsPanel();
    html += renderPersonaMemoryPanel();
    html += renderPersonaContextGraphPanel();
    html += renderPersonaSessionLinksPanel();
    html += renderPersonaDocPanel('state', 'State', 'daily/state.md', personaData.state);
    html += renderPersonaDocPanel('todo', 'TODO', 'TODO.md', personaData.todo, true);
    html += '</div>';
    $('detail-content').innerHTML = html;
  }

  function renderPersonaRoleSwitchPreview() {
    var role = selectedPersonaRoleRecord();
    var bundle = personaData.promptBundle || {};
    var baseFiles = bundle.files && bundle.files.base || [];
    var developerFiles = bundle.files && bundle.files.developer || [];
    var targetDirector = activeDirectorLabel();
    var html = '<div class="persona-role-preview">';
    html += '<div class="panel-title"><span>Role Switch Preview</span><span class="muted">' + esc(targetDirector) + '</span></div>';
    html += '<div class="kv-grid">';
    html += '<div class="kv-card"><div class="kv-label">Role</div><div class="kv-value">' + esc(personaData.selectedRole || '--') + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Target</div><div class="kv-value">' + esc(targetDirector) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Prompt Files</div><div class="kv-value">' + esc(String(baseFiles.length + developerFiles.length)) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Prompt Size</div><div class="kv-value">' + esc(String(String(bundle.baseInstructions || '').length + String(bundle.developerInstructions || '').length)) + '</div></div>';
    html += '</div>';
    if (role && role.description) html += '<div class="persona-role-description">' + esc(role.description) + '</div>';
    if (bundle.error) html += '<div class="td-error compact">' + esc(bundle.error) + '</div>';
    html += '<div class="panel-actions persona-role-actions">';
    html += '<button class="mini-btn" onclick="copyPersonaRolePreview()">Copy Preview</button>';
    html += '<button class="mini-btn" onclick="exportPersonaRolePreview()">Export Preview</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromPersonaRolePreview()">Create Task</button>';
    html += '<button class="mini-btn primary" onclick="switchActiveDirectorPersona()">Switch Active Director</button>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  window.copyPersonaRolePreview = function() {
    copyText(JSON.stringify(personaRolePreviewPayload(), null, 2));
  };

  window.exportPersonaRolePreview = function() {
    downloadTextFile('persona-role-preview-' + String(personaData.selectedRole || 'role').replace(/[^a-z0-9._-]+/gi, '-') + '-' + Date.now() + '.json', JSON.stringify(personaRolePreviewPayload(), null, 2));
    showToast('Role preview exported', true);
  };

  function personaRolePreviewTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench role switch preview handoff as task context.',
      '',
      'Operator intent:',
      '- Review the selected persona role and target Director before any runtime persona switch.',
      '- Compare the role preview, prompt bundle, visible persona assets, runtime snapshot, session link draft, and approval context.',
      '- If switching looks risky, stale, or under-specified, propose safer preparation steps or a scoped config/context fix.',
      '- Do not switch the active Director persona unless the task prompt is explicitly edited.',
      '',
      'Persona role switch preview handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromPersonaRolePreview = function() {
    var preview = personaRolePreviewPayload();
    if (!preview.role) {
      showToast('No persona role selected', false);
      return;
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'personaRoleSwitchPreview',
      rolePreview: preview,
      promptBundle: personaPromptBundlePayload(),
      assetManifest: personaAssetManifestPayload(),
      runtimeSnapshot: runtimeSnapshotPayload(),
      contextGraph: personaContextGraphPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: preview.targetDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review persona role switch: ' + (preview.targetDirector || 'main') + ' -> ' + preview.role,
      prompt: personaRolePreviewTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Persona role preview loaded into task form', true);
  };

  window.copyPersonaPromptBundle = function() {
    if (!personaData.promptBundle || personaData.promptLoading) {
      showToast('Prompt bundle is not loaded', false);
      return;
    }
    copyText(JSON.stringify(personaPromptBundlePayload(), null, 2));
  };

  window.exportPersonaPromptBundle = function() {
    if (!personaData.promptBundle || personaData.promptLoading) {
      showToast('Prompt bundle is not loaded', false);
      return;
    }
    var safe = String(personaData.selectedRole || 'role').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-prompt-bundle-' + safe + '-' + Date.now() + '.json', JSON.stringify(personaPromptBundlePayload(), null, 2));
    showToast('Prompt bundle exported', true);
  };

  function personaPromptBundleTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench prompt bundle handoff as task context.',
      '',
      'Operator intent:',
      '- Review the complete prompt bundle for the selected persona role before changing prompts or runtime routing.',
      '- Compare base/developer instructions, prompt files, role preview, visible persona assets, context graph, runtime snapshot, and approval context.',
      '- If prompt content is stale, contradictory, oversized, missing files, or misaligned with the active role/session, propose or implement a scoped prompt/context fix.',
      '- Do not switch persona roles, edit persona documents, or change provider routing unless the task prompt is explicitly edited.',
      '',
      'Persona prompt bundle handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromPersonaPromptBundle = function() {
    if (!personaData.promptBundle || personaData.promptLoading) {
      showToast('Prompt bundle is not loaded', false);
      return;
    }
    var bundle = personaPromptBundlePayload();
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'personaPromptBundle',
      promptBundle: bundle,
      rolePreview: personaRolePreviewPayload(),
      assetManifest: personaAssetManifestPayload(),
      contextGraph: personaContextGraphPayload(),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: bundle.activeDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review persona prompt bundle: ' + (bundle.role || 'role'),
      prompt: personaPromptBundleTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Persona prompt bundle loaded into task form', true);
  };

  window.switchActiveDirectorPersona = function() {
    var role = personaData.selectedRole || '';
    if (!role) {
      showToast('No persona role selected', false);
      return;
    }
    var director = activeDirectorLabel();
    queueDangerApproval({
      title: 'Switch active Director persona',
      target: director + ' -> ' + role,
      detail: 'Current context will be checkpointed before switching the active Director persona.',
      severity: 'medium',
      payload: { director_label: director, role: role },
    }, async function() {
      try {
        var res = await fetch('/api/directors/switch-persona', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ director_label: director, role: role }),
        });
        var body = await res.json().catch(function() { return {}; });
        if (!res.ok || body.error || body.ok === false) throw new Error(body.error || 'switch persona failed');
        showToast('Persona switched: ' + (body.role || role), true);
      } catch (err) {
        showToast('Switch failed: ' + err.message, false);
        throw err;
      }
    });
  };

  function renderPersonaAssetsPanel() {
    var docs = personaData.docs || [];
    var visibleDocs = filteredPersonaAssetDocs();
    var selected = visibleDocs.find(function(doc) { return doc.path === personaData.selectedDoc; }) || visibleDocs[0] || null;
    if (selected && personaData.selectedDoc !== selected.path) personaData.selectedDoc = selected.path;
    var preview = personaData.docPreview;
    var html = '<div class="workbench-panel wide"><div class="panel-title"><span>Persona Assets</span><div class="panel-actions"><span>' + visibleDocs.length + '/' + docs.length + '</span>';
    if (visibleDocs.length) {
      html += '<button class="mini-btn" onclick="copyPersonaAssetManifest()">Copy Manifest</button>';
      html += '<button class="mini-btn" onclick="exportPersonaAssetManifest()">Export Manifest</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromPersonaAssetManifest()">Create Task</button>';
    }
    html += '<button class="mini-btn" onclick="loadPersonaWorkbenchData()">Refresh</button></div></div>';
    if (personaData.docError) {
      html += '<div class="td-error compact">' + esc(personaData.docError) + '</div>';
    }
    html += renderPersonaRecentChanges(visibleDocs.length ? visibleDocs : docs);
    html += renderPersonaAssetFilters(docs, visibleDocs);
    html += '<div class="persona-assets-layout">';
    html += '<div class="persona-assets-list">';
    if (docs.length === 0) {
      html += '<div class="empty">No persona docs found</div>';
    } else if (visibleDocs.length === 0) {
      html += '<div class="empty">No persona docs match the current filters.</div>';
    } else {
      var currentCategory = null;
      for (var i = 0; i < visibleDocs.length; i++) {
        var doc = visibleDocs[i];
        if (doc.category !== currentCategory) {
          currentCategory = doc.category;
          html += '<div class="asset-category">' + esc(personaDocCategoryLabel(currentCategory)) + '</div>';
        }
        var active = doc.path === personaData.selectedDoc;
        var freshness = personaDocFreshness(doc);
        var contextDoc = doc.category === 'workspace' || doc.category === 'session';
        html += '<div class="panel-row clickable asset-row asset-' + freshness + (contextDoc ? ' context-doc' : '') + (active ? ' selected' : '') + '" onclick="selectPersonaAssetDoc(\'' + jsq(doc.path) + '\')">';
        html += '<span class="badge ' + (doc.editable ? 'ok' : 'pending') + '">' + (doc.editable ? 'edit' : 'view') + '</span>';
        html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(doc.name);
        if (contextDoc) html += ' <span class="inline-chip">' + esc(personaDocCategoryLabel(doc.category)) + '</span>';
        if (freshness === 'hot') html += ' <span class="inline-chip warm">changed</span>';
        html += '</div>';
        html += '<div class="panel-row-sub">' + esc(doc.path) + ' · ' + fmtFileSize(doc.size) + ' · ' + fmtAgo(doc.mtimeMs) + '</div></div></div>';
      }
    }
    html += '</div>';
    html += '<div class="persona-asset-preview">';
    if (!selected) {
      html += '<div class="empty">Select a persona asset</div>';
    } else {
      html += '<div class="panel-title"><span>' + esc(selected.path) + '</span><div class="panel-actions">';
      html += '<button class="mini-btn" onclick="copyText(\'' + jsq(selected.path) + '\')">Copy Path</button>';
      html += '<button class="mini-btn" onclick="copyPersonaAssetBundle(\'' + jsq(selected.path) + '\')">Copy Bundle</button>';
      html += '<button class="mini-btn" onclick="exportPersonaAssetBundle(\'' + jsq(selected.path) + '\')">Export Bundle</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromPersonaAssetBundle(\'' + jsq(selected.path) + '\')">Create Task</button>';
      html += '<button class="mini-btn" onclick="revealPersonaDocPath(\'' + jsq(selected.path) + '\')">Reveal</button>';
      if (preview && preview.editable && !personaData.docEditing) html += '<button class="mini-btn" onclick="editPersonaAssetDoc(true)">Edit</button>';
      if (personaData.docEditing) {
        html += '<button class="mini-btn" onclick="editPersonaAssetDoc(false)">Cancel</button>';
        html += '<button class="mini-btn primary" onclick="savePersonaAssetDoc()">Save</button>';
      }
      html += '</div></div>';
      html += '<div class="persona-asset-meta"><span>Category: ' + esc(personaDocCategoryLabel(selected.category)) + '</span><span>Modified: ' + esc(fmtAgo(selected.mtimeMs)) + '</span><span>Size: ' + esc(fmtFileSize(selected.size)) + '</span><span>' + (selected.editable ? 'Editable' : 'Read only') + '</span></div>';
      if (!preview || preview.path !== selected.path) {
        html += '<div class="td-result-running"><div class="spinner"></div><span>Loading asset...</span></div>';
      } else if (personaData.docEditing) {
        html += '<textarea class="persona-doc-editor persona-asset-editor" id="persona-asset-editor" spellcheck="false">' + esc(preview.content || '') + '</textarea>';
      } else if (/\.(md|markdown)$/i.test(selected.path)) {
        html += '<div class="td-output"><div class="md-content">' + renderMd(preview.content || '') + '</div></div>';
      } else {
        html += '<pre class="prompt-preview">' + esc(preview.content || '') + '</pre>';
      }
    }
    html += '</div></div></div>';
    return html;
  }

  function renderPersonaMemoryPanel() {
    var docs = personaData.docs || [];
    var memoryDocs = docs.filter(function(doc) { return doc.category === 'memory'; });
    var workspaceDocs = docs.filter(function(doc) { return doc.category === 'workspace'; });
    var sessionDocs = docs.filter(function(doc) { return doc.category === 'session'; });
    var doc = personaMemoryDoc();
    var preview = doc && personaData.docPreview && personaData.docPreview.path === doc.path ? personaData.docPreview : null;
    var html = '<div class="workbench-panel wide persona-memory-panel"><div class="panel-title"><span>Memory Snapshot</span><div class="panel-actions">';
    html += '<span>' + memoryDocs.length + ' memory docs</span>';
    html += '<button class="mini-btn" onclick="copyPersonaMemoryBundle()">Copy Bundle</button>';
    html += '<button class="mini-btn" onclick="exportPersonaMemoryBundle()">Export Bundle</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromPersonaMemoryBundle()">Create Task</button>';
    if (doc) {
      html += '<button class="mini-btn" onclick="copyPersonaMemoryMarkdown()">Copy Markdown</button>';
      html += '<button class="mini-btn primary" onclick="openPersonaMemoryDoc()">Open Memory</button>';
    }
    html += '</div></div>';
    if (!doc) {
      html += '<div class="empty">No memory markdown document found in persona assets.</div>';
    } else {
      html += '<div class="memory-snapshot-grid">';
      html += '<div class="memory-snapshot-main">';
      html += '<div class="panel-row-title">' + esc(doc.name || doc.path) + '</div>';
      html += '<div class="panel-row-sub">' + esc(doc.path || '--') + '</div>';
      html += '<div class="persona-asset-meta"><span>' + esc(personaDocCategoryLabel(doc.category)) + '</span><span>' + esc(fmtAgo(doc.mtimeMs)) + '</span><span>' + esc(fmtFileSize(doc.size)) + '</span><span>' + (doc.editable ? 'Editable' : 'Read only') + '</span></div>';
      if (preview) {
        html += '<div class="memory-preview">' + esc(shortText(preview.content || '', 360)) + '</div>';
      } else {
        html += '<div class="memory-preview muted">Open Memory to load the current markdown preview.</div>';
      }
      html += '</div>';
      html += '<div class="memory-snapshot-stats">';
      html += '<div class="kv-card"><div class="kv-label">Workspace Docs</div><div class="kv-value">' + esc(String(workspaceDocs.length)) + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Session Docs</div><div class="kv-value">' + esc(String(sessionDocs.length)) + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">State Chars</div><div class="kv-value">' + esc(String(String(personaData.state || '').length)) + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">TODO Chars</div><div class="kv-value">' + esc(String(String(personaData.todo || '').length)) + '</div></div>';
      html += '</div></div>';
    }
    html += '</div>';
    return html;
  }

  function renderPersonaSkillsMcpPanel() {
    var skills = configAssetsData.skills || [];
    var mcpConfigs = configAssetsData.mcpConfigs || [];
    var serverCount = mcpConfigs.reduce(function(sum, cfg) { return sum + ((cfg.servers || []).length); }, 0);
    var selectedSkill = personaSkillByPath(configAssetsData.selectedSkillPath) || skills[0] || null;
    if (selectedSkill && !configAssetsData.selectedSkillPath) configAssetsData.selectedSkillPath = selectedSkill.path;
    var html = '<div class="workbench-panel wide"><div class="panel-title"><span>Skills & MCP</span><div class="panel-actions"><span>' + skills.length + ' skills · ' + serverCount + ' servers</span><button class="mini-btn" onclick="loadConfigAssets()">Refresh</button></div></div>';
    if (configAssetsData.loading) {
      html += '<div class="td-result-running"><div class="spinner"></div><span>Loading skills and MCP config...</span></div>';
    } else if (configAssetsData.error) {
      html += '<div class="td-error compact">' + esc(configAssetsData.error) + '</div>';
    } else {
      html += '<div class="persona-skill-mcp-layout">';
      html += '<div><div class="diagnostic-section-title">Skills</div><div class="persona-skill-list">';
      if (skills.length === 0) {
        html += '<div class="empty compact">No skills found in configured skill roots.</div>';
      } else {
        for (var i = 0; i < Math.min(skills.length, 24); i++) {
          var skill = skills[i];
          var active = selectedSkill && selectedSkill.path === skill.path;
          html += '<div class="persona-skill-row clickable' + (active ? ' selected' : '') + '" onclick="selectPersonaSkill(\'' + jsq(skill.path) + '\')"><span class="badge pending">' + esc(skill.source || 'skill') + '</span><div class="panel-row-main">';
          html += '<div class="panel-row-title">' + esc(skill.name || 'skill') + '</div>';
          html += '<div class="panel-row-sub">' + esc(shortText(skill.description || skill.path || '', 140)) + '</div>';
          html += '<div class="panel-row-sub">' + esc(skill.path || '--') + '</div></div></div>';
        }
      }
      html += renderPersonaSkillDetail(selectedSkill);
      html += '</div></div>';
      html += '<div><div class="diagnostic-section-title">MCP Servers</div><div class="persona-skill-list">';
      if (serverCount === 0) {
        html += '<div class="empty compact">No MCP servers found.</div>';
      } else {
        for (var ci = 0; ci < mcpConfigs.length; ci++) {
          var cfg = mcpConfigs[ci];
          var servers = cfg.servers || [];
          html += '<div class="config-file-card">';
          html += '<div class="panel-row-title">' + esc(cfg.label || 'mcp') + ' <span class="badge pending">' + esc(String(servers.length)) + ' servers</span></div>';
          html += '<div class="panel-row-sub">' + esc(cfg.path || '--') + '</div>';
          html += '<div class="panel-actions config-card-actions">';
          html += '<button class="chat-msg-action" onclick="copyPersonaMcpConfigBundle(' + ci + ')">Copy Config</button>';
          html += '<button class="chat-msg-action" onclick="exportPersonaMcpConfigBundle(' + ci + ')">Export Config</button>';
          html += '<button class="chat-msg-action primary" onclick="createTaskFromPersonaMcpConfig(' + ci + ')">Create Task</button>';
          if (cfg.path) html += '<button class="chat-msg-action" onclick="copyText(\'' + jsq(cfg.path) + '\')">Copy Path</button>';
          html += '</div>';
          if (cfg.parseError) html += '<div class="td-error compact">' + esc(cfg.parseError) + '</div>';
          if (!servers.length) html += '<div class="empty compact">No servers in this MCP config.</div>';
          if (servers.length) html += '<div class="mcp-server-list">';
          for (var si = 0; si < servers.length; si++) {
            var server = servers[si];
            html += '<div class="mcp-server-row"><span class="badge ' + (server.disabled ? 'cancelled' : 'completed') + '">' + (server.disabled ? 'off' : 'on') + '</span><div class="panel-row-main">';
            html += '<div class="panel-row-title">' + esc(server.name || '--') + '</div>';
            html += '<div class="panel-row-sub">' + esc(server.command || '--') + (server.args && server.args.length ? ' · ' + esc(server.args.join(' ')) : '') + '</div>';
            if (server.envKeys && server.envKeys.length) html += '<div class="panel-row-sub">env: ' + esc(server.envKeys.join(', ')) + '</div>';
            html += '</div><div class="panel-actions persona-mcp-server-actions">';
            html += '<button class="chat-msg-action" onclick="copyPersonaMcpServerBundle(' + ci + ',' + si + ')">Copy</button>';
            html += '<button class="chat-msg-action" onclick="exportPersonaMcpServerBundle(' + ci + ',' + si + ')">Export</button>';
            html += '<button class="chat-msg-action primary" onclick="createTaskFromPersonaMcpServer(' + ci + ',' + si + ')">Create Task</button>';
            html += '</div></div>';
          }
          if (servers.length) html += '</div>';
          html += '</div>';
        }
      }
      html += '</div></div></div>';
    }
    html += '</div>';
    return html;
  }

  function personaSkillByPath(path) {
    if (!path) return null;
    var skills = configAssetsData.skills || [];
    for (var i = 0; i < skills.length; i++) {
      if (skills[i].path === path) return skills[i];
    }
    return null;
  }

  function personaSkillBundlePayload(skill) {
    var skills = configAssetsData.skills || [];
    var mcpConfigs = configAssetsData.mcpConfigs || [];
    var serverCount = mcpConfigs.reduce(function(sum, cfg) { return sum + ((cfg.servers || []).length); }, 0);
    return {
      exportedAt: new Date().toISOString(),
      selectedRole: personaData.selectedRole || '',
      activeDirector: activeDirectorLabel(),
      runtimeSessionId: activeRuntimeSessionId(),
      selectedSkillPath: skill && skill.path || '',
      skill: skill || null,
      inventory: {
        skillCount: skills.length,
        mcpConfigCount: mcpConfigs.length,
        mcpServerCount: serverCount,
      },
      mcpConfigs: mcpConfigs,
    };
  }

  function personaMcpInventory() {
    var mcpConfigs = configAssetsData.mcpConfigs || [];
    return {
      configCount: mcpConfigs.length,
      serverCount: mcpConfigs.reduce(function(sum, cfg) { return sum + ((cfg.servers || []).length); }, 0),
      enabledServerCount: mcpConfigs.reduce(function(sum, cfg) {
        return sum + ((cfg.servers || []).filter(function(server) { return !server.disabled; }).length);
      }, 0),
      disabledServerCount: mcpConfigs.reduce(function(sum, cfg) {
        return sum + ((cfg.servers || []).filter(function(server) { return !!server.disabled; }).length);
      }, 0),
    };
  }

  function personaMcpConfigBundlePayload(index) {
    var cfg = (configAssetsData.mcpConfigs || [])[index] || null;
    return {
      exportedAt: new Date().toISOString(),
      selectedRole: personaData.selectedRole || '',
      activeDirector: activeDirectorLabel(),
      runtimeSessionId: activeRuntimeSessionId(),
      configIndex: index,
      inventory: personaMcpInventory(),
      config: cfg,
    };
  }

  function personaMcpServerBundlePayload(configIndex, serverIndex) {
    var cfg = (configAssetsData.mcpConfigs || [])[configIndex] || null;
    var servers = cfg && cfg.servers || [];
    var server = servers[serverIndex] || null;
    return {
      exportedAt: new Date().toISOString(),
      selectedRole: personaData.selectedRole || '',
      activeDirector: activeDirectorLabel(),
      runtimeSessionId: activeRuntimeSessionId(),
      configIndex: configIndex,
      serverIndex: serverIndex,
      config: cfg ? {
        label: cfg.label || '',
        path: cfg.path || '',
        parseError: cfg.parseError || null,
        serverCount: servers.length,
      } : null,
      server: server,
      inventory: personaMcpInventory(),
    };
  }

  function renderPersonaSkillDetail(skill) {
    if (!skill) return '<div class="persona-skill-detail empty compact">Select a skill to inspect its metadata.</div>';
    var detail = {
      source: skill.source || 'skill',
      name: skill.name || 'skill',
      description: skill.description || '',
      path: skill.path || '',
      size: skill.size || 0,
      modified: skill.mtimeMs || null,
    };
    var html = '<div class="persona-skill-detail">';
    html += '<div class="panel-title"><span>Skill Detail</span><div class="panel-actions">';
    html += '<button class="mini-btn" onclick="copyPersonaSkillDetail()">Copy Bundle</button>';
    html += '<button class="mini-btn" onclick="exportPersonaSkillDetail()">Export Bundle</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromPersonaSkillDetail()">Create Task</button>';
    if (skill.path) html += '<button class="mini-btn" onclick="copyText(\'' + jsq(skill.path) + '\')">Copy Path</button>';
    html += '</div></div>';
    html += '<div class="kv-grid">';
    html += '<div class="kv-card"><div class="kv-label">Name</div><div class="kv-value">' + esc(detail.name) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Source</div><div class="kv-value">' + esc(detail.source) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Modified</div><div class="kv-value">' + esc(fmtAgo(detail.modified)) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Size</div><div class="kv-value">' + esc(fmtFileSize(detail.size)) + '</div></div>';
    html += '</div>';
    if (detail.description) html += '<div class="persona-skill-description">' + esc(detail.description) + '</div>';
    html += '<div class="file-path mono">' + esc(detail.path || '--') + '</div>';
    html += '</div>';
    return html;
  }

  window.selectPersonaSkill = function(path) {
    configAssetsData.selectedSkillPath = path;
    renderPersonaView();
  };

  window.copyPersonaSkillDetail = function() {
    var skill = personaSkillByPath(configAssetsData.selectedSkillPath) || (configAssetsData.skills || [])[0];
    if (!skill) {
      showToast('No skill selected', false);
      return;
    }
    copyText(JSON.stringify(personaSkillBundlePayload(skill), null, 2));
  };

  window.exportPersonaSkillDetail = function() {
    var skill = personaSkillByPath(configAssetsData.selectedSkillPath) || (configAssetsData.skills || [])[0];
    if (!skill) {
      showToast('No skill selected', false);
      return;
    }
    var safe = String(skill.name || skill.path || 'skill').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-skill-bundle-' + safe + '-' + Date.now() + '.json', JSON.stringify(personaSkillBundlePayload(skill), null, 2));
    showToast('Skill bundle exported', true);
  };

  function personaSkillTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench skill handoff as task context.',
      '',
      'Operator intent:',
      '- Review the selected skill metadata and decide whether the skill needs usage guidance, repair, integration testing, or MCP alignment.',
      '- Use the skill bundle, role preview, prompt bundle, asset manifest, MCP inventory, runtime snapshot, and approval context before acting.',
      '- If a skill or MCP config change is needed, keep it scoped and preserve existing runtime/provider behavior.',
      '- Do not edit skill files, MCP configs, or persona docs unless the task prompt is explicitly edited.',
      '',
      'Persona skill handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromPersonaSkillDetail = function() {
    var skill = personaSkillByPath(configAssetsData.selectedSkillPath) || (configAssetsData.skills || [])[0];
    if (!skill) {
      showToast('No skill selected', false);
      return;
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'personaSkillDetail',
      skillBundle: personaSkillBundlePayload(skill),
      rolePreview: personaRolePreviewPayload(),
      promptBundle: personaData.promptBundle && !personaData.promptLoading ? personaPromptBundlePayload() : null,
      assetManifest: personaAssetManifestPayload(),
      contextGraph: personaContextGraphPayload(),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: payload.skillBundle.activeDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review persona skill: ' + (skill.name || skill.path || 'skill'),
      prompt: personaSkillTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Persona skill loaded into task form', true);
  };

  function personaMcpTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench MCP handoff as task context.',
      '',
      'Operator intent:',
      '- Review the selected MCP config or server and decide whether MCP integration, command wiring, environment keys, disabled state, or parse errors need attention.',
      '- Use the MCP bundle, MCP inventory, role preview, prompt bundle, asset manifest, context graph, runtime snapshot, and approval context before acting.',
      '- If an MCP config or server fix is needed, keep it scoped and preserve existing provider/runtime behavior.',
      '- Do not edit MCP configs, start/stop servers, or change provider routing unless the task prompt is explicitly edited.',
      '',
      'Persona MCP handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromPersonaMcpConfig = function(index) {
    var bundle = personaMcpConfigBundlePayload(index);
    if (!bundle.config) {
      showToast('MCP config not found', false);
      return;
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'personaMcpConfig',
      mcpBundle: bundle,
      mcpInventory: personaMcpInventory(),
      rolePreview: personaRolePreviewPayload(),
      promptBundle: personaData.promptBundle && !personaData.promptLoading ? personaPromptBundlePayload() : null,
      assetManifest: personaAssetManifestPayload(),
      contextGraph: personaContextGraphPayload(),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: bundle.activeDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review persona MCP config: ' + (bundle.config.label || bundle.config.path || 'mcp'),
      prompt: personaMcpTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Persona MCP config loaded into task form', true);
  };

  window.createTaskFromPersonaMcpServer = function(configIndex, serverIndex) {
    var bundle = personaMcpServerBundlePayload(configIndex, serverIndex);
    if (!bundle.server) {
      showToast('MCP server not found', false);
      return;
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'personaMcpServer',
      mcpBundle: bundle,
      mcpInventory: personaMcpInventory(),
      rolePreview: personaRolePreviewPayload(),
      promptBundle: personaData.promptBundle && !personaData.promptLoading ? personaPromptBundlePayload() : null,
      assetManifest: personaAssetManifestPayload(),
      contextGraph: personaContextGraphPayload(),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: bundle.activeDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review persona MCP server: ' + (bundle.server.name || 'server'),
      prompt: personaMcpTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Persona MCP server loaded into task form', true);
  };

  window.copyPersonaMcpConfigBundle = function(index) {
    var cfg = (configAssetsData.mcpConfigs || [])[index] || null;
    if (!cfg) {
      showToast('MCP config not found', false);
      return;
    }
    copyText(JSON.stringify(personaMcpConfigBundlePayload(index), null, 2));
  };

  window.exportPersonaMcpConfigBundle = function(index) {
    var cfg = (configAssetsData.mcpConfigs || [])[index] || null;
    if (!cfg) {
      showToast('MCP config not found', false);
      return;
    }
    downloadTextFile('persona-mcp-config-bundle-' + safeAssetName(cfg.label || cfg.path, 'mcp') + '-' + Date.now() + '.json', JSON.stringify(personaMcpConfigBundlePayload(index), null, 2));
    showToast('MCP config bundle exported', true);
  };

  window.copyPersonaMcpServerBundle = function(configIndex, serverIndex) {
    var payload = personaMcpServerBundlePayload(configIndex, serverIndex);
    if (!payload.server) {
      showToast('MCP server not found', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportPersonaMcpServerBundle = function(configIndex, serverIndex) {
    var payload = personaMcpServerBundlePayload(configIndex, serverIndex);
    if (!payload.server) {
      showToast('MCP server not found', false);
      return;
    }
    downloadTextFile('persona-mcp-server-bundle-' + safeAssetName(payload.server.name || 'server', 'server') + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('MCP server bundle exported', true);
  };

  function personaPromptFileList() {
    var bundle = personaData.promptBundle || {};
    var files = [];
    if (bundle.files && bundle.files.base) files = files.concat(bundle.files.base);
    if (bundle.files && bundle.files.developer) files = files.concat(bundle.files.developer);
    var seen = {};
    return files.filter(function(file) {
      if (!file || seen[file]) return false;
      seen[file] = true;
      return true;
    });
  }

  function renderContextGraphNode(kind, title, value, meta, actionHtml) {
    var html = '<div class="context-graph-node ' + esc(kind || 'node') + '">';
    html += '<div class="context-node-head"><span class="badge pending">' + esc(kind || 'node') + '</span><strong>' + esc(title || '--') + '</strong></div>';
    html += '<div class="context-node-value">' + esc(value || '--') + '</div>';
    if (meta) html += '<div class="panel-row-sub">' + esc(meta) + '</div>';
    if (actionHtml) html += '<div class="panel-actions context-node-actions">' + actionHtml + '</div>';
    html += '</div>';
    return html;
  }

  function renderPersonaHandoffReadiness() {
    var readiness = personaRuntimeHandoffPayload(null).readiness || [];
    var html = '<div class="context-handoff-readiness">';
    for (var i = 0; i < readiness.length; i++) {
      var item = readiness[i];
      html += '<div class="handoff-readiness-chip ' + (item.ok ? 'ok' : 'warn') + '">';
      html += '<span>' + esc(item.key) + '</span><strong>' + esc(item.ok ? 'ready' : 'check') + '</strong><em>' + esc(item.detail || '') + '</em>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderPersonaContextGraphPanel() {
    var links = personaSessionLinksArray();
    var runtimeSessionId = activeRuntimeSessionId();
    var directorLabel = activeDirectorLabel();
    var role = personaData.selectedRole || 'director';
    var currentLink = links.find(function(link) {
      return (link.directorLabel || 'main') === directorLabel && link.personaSessionId === runtimeSessionId;
    }) || links.find(function(link) {
      return (link.directorLabel || 'main') === directorLabel && link.role === role;
    }) || null;
    var promptFiles = personaPromptFileList();
    var workspaceDocs = (personaData.docs || []).filter(function(doc) { return doc.category === 'workspace'; }).length;
    var sessionDocs = (personaData.docs || []).filter(function(doc) { return doc.category === 'session'; }).length;
    var html = '<div class="workbench-panel wide context-graph-panel"><div class="panel-title"><span>Context Graph</span><div class="panel-actions"><span>' + links.length + ' links</span>';
    html += '<button class="mini-btn primary" onclick="createTaskFromPersonaContextGraph()">Create Task</button>';
    html += '<button class="mini-btn" onclick="copyPersonaRuntimeHandoff()">Copy Handoff</button>';
    html += '<button class="mini-btn" onclick="exportPersonaRuntimeHandoff()">Export Handoff</button>';
    html += '<button class="mini-btn" onclick="createTaskFromPersonaRuntimeHandoff()">Handoff Task</button>';
    html += '<button class="mini-btn" onclick="copyPersonaContextGraph()">Copy Graph</button>';
    html += '<button class="mini-btn" onclick="exportPersonaContextGraph()">Export Graph</button>';
    html += '<button class="mini-btn" onclick="resetPersonaSessionLinkDraft()">Link Current</button></div></div>';
    html += '<div class="context-graph-flow">';
    html += renderContextGraphNode('director', 'Runtime Director', directorLabel, 'active control surface', '<button class="chat-msg-action" onclick="copyText(\'' + jsq(directorLabel) + '\')">Copy</button>');
    html += '<div class="context-edge">uses</div>';
    html += renderContextGraphNode('role', 'Persona Role', role, 'prompt bundle and defaults', '<button class="chat-msg-action" onclick="selectPersonaRole(\'' + jsq(role) + '\')">Preview</button>');
    html += '<div class="context-edge">runs</div>';
    html += renderContextGraphNode('session', 'Runtime Session', runtimeSessionId || 'not attached', currentLink ? 'mapped by session link' : 'no exact session mapping yet', runtimeSessionId ? '<button class="chat-msg-action" onclick="copyText(\'' + jsq(runtimeSessionId) + '\')">Copy</button>' : '');
    html += '</div>';
    html += '<div class="context-graph-grid">';
    html += renderContextGraphNode('memory', 'Workspace Context', workspaceDocs + ' workspace docs', sessionDocs + ' session memory docs', '');
    html += renderContextGraphNode('prompt', 'Prompt Files', String(promptFiles.length), promptFiles.slice(0, 3).map(function(file) { return file.split('/').slice(-2).join('/'); }).join(' · '), '');
    if (currentLink) {
      var key = (currentLink.channel || '') + ':' + (currentLink.externalId || '');
      html += renderContextGraphNode('link', 'Current Link', (currentLink.channel || '--') + ' / ' + (currentLink.externalId || '--'), 'thread ' + (currentLink.codexThreadId || '--'), '<button class="chat-msg-action" onclick="usePersonaSessionLink(\'' + jsq(key) + '\')">Edit</button>');
    } else {
      html += renderContextGraphNode('link', 'Current Link', 'missing', 'save a link to bind this runtime session to external context', '<button class="chat-msg-action" onclick="resetPersonaSessionLinkDraft()">Prepare</button>');
    }
    html += '</div>';
    html += renderPersonaHandoffReadiness();
    if (links.length) {
      html += '<div class="context-link-strip">';
      for (var i = 0; i < Math.min(links.length, 8); i++) {
        var link = links[i];
        var linkKey = (link.channel || '') + ':' + (link.externalId || '');
        var active = currentLink && currentLink.channel === link.channel && currentLink.externalId === link.externalId;
        html += '<button class="context-link-chip' + (active ? ' active' : '') + '" onclick="usePersonaSessionLink(\'' + jsq(linkKey) + '\')">';
        html += '<strong>' + esc(link.channel || '--') + '</strong><span>' + esc(link.role || '--') + ' · ' + esc(link.directorLabel || 'main') + '</span>';
        html += '</button>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderPersonaSessionLinksPanel() {
    var links = personaSessionLinksArray();
    var draft = personaData.sessionLinkDraft || personaSessionLinkDefaults(personaData.selectedRole);
    var runtimeSessionId = activeRuntimeSessionId();
    var html = '<div class="workbench-panel wide"><div class="panel-title"><span>Session Links</span><div class="panel-actions"><span>' + links.length + '</span>';
    html += '<button class="mini-btn" onclick="copyPersonaSessionLinks()">Copy Links</button>';
    html += '<button class="mini-btn" onclick="exportPersonaSessionLinks()">Export Links</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromPersonaSessionLinks()">Create Task</button>';
    html += '<button class="mini-btn" onclick="resetPersonaSessionLinkDraft()">Use Current Runtime</button></div></div>';
    html += '<div class="kv-grid persona-link-runtime">';
    html += '<div class="kv-card"><div class="kv-label">Selected Role</div><div class="kv-value">' + esc(personaData.selectedRole || '--') + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Director</div><div class="kv-value">' + esc(activeDirectorLabel()) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Runtime Session</div><div class="kv-value">' + esc(runtimeSessionId || '--') + '</div></div>';
    html += '</div>';
    if (personaData.sessionLinksError) {
      html += '<div class="td-error compact">Session link API unavailable: ' + esc(personaData.sessionLinksError) + '</div>';
    }
    html += '<div class="persona-link-layout">';
    html += '<div class="persona-link-list">';
    if (links.length === 0) {
      html += '<div class="empty">No session links yet</div>';
    } else {
	      for (var i = 0; i < links.length; i++) {
	        var link = links[i];
	        var key = (link.channel || '') + ':' + (link.externalId || '');
	        var rowId = 'persona-session-link-' + safeAssetName(key, 'link');
	        var rowClass = 'persona-link-row' + (key === personaSessionLinkFocusKey ? ' focused' : '');
	        html += '<div id="' + esc(rowId) + '" class="' + rowClass + '">';
        html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(link.channel || '--') + ' / ' + esc(link.externalId || '--') + '</div>';
	        html += '<div class="panel-row-sub">role ' + esc(link.role || '--') + ' · director ' + esc(link.directorLabel || 'main') + ' · session ' + esc(link.personaSessionId || '--') + '</div>';
	        html += '<div class="panel-row-sub">thread ' + esc(link.codexThreadId || '--') + ' · updated ' + esc(fmtTimestamp(link.updatedAt)) + '</div></div>';
	        html += '<div class="panel-actions"><button class="mini-btn" onclick="copyPersonaSessionLink(\'' + jsq(key) + '\')">Copy JSON</button>';
	        html += '<button class="mini-btn" onclick="exportPersonaSessionLink(\'' + jsq(key) + '\')">Export</button>';
	        html += '<button class="mini-btn primary" onclick="createTaskFromPersonaSessionLink(\'' + jsq(key) + '\')">Create Task</button>';
	        html += '<button class="mini-btn" onclick="openPersonaSessionLinkContext(\'' + jsq(key) + '\')">Open Context</button>';
	        html += '<button class="mini-btn" onclick="usePersonaSessionLink(\'' + jsq(key) + '\')">Edit</button>';
        html += '<button class="mini-btn danger" onclick="deletePersonaSessionLink(\'' + jsq(key) + '\')">Delete</button></div>';
        html += '</div>';
      }
    }
    html += '</div>';
    html += '<div class="wb-form persona-link-form">';
    html += '<div class="form-grid">';
    html += '<label><span>Channel</span><input value="' + esc(draft.channel || '') + '" oninput="updatePersonaSessionLinkDraft(\'channel\', this.value)" placeholder="web"></label>';
    html += '<label><span>External ID</span><input value="' + esc(draft.external_id || '') + '" oninput="updatePersonaSessionLinkDraft(\'external_id\', this.value)" placeholder="web-console"></label>';
    html += '<label><span>Persona Session</span><input value="' + esc(draft.persona_session_id || '') + '" oninput="updatePersonaSessionLinkDraft(\'persona_session_id\', this.value)" placeholder="runtime session id"></label>';
    html += '<label><span>Codex Thread</span><input value="' + esc(draft.codex_thread_id || '') + '" oninput="updatePersonaSessionLinkDraft(\'codex_thread_id\', this.value)" placeholder="optional"></label>';
    html += '<label><span>Director</span><select onchange="updatePersonaSessionLinkDraft(\'director_label\', this.value)">' + sourceDirectorOptions(draft.director_label || 'main') + '</select></label>';
    html += '<label><span>Role</span><input list="role-options" value="' + esc(draft.role || '') + '" oninput="updatePersonaSessionLinkDraft(\'role\', this.value)" placeholder="director"></label>';
    html += '</div>';
    html += roleDatalistHtml();
    html += '<div class="form-actions"><button class="mini-btn primary" onclick="savePersonaSessionLink()">Save Link</button></div>';
    html += '</div></div></div>';
    return html;
  }

  function renderPersonaDocPanel(kind, title, path, content, wide) {
    var editing = personaData.editingDoc === kind;
    var html = '<div class="workbench-panel' + (wide ? ' wide' : '') + '">';
    html += '<div class="panel-title"><span>' + esc(title) + '</span><div class="panel-actions"><span class="muted">' + esc(path) + '</span>';
    if (editing) {
      html += '<button class="mini-btn" onclick="editPersonaDoc(null)">Cancel</button>';
      html += '<button class="mini-btn primary" onclick="savePersonaDoc(\'' + jsq(kind) + '\')">Save</button>';
    } else {
      html += '<button class="mini-btn" onclick="copyPersonaDocMarkdown(\'' + jsq(kind) + '\')">Copy Markdown</button>';
      html += '<button class="mini-btn" onclick="copyPersonaDocBundle(\'' + jsq(kind) + '\')">Copy Bundle</button>';
      html += '<button class="mini-btn" onclick="exportPersonaDocBundle(\'' + jsq(kind) + '\')">Export Bundle</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromPersonaDocPanel(\'' + jsq(kind) + '\')">Create Task</button>';
      html += '<button class="mini-btn" onclick="editPersonaDoc(\'' + jsq(kind) + '\')">Edit</button>';
    }
    html += '</div></div>';
    if (editing) {
      html += '<textarea class="persona-doc-editor" id="persona-doc-editor-' + esc(kind) + '" spellcheck="false">' + esc(content || '') + '</textarea>';
    } else {
      html += content ? '<div class="td-output"><div class="md-content">' + renderMd(content) + '</div></div>' : '<div class="empty">Empty</div>';
    }
    html += '</div>';
    return html;
  }

  function personaDocPanelInfo(kind) {
    var safeKind = kind === 'todo' ? 'todo' : 'state';
    return safeKind === 'todo'
      ? { kind: 'todo', title: 'TODO', path: 'TODO.md', content: personaData.todo || '' }
      : { kind: 'state', title: 'State', path: 'daily/state.md', content: personaData.state || '' };
  }

  function personaDocPanelBundlePayload(kind) {
    var doc = personaDocPanelInfo(kind);
    return {
      exportedAt: new Date().toISOString(),
      selectedRole: personaData.selectedRole || '',
      activeDirector: activeDirectorLabel(),
      runtimeSessionId: activeRuntimeSessionId(),
      doc: {
        kind: doc.kind,
        title: doc.title,
        path: doc.path,
        markdownLength: String(doc.content || '').length,
        hasContent: !!doc.content,
      },
      content: doc.content || '',
    };
  }

  window.copyPersonaDocMarkdown = function(kind) {
    var doc = personaDocPanelInfo(kind);
    if (!doc.content) {
      showToast(doc.title + ' is empty', false);
      return;
    }
    copyText(doc.content);
  };

  window.copyPersonaDocBundle = function(kind) {
    copyText(JSON.stringify(personaDocPanelBundlePayload(kind), null, 2));
  };

  window.exportPersonaDocBundle = function(kind) {
    var doc = personaDocPanelInfo(kind);
    downloadTextFile('persona-doc-' + safeAssetName(doc.path, doc.kind) + '-' + Date.now() + '.json', JSON.stringify(personaDocPanelBundlePayload(kind), null, 2));
    showToast(doc.title + ' bundle exported', true);
  };

  function personaDocPanelTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench state/TODO document handoff as task context.',
      '',
      'Operator intent:',
      '- Review the selected persistent context document before changing memory, state, TODO, workspace docs, or session links.',
      '- Compare the selected doc with its paired state/TODO document, asset manifest, role preview, prompt bundle, context graph, runtime snapshot, and approval context.',
      '- If the document is stale, overloaded, contradictory, missing actionability, or misaligned with the active role/session, propose or implement a scoped cleanup.',
      '- Do not edit state, TODO, memory docs, or session links unless the task prompt is explicitly edited.',
      '',
      'Persona state/TODO handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromPersonaDocPanel = function(kind) {
    var doc = personaDocPanelInfo(kind);
    var pairedKind = doc.kind === 'state' ? 'todo' : 'state';
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'personaDocPanel',
      selectedDoc: personaDocPanelBundlePayload(doc.kind),
      pairedDoc: personaDocPanelBundlePayload(pairedKind),
      assetManifest: personaAssetManifestPayload(),
      rolePreview: personaRolePreviewPayload(),
      promptBundle: personaData.promptBundle && !personaData.promptLoading ? personaPromptBundlePayload() : null,
      contextGraph: personaContextGraphPayload(),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: payload.selectedDoc.activeDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review persona ' + doc.title + ': ' + doc.path,
      prompt: personaDocPanelTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast(doc.title + ' loaded into task form', true);
  };

  function renderPromptBundlePanel() {
    if (personaData.promptLoading) {
      return '<div class="td-result-running"><div class="spinner"></div><span>Loading prompt bundle...</span></div>';
    }
    var bundle = personaData.promptBundle;
    if (!bundle) {
      return '<div class="empty">Select a role to preview base and developer instructions</div>';
    }
    if (bundle.error) {
      return '<div class="td-error">' + esc(bundle.error) + '</div>';
    }
    var baseFiles = bundle.files && bundle.files.base || [];
    var devFiles = bundle.files && bundle.files.developer || [];
    var html = '<div class="prompt-files">';
    html += '<div><div class="kv-label">Base files</div>' + renderFileList(baseFiles) + '</div>';
    html += '<div><div class="kv-label">Developer files</div>' + renderFileList(devFiles) + '</div>';
    html += '</div>';
    html += '<div class="prompt-preview-grid">';
    html += '<div><div class="td-section-title">Base Instructions</div><pre class="prompt-preview">' + esc(bundle.baseInstructions || '') + '</pre></div>';
    html += '<div><div class="td-section-title">Developer Instructions</div><pre class="prompt-preview">' + esc(bundle.developerInstructions || '') + '</pre></div>';
    html += '</div>';
    return html;
  }

  function renderFileList(files) {
    if (!files || files.length === 0) return '<div class="empty" style="padding:8px 0;text-align:left">No files</div>';
    var html = '<div class="file-list">';
    for (var i = 0; i < files.length; i++) {
      html += '<div class="file-pill" title="' + esc(files[i]) + '">' + esc(files[i].split('/').slice(-2).join('/')) + '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderFilesView() {
    var allFiles = filesData.files || [];
    var files = filteredWorkbenchFiles();
    var selected = files.find(function(file) { return file.path === filesData.selectedPath; }) || files[0] || null;
    if (selected && filesData.selectedPath !== selected.path) filesData.selectedPath = selected.path;
    var recent = recentWorkbenchFiles(files);

    var html = '<div class="files-layout">';
    html += '<div class="workbench-panel files-list-panel">';
    html += '<div class="panel-title"><span>Artifacts</span><div class="panel-actions">';
    html += '<span>' + files.length + '/' + allFiles.length + '</span>';
    if (files.length > 0) {
      html += '<button class="mini-btn" onclick="copyVisibleFileManifest()">Copy Manifest</button>';
      html += '<button class="mini-btn" onclick="exportVisibleFileManifest()">Export Manifest</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromVisibleFileManifest()">Manifest Task</button>';
    }
    html += '<button class="mini-btn" onclick="copyFileDiagnostics()">Copy Diagnostics</button>';
    html += '<button class="mini-btn" onclick="exportFileDiagnostics()">Export Diagnostics</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromFileDiagnostics()">Diagnostics Task</button>';
    html += '<button class="mini-btn" onclick="pickWorkbenchUpload()">Upload</button>';
    html += '</div></div>';
    html += renderFileSafetyStrip();
    html += renderFileDiagnosticsStrip();
    html += renderFileFilters();
    html += renderRecentFilesStrip(recent);
    html += '<div class="scope-tabs">';
    var scopes = [
      ['all', 'All'],
      ['outbox', 'Outbox'],
      ['attachments', 'Attachments'],
      ['task-results', 'Task Results'],
    ];
    for (var s = 0; s < scopes.length; s++) {
      html += '<button class="scope-tab' + (filesData.scope === scopes[s][0] ? ' active' : '') + '" onclick="loadFilesData(\'' + scopes[s][0] + '\')">' + scopes[s][1] + '</button>';
    }
    html += '</div>';
    html += '<div class="panel-list files-list">';
    if (filesData.loading) {
      html += '<div class="empty">Loading files...</div>';
    } else if (files.length === 0) {
      html += '<div class="empty">No files found</div>';
    } else {
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var active = selected && selected.path === f.path;
        html += '<div class="panel-row clickable file-row' + (active ? ' selected' : '') + '" onclick="selectWorkbenchFile(\'' + jsq(f.path) + '\')">';
        html += '<span class="badge pending">' + esc(f.kind) + '</span>';
        html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(f.name) + fileSourceBadge(f) + '</div>';
        html += '<div class="panel-row-sub">' + esc([fileSourceLabel(f), fileSourceContextLabel(f), f.scope, fmtFileSize(f.size), fmtAgo(f.mtimeMs)].filter(Boolean).join(' · ')) + '</div></div>';
        html += '</div>';
      }
    }
    html += '</div></div>';

    html += '<div class="workbench-panel files-preview-panel">';
    html += renderFilePreview(selected);
    html += '</div></div>';
    $('detail-content').innerHTML = html;
  }

  function recentWorkbenchFiles(files) {
    return (files || []).slice().sort(function(a, b) {
      return Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0);
    }).slice(0, 5);
  }

  function filteredWorkbenchFiles() {
    var filters = filesData.filters || {};
    var query = String(filters.query || '').trim().toLowerCase();
    var kind = filters.kind || 'all';
    var source = filters.source || 'all';
    return (filesData.files || []).filter(function(file) {
      if (kind !== 'all' && file.kind !== kind) return false;
      if (source !== 'all') {
        var sourceKind = file.taskId ? 'task-result' : (file.sourceKind || file.scope || '');
        if (sourceKind !== source) return false;
      }
      if (!query) return true;
      var haystack = [
        file.name,
        file.path,
        file.relativePath,
        file.ext,
        file.kind,
        file.scope,
        file.sourceKind,
        file.sourceLabel,
        file.taskId,
        file.taskStatus,
        file.taskRole,
        file.taskAgent,
        file.sourceDirector,
        file.taskParentDirector,
        file.taskParentSessionId,
        file.taskParentSessionName,
        file.taskParentGroup,
        file.description,
      ].filter(Boolean).join('\n').toLowerCase();
      return haystack.indexOf(query) >= 0;
    });
  }

  function fileFilterOptions(field) {
    var seen = {};
    var options = [];
    var files = filesData.files || [];
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var value = '';
      var label = '';
      if (field === 'kind') {
        value = file.kind || 'file';
        label = value;
      } else {
        value = file.taskId ? 'task-result' : (file.sourceKind || file.scope || 'local');
        label = value === 'task-result' ? 'Task Results' : (value === 'attachment' ? 'Attachments' : (value === 'outbox' ? 'Outbox' : value));
      }
      if (!seen[value]) {
        seen[value] = true;
        options.push([value, label]);
      }
    }
    return options.sort(function(a, b) { return a[1].localeCompare(b[1]); });
  }

  function renderFileFilters() {
    var filters = filesData.filters || {};
    var kindOptions = fileFilterOptions('kind');
    var sourceOptions = fileFilterOptions('source');
    var html = '<div class="file-filters">';
    html += '<label class="file-filter-search"><span>Search</span><input value="' + esc(filters.query || '') + '" placeholder="name, path, task, session..." oninput="setFileFilter(\'query\', this.value)"></label>';
    html += '<label><span>Type</span><select onchange="setFileFilter(\'kind\', this.value)">';
    html += '<option value="all"' + ((filters.kind || 'all') === 'all' ? ' selected' : '') + '>All types</option>';
    for (var i = 0; i < kindOptions.length; i++) {
      html += '<option value="' + esc(kindOptions[i][0]) + '"' + (filters.kind === kindOptions[i][0] ? ' selected' : '') + '>' + esc(kindOptions[i][1]) + '</option>';
    }
    html += '</select></label>';
    html += '<label><span>Source</span><select onchange="setFileFilter(\'source\', this.value)">';
    html += '<option value="all"' + ((filters.source || 'all') === 'all' ? ' selected' : '') + '>All sources</option>';
    for (var j = 0; j < sourceOptions.length; j++) {
      html += '<option value="' + esc(sourceOptions[j][0]) + '"' + (filters.source === sourceOptions[j][0] ? ' selected' : '') + '>' + esc(sourceOptions[j][1]) + '</option>';
    }
    html += '</select></label>';
    html += '<button class="mini-btn" onclick="clearFileFilters()">Clear</button>';
    html += '</div>';
    return html;
  }

  function fileSourceLabel(file) {
    if (!file) return '--';
    if (file.taskId) return 'Task ' + file.taskId;
    if (file.sourceLabel) return file.sourceLabel;
    if (file.scope === 'attachments') return 'Uploaded attachment';
    if (file.scope === 'outbox') return 'Outbox artifact';
    return file.scope || 'local file';
  }

  function fileSourceBadge(file) {
    if (!file) return '';
    var text = file.taskId ? 'task' : (file.scope === 'attachments' ? 'attachment' : file.scope);
    return ' <span class="inline-chip">' + esc(text) + '</span>';
  }

  function fileSourceDirector(file) {
    if (!file) return '';
    return file.taskParentDirector || file.sourceDirector || '';
  }

  function fileSourceSessionId(file) {
    if (!file) return '';
    return file.taskParentSessionId || '';
  }

  function fileSourceSessionName(file) {
    if (!file) return '';
    return file.taskParentSessionName || file.taskParentSessionId || '';
  }

  function fileSourceContextLabel(file) {
    if (!file) return '';
    var director = fileSourceDirector(file);
    var sessionId = fileSourceSessionId(file);
    if (sessionId) return 'session ' + (file.taskParentSessionName || sessionId.slice(0, 12));
    if (director) return 'director ' + director;
    return '';
  }

  function fileDeliveryPayload(file) {
    if (!file) return null;
    var sent = sentArtifacts[file.path] || null;
    return {
      exportedAt: new Date().toISOString(),
      state: sent ? 'sent' : 'not_sent',
      file: fileMetadataPayload(file),
      delivery: sent || null,
      evidenceSource: sent && sent.audit ? 'audit-log' : (sent ? 'browser-local' : 'none'),
      activeDirector: selectedPoolLabel || 'main',
      runtimeSessionId: activeRuntimeSessionId(),
    };
  }

  function renderFileDeliveryEvidence(file) {
    var sent = file && sentArtifacts[file.path] || null;
    var html = '<div class="file-delivery-evidence">';
    html += '<div class="file-delivery-main"><span class="badge ' + (sent ? 'completed' : 'pending') + '">' + (sent ? 'sent' : 'not sent') + '</span><div>';
    html += '<strong>Delivery Evidence</strong>';
    if (sent) {
      html += '<span>' + esc(fmtTimestamp(sent.sentAt || 0)) + ' · director ' + esc(sent.director || '--') + (sent.reply != null ? ' · ' + (sent.reply ? 'reply thread' : 'new message') : '') + ' · ' + (sent.audit ? 'audit log' : 'browser local') + '</span>';
    } else {
      html += '<span>No recent send record found in browser storage or audit log.</span>';
    }
    html += '</div></div>';
    html += '<div class="panel-actions">';
    html += '<button class="chat-msg-action" onclick="copyWorkbenchFileDelivery(\'' + jsq(file.path) + '\')">Copy Delivery</button>';
    html += '<button class="chat-msg-action" onclick="exportWorkbenchFileDelivery(\'' + jsq(file.path) + '\')">Export Delivery</button>';
    html += '<button class="chat-msg-action primary" onclick="createTaskFromWorkbenchFileDelivery(\'' + jsq(file.path) + '\')">Create Task</button>';
    html += '</div></div>';
    return html;
  }

  function renderFileSafetyStrip() {
    var safety = filesData.safety || {};
    var roots = filesData.roots || {};
    var rootParts = [];
    if (roots.outbox) rootParts.push('outbox');
    if (roots.attachments) rootParts.push('attachments');
    if (roots.taskResults) rootParts.push('task results');
    var html = '<div class="file-safety-strip">';
    html += '<div><span>Allowed Roots</span><strong>' + esc(rootParts.join(' · ') || 'safe artifact roots') + '</strong></div>';
    html += '<div><span>Preview / Download</span><strong>' + esc(safety.preview || safety.download || 'safe artifacts only') + '</strong></div>';
    html += '<div><span>Send</span><strong>' + esc(safety.send || 'safe artifacts only') + '</strong></div>';
    html += '</div>';
    return html;
  }

  function renderFileDiagnosticsStrip() {
    var report = fileDiagnosticsPayload();
    var summary = report.summary || {};
    var preview = report.preview || {};
    var tracePct = summary.visibleFiles ? Math.round((Number(summary.sourceTraceable || 0) / summary.visibleFiles) * 100) : 0;
    var html = '<div class="file-diagnostics-strip">';
    html += '<div><span>Visible</span><strong>' + esc(String(summary.visibleFiles || 0)) + '/' + esc(String(summary.totalFiles || 0)) + '</strong></div>';
    html += '<div><span>Sent</span><strong>' + esc(String(summary.sent || 0)) + '/' + esc(String(summary.visibleFiles || 0)) + '</strong></div>';
    html += '<div><span>Traceable</span><strong>' + esc(String(tracePct)) + '%</strong></div>';
    html += '<div><span>Bytes</span><strong>' + esc(fmtFileSize(summary.totalVisibleBytes || 0)) + '</strong></div>';
    html += '<div><span>Preview</span><strong>' + esc(preview.error ? 'error' : (preview.path ? (preview.kind || 'loaded') : 'idle')) + '</strong></div>';
    html += '</div>';
    return html;
  }

  function renderRecentFilesStrip(recent) {
    if (!recent || recent.length === 0) return '';
    var html = '<div class="recent-file-strip">';
    for (var i = 0; i < recent.length; i++) {
      var file = recent[i];
      html += '<button class="recent-file-card" onclick="selectWorkbenchFile(\'' + jsq(file.path) + '\')">';
      html += '<span>' + esc(file.kind || 'file') + ' · ' + esc(fmtAgo(file.mtimeMs)) + '</span>';
      html += '<strong>' + esc(file.name || 'artifact') + '</strong>';
      html += '<em>' + esc(fileSourceLabel(file)) + '</em>';
      html += '</button>';
    }
    html += '</div>';
    return html;
  }

  function fileMetadataPayload(file) {
    if (!file) return null;
    return {
      name: file.name || '',
      path: file.path || '',
      relativePath: file.relativePath || '',
      scope: file.scope || '',
      kind: file.kind || '',
      ext: file.ext || '',
      size: file.size || 0,
      mtimeMs: file.mtimeMs || null,
      source: {
        label: fileSourceLabel(file),
        kind: file.sourceKind || '',
        director: fileSourceDirector(file) || '',
        sessionId: fileSourceSessionId(file) || '',
        sessionName: fileSourceSessionName(file) || '',
      },
      task: file.taskId ? {
        id: file.taskId,
        status: file.taskStatus || '',
        role: file.taskRole || '',
        agent: file.taskAgent || '',
        parentDirector: file.taskParentDirector || '',
        parentGroup: file.taskParentGroup || '',
        parentSessionId: file.taskParentSessionId || '',
        parentSessionName: file.taskParentSessionName || '',
        parentStatus: file.taskParentStatus || '',
      } : null,
      description: file.description || '',
    };
  }

  function visibleFileManifestPayload() {
    return {
      exportedAt: new Date().toISOString(),
      scope: filesData.scope || 'all',
      filters: filesData.filters || {},
      roots: filesData.roots || {},
      safety: filesData.safety || null,
      previewError: filesData.preview && filesData.preview.error || null,
      totalFiles: (filesData.files || []).length,
      visibleFiles: filteredWorkbenchFiles().map(fileMetadataPayload),
    };
  }

  function fileCountBy(files, getter) {
    var counts = {};
    for (var i = 0; i < (files || []).length; i++) {
      var key = getter(files[i]) || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  function fileDiagnosticsPayload() {
    var all = filesData.files || [];
    var visible = filteredWorkbenchFiles();
    var sent = 0;
    var sourceTraceable = 0;
    var taskLinked = 0;
    var sessionLinked = 0;
    var preview = filesData.preview || null;
    var largest = visible.slice().sort(function(a, b) { return Number(b.size || 0) - Number(a.size || 0); }).slice(0, 8);
    var newest = visible.slice().sort(function(a, b) { return Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0); }).slice(0, 8);
    for (var i = 0; i < visible.length; i++) {
      var file = visible[i];
      if (sentArtifacts[file.path]) sent++;
      if (file.taskId) taskLinked++;
      if (fileSourceSessionId(file)) sessionLinked++;
      if (file.taskId || fileSourceDirector(file) || fileSourceSessionId(file) || file.sourceKind || file.sourceLabel) sourceTraceable++;
    }
    return {
      exportedAt: new Date().toISOString(),
      scope: filesData.scope || 'all',
      filters: Object.assign({}, filesData.filters || {}),
      roots: filesData.roots || {},
      safety: filesData.safety || null,
      loading: !!filesData.loading,
      preview: preview ? {
        path: preview.path || null,
        kind: preview.kind || null,
        previewable: preview.previewable !== false,
        error: preview.error || null,
      } : null,
      summary: {
        totalFiles: all.length,
        visibleFiles: visible.length,
        sent: sent,
        notSent: Math.max(0, visible.length - sent),
        sourceTraceable: sourceTraceable,
        sourceUnlinked: Math.max(0, visible.length - sourceTraceable),
        taskLinked: taskLinked,
        sessionLinked: sessionLinked,
        totalVisibleBytes: visible.reduce(function(sum, file) { return sum + Number(file.size || 0); }, 0),
      },
      breakdown: {
        scope: fileCountBy(visible, function(file) { return file.scope || 'local'; }),
        kind: fileCountBy(visible, function(file) { return file.kind || 'file'; }),
        source: fileCountBy(visible, function(file) { return file.taskId ? 'task-result' : (file.sourceKind || file.scope || 'local'); }),
        director: fileCountBy(visible, function(file) { return fileSourceDirector(file) || 'none'; }),
      },
      newest: newest.map(fileMetadataPayload),
      largest: largest.map(fileMetadataPayload),
    };
  }

  function fmtFileSize(size) {
    if (size == null) return '--';
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / 1024 / 1024).toFixed(1) + ' MB';
  }

  function downloadDataUrl(filename, dataUrl) {
    var a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function loadFilesData(scope) {
    filesData.scope = scope || 'all';
    filesData.loading = true;
    filesData.preview = null;
    renderFilesView();
    var url = '/api/files';
    if (filesData.scope !== 'all') url += '?scope=' + encodeURIComponent(filesData.scope);
    fetch(url)
      .then(function(r) {
        if (!r.ok) return r.text().then(function(text) { throw new Error(text || 'files request failed'); });
        return r.json();
      })
      .then(function(d) {
        filesData.files = d.files || [];
        filesData.roots = d.roots || {};
        filesData.safety = d.safety || null;
        filesData.loading = false;
        if (!filesData.files.some(function(file) { return file.path === filesData.selectedPath; })) {
          filesData.selectedPath = filesData.files[0] && filesData.files[0].path || null;
        }
        renderFilesView();
        if (filesData.selectedPath) loadFilePreview(filesData.selectedPath);
      })
      .catch(function(err) {
        filesData.files = [];
        filesData.safety = null;
        filesData.loading = false;
        filesData.preview = { error: String(err) };
        renderFilesView();
      });
  }

  window.loadFilesData = loadFilesData;

  window.selectWorkbenchFile = function(path) {
    filesData.selectedPath = path;
    filesData.preview = null;
    renderFilesView();
    loadFilePreview(path);
  };

  window.setFileFilter = function(key, value) {
    filesData.filters = filesData.filters || { query: '', kind: 'all', source: 'all' };
    if (key === 'query') filesData.filters.query = String(value || '');
    if (key === 'kind') filesData.filters.kind = value || 'all';
    if (key === 'source') filesData.filters.source = value || 'all';
    var files = filteredWorkbenchFiles();
    if (!files.some(function(file) { return file.path === filesData.selectedPath; })) {
      filesData.selectedPath = files[0] && files[0].path || null;
      filesData.preview = null;
      if (filesData.selectedPath) loadFilePreview(filesData.selectedPath);
    }
    renderFilesView();
  };

  window.clearFileFilters = function() {
    filesData.filters = { query: '', kind: 'all', source: 'all' };
    if (!filteredWorkbenchFiles().some(function(file) { return file.path === filesData.selectedPath; })) {
      filesData.selectedPath = filesData.files[0] && filesData.files[0].path || null;
      filesData.preview = null;
      if (filesData.selectedPath) loadFilePreview(filesData.selectedPath);
    }
    renderFilesView();
  };

  function loadFilePreview(path) {
    fetch('/api/files/content?path=' + encodeURIComponent(path))
      .then(function(r) {
        if (!r.ok) return r.text().then(function(text) { throw new Error(text || 'file preview failed'); });
        return r.json();
      })
      .then(function(preview) {
        filesData.preview = preview;
        if (viewMode === 'files') renderFilesView();
      })
      .catch(function(err) {
        filesData.preview = { path: path, error: String(err) };
        if (viewMode === 'files') renderFilesView();
      });
  }

  function renderFilePreview(file) {
    if (!file) {
      if (filesData.preview && filesData.preview.error) {
        return '<div class="panel-title"><span>Preview</span></div><div class="td-error">' + esc(filesData.preview.error) + '</div>';
      }
      return '<div class="panel-title"><span>Preview</span></div><div class="empty">Select a file</div>';
    }
    var preview = filesData.preview;
    var html = '<div class="panel-title"><span>Preview</span><span class="muted">' + esc(file.scope) + '</span></div>';
    html += '<div class="kv-grid" style="margin-bottom:12px">';
    html += '<div class="kv-card"><div class="kv-label">Name</div><div class="kv-value">' + esc(file.name) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Source</div><div class="kv-value">' + esc(fileSourceLabel(file)) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Size</div><div class="kv-value">' + fmtFileSize(file.size) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Modified</div><div class="kv-value">' + fmtAgo(file.mtimeMs) + '</div></div>';
    if (file.taskId) html += '<div class="kv-card"><div class="kv-label">Task</div><div class="kv-value">' + esc(file.taskId) + '</div></div>';
    if (file.taskStatus) html += '<div class="kv-card"><div class="kv-label">Task Status</div><div class="kv-value">' + esc(file.taskStatus) + '</div></div>';
    if (file.sourceDirector) html += '<div class="kv-card"><div class="kv-label">Director</div><div class="kv-value">' + esc(file.sourceDirector) + '</div></div>';
    if (file.taskParentDirector) html += '<div class="kv-card"><div class="kv-label">Parent Director</div><div class="kv-value">' + esc(file.taskParentDirector) + '</div></div>';
    if (file.taskParentGroup) html += '<div class="kv-card"><div class="kv-label">Parent Group</div><div class="kv-value">' + esc(file.taskParentGroup) + '</div></div>';
    if (file.taskParentSessionId) html += '<div class="kv-card"><div class="kv-label">Source Session</div><div class="kv-value">' + esc(file.taskParentSessionName || file.taskParentSessionId) + '</div></div>';
    if (file.taskParentStatus) html += '<div class="kv-card"><div class="kv-label">Parent Status</div><div class="kv-value">' + esc(file.taskParentStatus) + '</div></div>';
    if (file.taskRole) html += '<div class="kv-card"><div class="kv-label">Role</div><div class="kv-value">' + esc(file.taskRole) + '</div></div>';
    html += '</div>';
    if (file.description) html += '<div class="file-source-note">' + esc(file.description) + '</div>';
    html += '<div class="file-path mono">' + esc(file.path) + '</div>';
    html += renderFileDeliveryEvidence(file);
    html += '<div class="panel-actions" style="margin:12px 0">';
    html += '<button class="mini-btn" onclick="copyText(\'' + jsq(file.path) + '\')">Copy Path</button>';
    html += '<button class="mini-btn" onclick="copyWorkbenchFileMetadata(\'' + jsq(file.path) + '\')">Copy Metadata</button>';
    html += '<button class="mini-btn" onclick="exportWorkbenchFileMetadata(\'' + jsq(file.path) + '\')">Export Metadata</button>';
    html += '<button class="mini-btn" onclick="copyWorkbenchFileBundle(\'' + jsq(file.path) + '\')">Copy Bundle</button>';
    html += '<button class="mini-btn" onclick="exportWorkbenchFileBundle(\'' + jsq(file.path) + '\')">Export Bundle</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromWorkbenchFile(\'' + jsq(file.path) + '\')">Create Task</button>';
    if (preview && preview.path === file.path && (preview.content || preview.dataUrl)) {
      html += '<button class="mini-btn" onclick="copyWorkbenchFilePreview(\'' + jsq(file.path) + '\')">Copy Preview</button>';
      html += '<button class="mini-btn" onclick="exportWorkbenchFilePreview(\'' + jsq(file.path) + '\')">Export Preview</button>';
    }
    html += '<button class="mini-btn" onclick="revealLocalPath(\'' + jsq(file.path) + '\')">Reveal</button>';
    html += '<button class="mini-btn" onclick="sendWorkbenchFile(\'' + jsq(file.path) + '\')">Send Attachment</button>';
    html += '<button class="mini-btn" onclick="downloadWorkbenchFile(\'' + jsq(file.path) + '\',\'' + jsq(file.name) + '\')">Download</button>';
    if (file.taskId) html += '<button class="mini-btn" onclick="selectTask(\'' + jsq(file.taskId) + '\')">Open Task</button>';
    if (fileSourceDirector(file) || fileSourceSessionId(file)) {
      html += '<button class="mini-btn" onclick="openFileSourceContext(\'' + jsq(file.path) + '\')">' + (fileSourceSessionId(file) ? 'Open Source Session' : 'Open Source Director') + '</button>';
    }
    html += '</div>';

    if (!preview || preview.path !== file.path) {
      html += '<div class="td-result-running"><div class="spinner"></div><span>Loading preview...</span></div>';
    } else if (preview.error) {
      html += '<div class="td-error">' + esc(preview.error) + '</div>';
    } else if (preview.previewable === false) {
      html += '<div class="empty">' + esc(preview.error || 'Preview is not available for this file type.') + '</div>';
    } else if (preview.kind === 'image' && preview.dataUrl) {
      html += '<div class="image-preview-wrap"><img class="image-preview" src="' + esc(preview.dataUrl) + '" alt="' + esc(file.name) + '"></div>';
    } else if (preview.kind === 'markdown') {
      html += '<div class="td-output"><div class="md-content">' + renderMd(preview.content || '') + '</div></div>';
    } else {
      html += '<pre class="prompt-preview">' + esc(preview.content || '') + '</pre>';
    }
    return html;
  }

  window.copyVisibleFileManifest = function() {
    var files = filteredWorkbenchFiles();
    if (!files.length) {
      showToast('No visible files to copy', false);
      return;
    }
    copyText(JSON.stringify(visibleFileManifestPayload(), null, 2));
  };

  window.exportVisibleFileManifest = function() {
    var files = filteredWorkbenchFiles();
    if (!files.length) {
      showToast('No visible files to export', false);
      return;
    }
    downloadTextFile('persona-file-manifest-' + Date.now() + '.json', JSON.stringify(visibleFileManifestPayload(), null, 2));
    showToast('File manifest exported', true);
  };

  window.copyFileDiagnostics = function() {
    copyText(JSON.stringify(fileDiagnosticsPayload(), null, 2));
  };

  window.exportFileDiagnostics = function() {
    downloadTextFile('persona-file-diagnostics-' + Date.now() + '.json', JSON.stringify(fileDiagnosticsPayload(), null, 2));
    showToast('File diagnostics exported', true);
  };

  function fileReportTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench files report as task context.',
      '',
      'Operator intent:',
      '- Review visible artifacts, filters, source traceability, delivery state, preview health, safety roots, and selected file context before acting.',
      '- Use the manifest, diagnostics, selected file bundle, runtime snapshot, and approval context to decide whether artifacts need cleanup, delivery follow-up, source repair, or handoff work.',
      '- If files are missing source links, unsent, unsafe to send, too large, stale, or previewing with errors, propose or implement a scoped fix.',
      '- Do not delete files, send attachments, or alter task/session state unless the task prompt is explicitly edited.',
      '',
      'Files report handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function fileReportTaskContext(type) {
    var selected = (filesData.files || []).find(function(file) { return file.path === filesData.selectedPath; }) || filteredWorkbenchFiles()[0] || null;
    return {
      exportedAt: new Date().toISOString(),
      type: type || 'fileReport',
      manifest: visibleFileManifestPayload(),
      diagnostics: fileDiagnosticsPayload(),
      selectedFile: selected ? fileBundlePayload(selected) : null,
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
  }

  window.createTaskFromVisibleFileManifest = function() {
    var manifest = visibleFileManifestPayload();
    if (!manifest.visibleFiles.length) {
      showToast('No visible files to use', false);
      return;
    }
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: activeDirectorLabel() || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review visible file manifest: ' + String(manifest.visibleFiles.length) + '/' + String(manifest.totalFiles || 0) + ' file(s)',
      prompt: fileReportTaskPromptPayload(fileReportTaskContext('fileManifest')),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('File manifest loaded into task form', true);
  };

  window.createTaskFromFileDiagnostics = function() {
    var diagnostics = fileDiagnosticsPayload();
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: activeDirectorLabel() || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review file diagnostics: ' + String(diagnostics.summary.visibleFiles || 0) + '/' + String(diagnostics.summary.totalFiles || 0) + ' visible',
      prompt: fileReportTaskPromptPayload(fileReportTaskContext('fileDiagnostics')),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('File diagnostics loaded into task form', true);
  };

  window.copyWorkbenchFileMetadata = function(path) {
    var file = (filesData.files || []).find(function(item) { return item.path === path; });
    if (!file) {
      showToast('File metadata not found', false);
      return;
    }
    copyText(JSON.stringify(fileMetadataPayload(file), null, 2));
  };

  window.exportWorkbenchFileMetadata = function(path) {
    var file = (filesData.files || []).find(function(item) { return item.path === path; });
    if (!file) {
      showToast('File metadata not found', false);
      return;
    }
    downloadTextFile('persona-file-metadata-' + safeAssetName(file.name || file.path, 'file') + '-' + Date.now() + '.json', JSON.stringify(fileMetadataPayload(file), null, 2));
    showToast('File metadata exported', true);
  };

  window.copyWorkbenchFileDelivery = function(path) {
    var file = (filesData.files || []).find(function(item) { return item.path === path; });
    if (!file) {
      showToast('File delivery record not found', false);
      return;
    }
    copyText(JSON.stringify(fileDeliveryPayload(file), null, 2));
  };

  window.exportWorkbenchFileDelivery = function(path) {
    var file = (filesData.files || []).find(function(item) { return item.path === path; });
    if (!file) {
      showToast('File delivery record not found', false);
      return;
    }
    downloadTextFile('persona-file-delivery-' + safeAssetName(file.name || file.path, 'file') + '-' + Date.now() + '.json', JSON.stringify(fileDeliveryPayload(file), null, 2));
    showToast('File delivery evidence exported', true);
  };

  function fileDeliveryTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench file-delivery handoff as task context.',
      '',
      'Operator intent:',
      '- Review this artifact delivery state before sending, resending, reporting, or changing any related task/session state.',
      '- Use delivery evidence, metadata, source task/session, selected file bundle, file diagnostics, runtime snapshot, and approval context before acting.',
      '- If delivery evidence is missing, stale, browser-local only, pointed at the wrong Director/session, or inconsistent with operator expectations, propose or implement a scoped follow-up.',
      '- Do not send attachments, delete files, or alter task/session state unless the task prompt is explicitly edited.',
      '',
      'File delivery handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromWorkbenchFileDelivery = function(path) {
    var file = (filesData.files || []).find(function(item) { return item.path === path; });
    if (!file) {
      showToast('File delivery record not found', false);
      return;
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'fileDeliveryEvidence',
      delivery: fileDeliveryPayload(file),
      fileBundle: fileBundlePayload(file),
      diagnostics: fileDiagnosticsPayload(),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: fileSourceDirector(file) || activeDirectorLabel() || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review file delivery: ' + (file.name || file.path || 'artifact'),
      prompt: fileDeliveryTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('File delivery loaded into task form', true);
  };

  function fileBundlePayload(file) {
    if (!file) return null;
    var preview = filesData.preview && filesData.preview.path === file.path ? filesData.preview : null;
    var sent = sentArtifacts[file.path] || null;
    return {
      exportedAt: new Date().toISOString(),
      metadata: fileMetadataPayload(file),
      preview: preview ? {
        loaded: true,
        kind: preview.kind || '',
        previewable: preview.previewable !== false,
        error: preview.error || '',
        contentPreview: preview.content ? shortText(preview.content, 2400) : '',
        contentLength: preview.content ? String(preview.content).length : 0,
        hasDataUrl: !!preview.dataUrl,
        mime: preview.mime || '',
      } : {
        loaded: false,
      },
      delivery: fileDeliveryPayload(file),
      safety: filesData.safety || null,
      roots: filesData.roots || {},
      sourceActions: {
        canOpenTask: !!file.taskId,
        canOpenSourceContext: !!(fileSourceDirector(file) || fileSourceSessionId(file)),
        sourceDirector: fileSourceDirector(file) || '',
        sourceSessionId: fileSourceSessionId(file) || '',
        sourceSessionName: fileSourceSessionName(file) || '',
      },
    };
  }

  function fileTaskPromptPayload(file) {
    var payload = fileBundlePayload(file);
    return [
      'Use the following Workbench file handoff as task context.',
      '',
      'Operator intent:',
      '- Continue work from this local artifact or inspect it for the next action.',
      '- Use the metadata, source task/session, delivery evidence, and preview summary before deciding what to do.',
      '- If the prompt is not further edited, summarize the artifact and propose concrete next steps.',
      '',
      'File handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.copyWorkbenchFileBundle = function(path) {
    var file = (filesData.files || []).find(function(item) { return item.path === path; });
    if (!file) {
      showToast('File bundle not found', false);
      return;
    }
    copyText(JSON.stringify(fileBundlePayload(file), null, 2));
  };

  window.exportWorkbenchFileBundle = function(path) {
    var file = (filesData.files || []).find(function(item) { return item.path === path; });
    if (!file) {
      showToast('File bundle not found', false);
      return;
    }
    downloadTextFile('persona-file-bundle-' + safeAssetName(file.name || file.path, 'file') + '-' + Date.now() + '.json', JSON.stringify(fileBundlePayload(file), null, 2));
    showToast('File bundle exported', true);
  };

  window.createTaskFromWorkbenchFile = async function(path) {
    var files = filesData.files || [];
    var file = files.find(function(item) { return item.path === path; }) || files.find(function(item) { return item.path === filesData.selectedPath; }) || null;
    if (!file) {
      showToast('File is not loaded', false);
      return;
    }
    if (!filesData.preview || filesData.preview.path !== file.path) {
      try {
        var res = await fetch('/api/files/content?path=' + encodeURIComponent(file.path));
        if (!res.ok) {
          var text = await res.text().catch(function() { return ''; });
          throw new Error(text || 'file preview failed');
        }
        filesData.preview = await res.json();
      } catch (err) {
        filesData.preview = { path: file.path, error: String(err) };
        showToast('Creating file task without preview: ' + err.message, false);
      }
    }
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: fileSourceDirector(file) || activeDirectorLabel() || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Continue from artifact: ' + (file.name || file.path || 'file'),
      prompt: fileTaskPromptPayload(file),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('File handoff loaded into task form', true);
  };

  window.copyWorkbenchFilePreview = function(path) {
    var preview = filesData.preview;
    if (!preview || preview.path !== path || (!preview.content && !preview.dataUrl)) {
      showToast('No preview loaded', false);
      return;
    }
    copyText(preview.content || preview.dataUrl || '');
  };

  window.exportWorkbenchFilePreview = function(path) {
    var file = (filesData.files || []).find(function(item) { return item.path === path; }) || {};
    var preview = filesData.preview;
    if (!preview || preview.path !== path || (!preview.content && !preview.dataUrl)) {
      showToast('No preview loaded', false);
      return;
    }
    if (preview.dataUrl) {
      downloadDataUrl('persona-file-preview-' + safeAssetName(file.name || path, 'preview') + '-' + Date.now() + (file.ext || ''), preview.dataUrl);
      showToast('Image preview exported', true);
      return;
    }
    var ext = preview.kind === 'markdown' ? '.md' : '.txt';
    downloadTextFile('persona-file-preview-' + safeAssetName(file.name || path, 'preview') + '-' + Date.now() + ext, preview.content || '');
    showToast('File preview exported', true);
  };

  window.downloadPreviewFile = function(filename) {
    if (!filesData.preview || !filesData.preview.dataUrl) {
      showToast('No downloadable preview loaded', false);
      return;
    }
    downloadDataUrl(filename, filesData.preview.dataUrl);
  };

  window.downloadWorkbenchFile = async function(path, filename) {
    try {
      var res = await fetch('/api/files/download?path=' + encodeURIComponent(path));
      if (!res.ok) {
        var text = await res.text().catch(function() { return ''; });
        throw new Error(text || 'download failed');
      }
      var blob = await res.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename || (String(path || '').split('/').pop() || 'download');
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
      showToast('Download started', true);
    } catch (err) {
      showToast('Download failed: ' + err.message, false);
    }
  };

  window.openFileSourceContext = function(path) {
    var files = filesData.files || [];
    var file = files.find(function(item) { return item.path === path; }) || files.find(function(item) { return item.path === filesData.selectedPath; }) || null;
    if (!file) {
      showToast('File source is not loaded', false);
      return;
    }
    var director = fileSourceDirector(file) || 'main';
    var sessionId = fileSourceSessionId(file);
    var sessionName = fileSourceSessionName(file);
    if (sessionId) {
      if (director && director !== 'main') {
        selectSubSession(director, sessionId, sessionName || sessionId.slice(0, 16));
      } else {
        selectSession(sessionId);
      }
      return;
    }
    if (director && director !== 'main') {
      selectPoolDirector(director, file.taskParentGroup || director);
    } else {
      selectSession(null);
    }
  };

  window.copyText = function(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        showToast('Copied', true);
      }).catch(function(err) {
        showToast('Copy failed: ' + err.message, false);
      });
    } else {
      showToast('Clipboard not available', false);
    }
  };

  window.copyCachedText = function(id) {
    window.copyText(markdownCopyCache[id] || '');
  };

  function queueRevealPath(target, body) {
    queueDangerApproval({
      title: 'Reveal local path',
      target: target,
      detail: 'Open this file location in the local file manager.',
      severity: 'medium',
      payload: body,
    }, async function() {
      try {
        var res = await fetch('/api/open-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        var payload = await res.json().catch(function() { return {}; });
        if (!res.ok || payload.error) throw new Error(payload.error || 'reveal failed');
        showToast('Path revealed', true);
      } catch (err) {
        showToast('Reveal failed: ' + err.message, false);
      }
    });
  }

  window.revealLocalPath = function(path) {
    queueRevealPath(path, { path: path });
  };

  window.revealPersonaDocPath = function(path) {
    queueRevealPath(path, { persona_doc: path });
  };

  function downloadTextFile(filename, content) {
    var blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  }

  window.sendWorkbenchFile = async function(path) {
    var targetChannel = (viewMode === 'session' || (selectedPoolLabel && poolDirectorByLabel(selectedPoolLabel) && poolDirectorByLabel(selectedPoolLabel).routingKey && poolDirectorByLabel(selectedPoolLabel).routingKey.indexOf('web-') === 0)) ? 'web' : 'messaging';
    queueDangerApproval({
      title: 'Send attachment',
      target: selectedPoolLabel || 'main',
      detail: path,
      severity: 'medium',
      payload: { path: path, source_director: selectedPoolLabel || 'main', target_channel: targetChannel },
    }, async function() {
    try {
      var res = await fetch('/api/send-attachment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path, source_director: selectedPoolLabel || 'main', target_channel: targetChannel }),
      });
      var body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error || 'send failed');
      var file = (filesData.files || []).find(function(item) { return item.path === path; }) || null;
      sentArtifacts[path] = Object.assign({
        sentAt: Date.now(),
        director: selectedPoolLabel || 'main',
        name: file && file.name || String(path || '').split('/').pop() || '',
        size: file && file.size || null,
        source: file ? fileMetadataPayload(file).source : null,
      }, body.delivery || {});
      saveSentArtifacts();
      showToast('Attachment sent', true);
      if (viewMode === 'task') renderTaskResultPanel();
      if (viewMode === 'files') renderFilesView();
    } catch (err) {
      showToast('Send failed: ' + err.message, false);
      throw err;
    }
    });
  };

  function requestWsEventsRender() {
    if (viewMode !== 'observability') return;
    var now = Date.now();
    var hasSelection = !!wsEventsData.selectedId;
    var minInterval = hasSelection ? 2500 : 350;
    if (!wsEventsData.lastRenderAt || now - wsEventsData.lastRenderAt >= minInterval) {
      if (wsEventsData.renderTimer) {
        clearTimeout(wsEventsData.renderTimer);
        wsEventsData.renderTimer = 0;
      }
      wsEventsData.lastRenderAt = now;
      renderObservabilityView();
      return;
    }
    if (wsEventsData.renderTimer) return;
    wsEventsData.renderTimer = setTimeout(function() {
      wsEventsData.renderTimer = 0;
      wsEventsData.lastRenderAt = Date.now();
      if (viewMode === 'observability') renderObservabilityView();
    }, minInterval - (now - wsEventsData.lastRenderAt));
  }

  function renderObservabilityView() {
    wsEventsData.lastRenderAt = Date.now();
    var allSources = logsData.sources || [];
    var sources = visibleLogSources();
    var selected = sources.find(function(source) { return source.id === logsData.selectedId; }) || sources[0] || null;
    if (selected && logsData.selectedId !== selected.id) logsData.selectedId = selected.id;

    var metrics = data && data.metrics || {};
    var today = metrics.today || {};
    var html = '<div class="logs-layout">';
    html += '<div class="logs-side-stack">';
    html += '<div class="workbench-panel logs-source-panel">';
    html += '<div class="panel-title"><span>Log Sources</span><div class="panel-actions">';
    html += '<button class="mini-btn" onclick="loadLogSources()">Refresh</button>';
    if (allSources.length > 0) {
      html += '<button class="mini-btn" onclick="copyLogSourceManifest()">Copy Manifest</button>';
      html += '<button class="mini-btn" onclick="exportLogSourceManifest()">Export Manifest</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromLogSourceManifest()">Create Task</button>';
    }
    html += '</div></div>';
    html += renderLogSourceSummary(allSources);
    html += renderLogSourceGroupTabs();
    html += '<div class="kv-grid" style="margin-bottom:10px">';
    html += '<div class="kv-card"><div class="kv-label">Messages</div><div class="kv-value">' + (today.messagesProcessed || 0) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Avg Response</div><div class="kv-value">' + (today.avgResponseSec != null ? today.avgResponseSec.toFixed(1) + 's' : '0s') + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Cost</div><div class="kv-value">' + fmtCost(today.totalCostUsd || 0) + '</div></div>';
    html += '</div>';
    html += '<div class="panel-list logs-source-list">';
    if (logsData.loading) {
      html += '<div class="empty">Loading logs...</div>';
    } else if (allSources.length === 0) {
      html += '<div class="empty">No log sources</div>';
    } else if (sources.length === 0) {
      html += '<div class="empty">No log sources in this group</div>';
    } else {
      for (var i = 0; i < sources.length; i++) {
        var source = sources[i];
        var active = selected && selected.id === source.id;
        html += '<div class="panel-row clickable log-source-row' + (active ? ' selected' : '') + '" onclick="selectLogSource(\'' + jsq(source.id) + '\')">';
        html += '<span class="badge pending">' + esc(logSourceCategoryLabel(logSourceCategory(source))) + '</span>';
        html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(source.label) + '</div>';
        html += '<div class="panel-row-sub">' + esc(source.group || 'shell') + ' · ' + fmtFileSize(source.size) + ' · ' + fmtAgo(source.mtimeMs) + '</div></div>';
        html += '<div class="panel-actions"><button class="chat-msg-action" onclick="event.stopPropagation();createTaskFromLogSource(\'' + jsq(source.id) + '\')">Create Task</button></div></div>';
      }
    }
    html += '</div></div>';
    html += renderApiExplorerPanel();
    html += renderWsEventViewerPanel();
    html += '</div>';

    html += '<div class="logs-main-stack">';
    html += renderGlobalSearchPanel();
    html += '<div class="workbench-panel logs-tail-panel">';
    html += renderLogTailPanel(selected);
    html += '</div>';
    html += renderParseLogPanel();
    html += renderDiagnosticsPanel();
    html += renderRuntimeEventHistoryPanel();
    html += renderDebugToolsPanel();
    html += renderSnapshotPanel();
    html += '</div></div>';
    $('detail-content').innerHTML = html;
  }

  function logSourceCategory(source) {
    var id = String(source && (source.id || source.label || '') || '').toLowerCase();
    if (/^task-|\/task-/.test(id) || /\.stdout\.log$/.test(id) || /\.stderr\.log$/.test(id)) return 'task';
    if (/queue/.test(id)) return 'queue';
    if (/feishu|lark/.test(id)) return 'feishu';
    if (/(^|\/)(input|output)-\d+\.log$/.test(id) || /director/.test(id)) return 'director';
    return 'shell';
  }

  function logSourceCategoryLabel(group) {
    var labels = { all: 'All', director: 'Director', task: 'Task', queue: 'Queue', feishu: 'Feishu', shell: 'Shell' };
    return labels[group] || group || 'Log';
  }

  function logSourceGroupDefinitions() {
    return [
      ['all', 'All'],
      ['director', 'Director'],
      ['task', 'Task'],
      ['queue', 'Queue'],
      ['feishu', 'Feishu'],
      ['shell', 'Shell'],
    ];
  }

  function logSourceCounts() {
    var counts = { all: (logsData.sources || []).length, director: 0, task: 0, queue: 0, feishu: 0, shell: 0 };
    var sources = logsData.sources || [];
    for (var i = 0; i < sources.length; i++) {
      var category = logSourceCategory(sources[i]);
      counts[category] = (counts[category] || 0) + 1;
    }
    return counts;
  }

  function visibleLogSources() {
    var selectedGroup = logsData.group || 'all';
    var sources = logsData.sources || [];
    if (selectedGroup === 'all') return sources;
    return sources.filter(function(source) { return logSourceCategory(source) === selectedGroup; });
  }

  function renderLogSourceGroupTabs() {
    var counts = logSourceCounts();
    var groups = logSourceGroupDefinitions();
    var html = '<div class="scope-tabs log-source-tabs">';
    for (var i = 0; i < groups.length; i++) {
      var key = groups[i][0];
      var label = groups[i][1];
      html += '<button class="scope-tab' + ((logsData.group || 'all') === key ? ' active' : '') + '" onclick="setLogSourceGroup(\'' + key + '\')">' + esc(label) + ' <span>' + (counts[key] || 0) + '</span></button>';
    }
    html += '</div>';
    return html;
  }

  function renderLogSourceSummary(sources) {
    var counts = logSourceCounts();
    var recent = (sources || []).slice().sort(function(a, b) { return Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0); })[0];
    var html = '<div class="log-source-summary">';
    html += '<div><span>Director</span><strong>' + esc(String(counts.director || 0)) + '</strong></div>';
    html += '<div><span>Task</span><strong>' + esc(String(counts.task || 0)) + '</strong></div>';
    html += '<div><span>Queue</span><strong>' + esc(String(counts.queue || 0)) + '</strong></div>';
    html += '<div><span>Newest</span><strong>' + esc(recent ? fmtAgo(recent.mtimeMs) : '--') + '</strong></div>';
    html += '</div>';
    return html;
  }

  function logSourceManifestPayload() {
    var sources = logsData.sources || [];
    var visible = visibleLogSources();
    var counts = logSourceCounts();
    return {
      exportedAt: new Date().toISOString(),
      selectedId: logsData.selectedId || null,
      group: logsData.group || 'all',
      counts: counts,
      total: sources.length,
      visibleCount: visible.length,
      filters: {
        group: logsData.group || 'all',
        tailQuery: logsData.query || '',
        tailLevel: logsData.level || 'all',
        tailBytes: Number(logsData.bytes || 196608),
      },
      newest: sources.slice().sort(function(a, b) { return Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0); })[0] || null,
      sources: sources.map(function(source) {
        return {
          id: source.id,
          label: source.label,
          group: source.group || 'shell',
          category: logSourceCategory(source),
          path: source.path,
          size: source.size,
          mtimeMs: source.mtimeMs,
        };
      }),
      visibleSources: visible.map(function(source) {
        return {
          id: source.id,
          label: source.label,
          group: source.group || 'shell',
          category: logSourceCategory(source),
          path: source.path,
          size: source.size,
          mtimeMs: source.mtimeMs,
        };
      }),
    };
  }

  function logSourceById(id) {
    var sources = logsData.sources || [];
    for (var i = 0; i < sources.length; i++) {
      if (sources[i] && sources[i].id === id) return sources[i];
    }
    return null;
  }

  function logSourcePayload(id) {
    var source = logSourceById(id);
    var tail = logsData.tail && logsData.tail.id === id ? logsData.tail : null;
    return {
      exportedAt: new Date().toISOString(),
      source: source ? {
        id: source.id,
        label: source.label,
        group: source.group || 'shell',
        category: logSourceCategory(source),
        path: source.path,
        size: source.size,
        mtimeMs: source.mtimeMs,
      } : null,
      selected: logsData.selectedId === id,
      manifest: logSourceManifestPayload(),
      currentTail: tail ? {
        id: tail.id || null,
        path: tail.path || null,
        size: tail.size || null,
        mtimeMs: tail.mtimeMs || null,
        error: tail.error || null,
        preview: tail.content ? String(tail.content).split('\n').slice(-80).join('\n') : '',
      } : null,
    };
  }

  function logSourceTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench log source handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate or continue from the selected log source or source manifest evidence.',
      '- Review source category, path, size, freshness, active group filters, selected source, and any current tail preview.',
      '- If a log source is missing, stale, oversized, noisy, or tied to a failing task/runtime area, identify the likely cause and propose or implement a scoped fix.',
      '- Preserve the current log source and filter context unless the task prompt is edited.',
      '',
      'Log source handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function createTaskFromLogSourcePayload(payload, description) {
    if (!payload) {
      showToast('Log source evidence not found', false);
      return;
    }
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: shortText(description || 'Investigate log sources', 120),
      prompt: logSourceTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Log source handoff loaded into task form', true);
  }

  window.copyLogSourceManifest = function() {
    var payload = logSourceManifestPayload();
    if (!payload.total) {
      showToast('No log sources to copy', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportLogSourceManifest = function() {
    var payload = logSourceManifestPayload();
    if (!payload.total) {
      showToast('No log sources to export', false);
      return;
    }
    downloadTextFile('persona-log-source-manifest-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Log source manifest exported', true);
  };

  window.createTaskFromLogSourceManifest = function() {
    var payload = logSourceManifestPayload();
    if (!payload.total) {
      showToast('No log sources to turn into a task', false);
      return;
    }
    createTaskFromLogSourcePayload({
      type: 'logSourceManifest',
      manifest: payload,
      diagnostics: diagnosticsData.summary ? {
        window: diagnosticsData.summary.window || null,
        health: diagnosticsData.summary.health || null,
        errors: (diagnosticsData.summary.errors || []).slice(0, 8),
      } : null,
      runtime: {
        tasks: data && data.tasks && data.tasks.summary || null,
        directors: runtimeDirectorSnapshots(data && data.system || {}, data && data.pool || [], data && data.activity || {}),
      },
    }, 'Investigate log sources: ' + String(payload.visibleCount || 0) + ' visible / ' + String(payload.total || 0) + ' total');
  };

  window.createTaskFromLogSource = function(id) {
    var payload = logSourcePayload(id);
    if (!payload.source) {
      showToast('Log source not found', false);
      return;
    }
    createTaskFromLogSourcePayload({
      type: 'logSource',
      item: payload,
      diagnostics: diagnosticsData.summary ? {
        window: diagnosticsData.summary.window || null,
        health: diagnosticsData.summary.health || null,
        errors: (diagnosticsData.summary.errors || []).slice(0, 8),
      } : null,
      runtime: {
        tasks: data && data.tasks && data.tasks.summary || null,
        directors: runtimeDirectorSnapshots(data && data.system || {}, data && data.pool || [], data && data.activity || {}),
      },
    }, 'Investigate log source: ' + (payload.source.label || payload.source.id || 'log'));
  };

  window.setLogSourceGroup = function(group) {
    logsData.group = group || 'all';
    var sources = visibleLogSources();
    if (!sources.some(function(source) { return source.id === logsData.selectedId; })) {
      logsData.selectedId = sources[0] && sources[0].id || null;
      logsData.tail = null;
      if (logsData.selectedId) loadLogTail(logsData.selectedId);
    }
    renderObservabilityView();
  };

  function loadLogSources() {
    logsData.loading = true;
    logsData.tail = null;
    if (viewMode === 'settings') renderSettingsView();
    else renderObservabilityView();
    fetch('/api/logs/sources')
      .then(function(r) {
        if (!r.ok) return r.text().then(function(text) { throw new Error(text || 'log sources request failed'); });
        return r.json();
      })
      .then(function(d) {
        logsData.sources = d.sources || [];
        logsData.loading = false;
        if (!logsData.sources.some(function(source) { return source.id === logsData.selectedId; })) {
          logsData.selectedId = logsData.sources[0] && logsData.sources[0].id || null;
        }
        renderObservabilityView();
        if (logsData.selectedId) loadLogTail(logsData.selectedId);
      })
      .catch(function(err) {
        logsData.sources = [];
        logsData.loading = false;
        logsData.tail = { error: String(err) };
        renderObservabilityView();
      });
  }

  window.loadLogSources = loadLogSources;

  function renderGlobalSearchPanel() {
    var query = globalSearchData.query || '';
    var result = globalSearchData.result;
    var html = '<div class="workbench-panel wide global-search-panel"><div class="panel-title"><span>Global Search</span><div class="panel-actions">';
    html += '<button class="mini-btn" onclick="runGlobalSearch()">' + (globalSearchData.loading ? 'Searching...' : 'Search') + '</button>';
    if (globalSearchData.result || globalSearchData.error) {
      html += '<button class="mini-btn" onclick="copyGlobalSearchReport()">Copy Report</button>';
      html += '<button class="mini-btn" onclick="exportGlobalSearchReport()">Export Report</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromGlobalSearchReport()">Create Task</button>';
    }
    if (query) html += '<button class="mini-btn" onclick="clearGlobalSearch()">Clear</button>';
    html += '</div></div>';
    html += '<div class="global-search-input-row"><input value="' + esc(query) + '" placeholder="Search sessions, tasks, and logs" oninput="setGlobalSearchQuery(this.value)" onkeydown="if(event.key===\'Enter\')runGlobalSearch()">';
    html += '<span class="muted mono">' + (result && result.scanned ? ('scanned ' + result.scanned.messages + ' msg · ' + result.scanned.tasks + ' tasks · ' + result.scanned.logs + ' log lines') : 'recent local data') + '</span></div>';
    if (globalSearchData.error) {
      html += '<div class="td-error compact">' + esc(globalSearchData.error) + '</div>';
    } else if (globalSearchData.loading) {
      html += '<div class="td-result-running"><div class="spinner"></div><span>Searching local workbench data...</span></div>';
    } else if (result && result.results && result.results.length === 0) {
      html += '<div class="empty compact">No results found.</div>';
    } else if (result && result.results) {
      html += '<div class="global-search-results">';
      for (var i = 0; i < result.results.length; i++) {
        html += renderGlobalSearchResult(result.results[i], i);
      }
      html += '</div>';
    } else {
      html += '<div class="empty compact">Search recent conversation messages, task records, and safe log tails.</div>';
    }
    html += '</div>';
    return html;
  }

  function globalSearchBadgeClass(kind, status) {
    if (kind === 'task') {
      if (status === 'completed') return 'completed';
      if (status === 'failed') return 'failed';
      if (status === 'running') return 'running';
      return 'pending';
    }
    if (kind === 'message') return 'ok';
    if (kind === 'log') return status === 'error' ? 'failed' : 'pending';
    return 'pending';
  }

  function globalSearchOpenLabel(item) {
    if (!item) return 'Open';
    if (item.kind === 'message') return 'Open Session';
    if (item.kind === 'task') return 'Open Task';
    if (item.kind === 'log') return 'Open Log';
    return 'Open';
  }

  function renderGlobalSearchResult(item, index) {
    var selected = globalSearchData.selectedIndex === index;
    var html = '<div class="global-search-result clickable' + (selected ? ' selected' : '') + '" onclick="openGlobalSearchResult(' + index + ')">';
    html += '<span class="badge ' + globalSearchBadgeClass(item.kind, item.status) + '">' + esc(item.kind || 'hit') + '</span>';
    html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(item.title || 'Result') + '</div>';
    html += '<div class="panel-row-sub">' + esc([item.director, item.sessionId, item.taskId, item.logPath, item.line ? 'line ' + item.line : '', item.timestamp ? fmtAgo(item.timestamp) : ''].filter(Boolean).join(' · ')) + '</div>';
    html += '<div class="global-search-preview">' + highlightPlainText(item.preview || '', globalSearchData.query || '') + '</div></div>';
    html += '<div class="panel-actions">';
    html += '<button class="chat-msg-action" onclick="event.stopPropagation();openGlobalSearchResult(' + index + ')">' + esc(globalSearchOpenLabel(item)) + '</button>';
    html += '<button class="chat-msg-action" onclick="event.stopPropagation();copyText(\'' + jsq([item.title, item.preview].filter(Boolean).join('\\n')) + '\')">Copy</button>';
    html += '<button class="chat-msg-action" onclick="event.stopPropagation();copyGlobalSearchResultJson(' + index + ')">Copy JSON</button>';
    html += '<button class="chat-msg-action" onclick="event.stopPropagation();exportGlobalSearchResultJson(' + index + ')">Export</button>';
    html += '<button class="chat-msg-action" onclick="event.stopPropagation();createTaskFromGlobalSearchResult(' + index + ')">Create Task</button>';
    html += '</div></div>';
    return html;
  }

  window.setGlobalSearchQuery = function(value) {
    globalSearchData.query = String(value || '');
  };

  function globalSearchReport() {
    return {
      exportedAt: new Date().toISOString(),
      query: globalSearchData.query || '',
      loading: !!globalSearchData.loading,
      error: globalSearchData.error || null,
      scanned: globalSearchData.result && globalSearchData.result.scanned || null,
      resultCount: globalSearchData.result && globalSearchData.result.results ? globalSearchData.result.results.length : 0,
      results: globalSearchData.result && globalSearchData.result.results || [],
    };
  }

  function globalSearchResultAt(index) {
    return (globalSearchData.result && globalSearchData.result.results || [])[index] || null;
  }

  window.runGlobalSearch = async function() {
    var query = String(globalSearchData.query || '').trim();
    if (!query) {
      showToast('Search query is required', false);
      return;
    }
    globalSearchData.loading = true;
    globalSearchData.error = null;
    if (viewMode === 'observability') renderObservabilityView();
    try {
      var res = await fetch('/api/search?q=' + encodeURIComponent(query) + '&limit=60');
      var body = await res.json().catch(function() { return {}; });
      if (!res.ok || body.error) throw new Error(body.error || 'search failed');
      globalSearchData.result = body;
      globalSearchData.selectedIndex = -1;
      showToast('Search results: ' + ((body.results || []).length), true);
    } catch (err) {
      globalSearchData.result = null;
      globalSearchData.error = err.message || String(err);
      showToast('Search failed: ' + globalSearchData.error, false);
    } finally {
      globalSearchData.loading = false;
      if (viewMode === 'observability') renderObservabilityView();
    }
  };

  window.clearGlobalSearch = function() {
    globalSearchData.query = '';
    globalSearchData.error = null;
    globalSearchData.result = null;
    globalSearchData.selectedIndex = -1;
    if (viewMode === 'observability') renderObservabilityView();
  };

  window.copyGlobalSearchReport = function() {
    copyText(JSON.stringify(globalSearchReport(), null, 2));
  };

  window.exportGlobalSearchReport = function() {
    downloadTextFile('persona-global-search-' + Date.now() + '.json', JSON.stringify(globalSearchReport(), null, 2));
    showToast('Search report exported', true);
  };

  window.createTaskFromGlobalSearchReport = function() {
    var report = globalSearchReport();
    if (!report.resultCount && !report.error) {
      showToast('No search report to turn into a task', false);
      return;
    }
    var firstResult = report.results && report.results[0] || null;
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'globalSearchReport',
      report: report,
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: firstResult && firstResult.director || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review global search report: ' + shortText((report.query || 'search') + ' · ' + String(report.resultCount || 0) + ' result(s)', 80),
      prompt: globalSearchTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Search report loaded into task form', true);
  };

  window.copyGlobalSearchResultJson = function(index) {
    var item = globalSearchResultAt(index);
    if (!item) {
      showToast('Search result not found', false);
      return;
    }
    copyText(JSON.stringify(item, null, 2));
  };

  window.exportGlobalSearchResultJson = function(index) {
    var item = globalSearchResultAt(index);
    if (!item) {
      showToast('Search result not found', false);
      return;
    }
    downloadTextFile('persona-global-search-result-' + String(item.kind || 'hit').replace(/[^a-z0-9._-]+/gi, '-') + '-' + Date.now() + '.json', JSON.stringify(item, null, 2));
    showToast('Search result exported', true);
  };

  function globalSearchTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench global search handoff as task context.',
      '',
      'Operator intent:',
      '- Continue from or investigate this specific search result.',
      '- Use the selected result first, then compare it with the query, report, and scanned scope.',
      '- If the hit is a log/error/task failure, identify the likely cause and propose or implement a scoped fix.',
      '- If the hit is a conversation message, preserve the original session context unless the task prompt is edited.',
      '',
      'Global search handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromGlobalSearchResult = function(index) {
    var item = globalSearchResultAt(index);
    if (!item) {
      showToast('Search result not found', false);
      return;
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'globalSearchResult',
      query: globalSearchData.query || '',
      index: index,
      result: item,
      report: globalSearchReport(),
      target: {
        kind: item.kind || '',
        taskId: item.taskId || '',
        sessionId: item.sessionId || '',
        director: item.director || '',
        logSourceId: item.logSourceId || '',
        logPath: item.logPath || '',
        line: item.line || null,
      },
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: item.director || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Follow up search result: ' + shortText(item.title || item.preview || item.kind || 'search hit', 80),
      prompt: globalSearchTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Search result loaded into task form', true);
  };

  window.openSearchLogResult = function(sourceId) {
    logsData.selectedId = sourceId;
    logsData.query = globalSearchData.query || logsData.query || '';
    loadLogTail(sourceId);
    if (viewMode !== 'observability') selectNav('observability');
  };

  window.openSearchMessageResult = function(director, sessionId) {
    chatSearchQuery = globalSearchData.query || '';
    if (director && director !== 'main') {
      selectSubSession(director, sessionId || '', sessionId || 'Search Result');
    } else if (sessionId) {
      selectSession(sessionId);
    } else {
      selectSession(null);
    }
  };

  window.openGlobalSearchResult = function(index) {
    var results = (globalSearchData.result && globalSearchData.result.results) || [];
    var item = results[index];
    if (!item) return;
    globalSearchData.selectedIndex = index;
    if (item.kind === 'task' && item.taskId) {
      selectTask(item.taskId);
      return;
    }
    if (item.kind === 'log' && item.logSourceId) {
      openSearchLogResult(item.logSourceId);
      return;
    }
    if (item.kind === 'message') {
      openSearchMessageResult(item.director || 'main', item.sessionId || '');
      return;
    }
    showToast('This result has no direct target yet', false);
    if (viewMode === 'observability') renderObservabilityView();
  };

  function renderApiExplorerPanel() {
    var presets = [
      { method: 'GET', path: '/api/tasks?limit=5', label: 'Tasks' },
      { method: 'POST', path: '/api/tasks', label: 'Task POST', body: '{\n  "role": "researcher",\n  "description": "API explorer smoke task",\n  "prompt": "Summarize current workspace state.",\n  "source_director": "main"\n}' },
      { method: 'GET', path: '/api/cron-jobs', label: 'Cron' },
      { method: 'POST', path: '/api/cron-jobs', label: 'Cron POST', body: '{\n  "name": "API explorer sample",\n  "role": "researcher",\n  "description": "Sample disabled automation",\n  "prompt": "Report current status.",\n  "schedule": "every 60m",\n  "enabled": false,\n  "source_director": "main"\n}' },
      { method: 'GET', path: '/api/persona/roles', label: 'Roles' },
      { method: 'GET', path: '/api/persona/prompt?role=director', label: 'Prompt' },
      { method: 'GET', path: '/api/files?scope=outbox', label: 'Files' },
      { method: 'GET', path: '/api/logs/sources', label: 'Logs' },
      { method: 'GET', path: '/api/config-summary', label: 'Config' },
      { method: 'GET', path: '/api/env-check', label: 'Env' },
      { method: 'GET', path: '/api/debug-bundle', label: 'Bundle' },
      { method: 'GET', path: '/api/observability/diagnostics', label: 'Diag' },
    ];
    var method = (apiExplorerData.method || 'GET').toUpperCase();
    var html = '<div class="workbench-panel api-explorer">';
    html += '<div class="panel-title"><span>API Explorer</span><button class="mini-btn" onclick="runApiExplorer()">Run</button></div>';
    html += '<div class="api-presets">';
    for (var i = 0; i < presets.length; i++) {
      var preset = presets[i];
      var active = apiExplorerData.path === preset.path && method === preset.method;
      html += '<button class="scope-tab' + (active ? ' active' : '') + '" onclick="setApiExplorerPreset(\'' + jsq(preset.method) + '\',\'' + jsq(preset.path) + '\',\'' + jsq(preset.body || '') + '\')">' + esc(preset.label) + '</button>';
    }
    html += '</div>';
    html += '<div class="api-input-row"><select class="api-method-select" onchange="setApiExplorerMethod(this.value)">';
    var methods = ['GET', 'POST', 'PUT', 'DELETE'];
    for (var mi = 0; mi < methods.length; mi++) {
      html += '<option value="' + methods[mi] + '"' + (method === methods[mi] ? ' selected' : '') + '>' + methods[mi] + '</option>';
    }
    html += '</select><input value="' + esc(apiExplorerData.path || '') + '" oninput="setApiExplorerPath(this.value)" onkeydown="if(event.key===\'Enter\')runApiExplorer()"></div>';
    if (method !== 'GET') {
      html += '<label class="api-body-label"><span>JSON Body</span><textarea rows="7" spellcheck="false" oninput="setApiExplorerBody(this.value)">' + esc(apiExplorerData.body || '') + '</textarea></label>';
      html += '<div class="form-note">Non-GET requests are queued for local approval before they run.</div>';
    }
    if (apiExplorerData.loading) {
      html += '<div class="td-result-running"><div class="spinner"></div><span>Requesting...</span></div>';
    } else if (apiExplorerData.result) {
      var r = apiExplorerData.result;
      html += '<div class="api-result-meta"><span class="badge ' + (r.ok ? 'completed' : 'failed') + '">' + esc(String(r.status || '--')) + '</span><span>' + esc(r.method || method) + ' ' + esc(r.path || apiExplorerData.path || '') + '</span><span>' + esc(String(r.durationMs || 0)) + 'ms</span><div class="api-result-actions"><button class="mini-btn" onclick="copyApiExplorerCurl()">Copy cURL</button><button class="mini-btn" onclick="copyApiExplorerResult()">Copy Response</button><button class="mini-btn" onclick="copyApiExplorerReport()">Copy Report</button><button class="mini-btn" onclick="exportApiExplorerReport()">Export Report</button><button class="mini-btn primary" onclick="createTaskFromApiExplorerResult()">Create Task</button></div></div>';
      html += '<pre class="api-result">' + esc(r.body || '') + '</pre>';
    } else {
      html += '<div class="empty">Pick an endpoint, method, and run a local API request.</div>';
    }
    html += renderApiExplorerHistory();
    html += '</div>';
    return html;
  }

  function renderApiExplorerHistory() {
    var history = apiExplorerData.history || [];
    var html = '<div class="api-history-panel"><div class="panel-title"><span>Recent Requests</span><div class="panel-actions">';
    html += '<span>' + history.length + '</span>';
    if (history.length) {
      html += '<button class="mini-btn" onclick="copyApiExplorerHistoryReport()">Copy Report</button>';
      html += '<button class="mini-btn" onclick="exportApiExplorerHistoryReport()">Export Report</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromApiExplorerHistoryReport()">Create Task</button>';
    }
    html += '</div></div>';
    if (!history.length) {
      html += '<div class="empty compact">No API Explorer requests yet.</div></div>';
      return html;
    }
    html += '<div class="api-history-list">';
    for (var i = 0; i < history.length; i++) {
      var item = history[i];
      html += '<div class="api-history-row">';
      html += '<span class="badge ' + (item.ok ? 'completed' : 'failed') + '">' + esc(String(item.status || '--')) + '</span>';
      html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(item.method || 'GET') + ' ' + esc(item.path || '/') + '</div>';
      html += '<div class="panel-row-sub">' + esc(fmtTimestamp(Date.parse(item.at)) || item.at || '--') + ' · ' + esc(String(item.durationMs || 0)) + 'ms</div></div>';
      html += '<div class="api-history-actions">';
      html += '<button class="chat-msg-action" onclick="replayApiExplorerHistory(' + i + ')">Replay</button>';
      html += '<button class="chat-msg-action" onclick="copyApiExplorerHistoryCurl(' + i + ')">cURL</button>';
      html += '<button class="chat-msg-action" onclick="copyApiExplorerHistory(' + i + ')">Copy</button>';
      html += '<button class="chat-msg-action" onclick="exportApiExplorerHistory(' + i + ')">Export</button>';
      html += '<button class="chat-msg-action" onclick="createTaskFromApiExplorerHistory(' + i + ')">Create Task</button>';
      html += '</div></div>';
    }
    html += '</div></div>';
    return html;
  }

  function loadDiagnosticsSummary() {
    diagnosticsData.loading = true;
    diagnosticsData.error = null;
    if (viewMode === 'observability') renderObservabilityView();
    fetch('/api/observability/diagnostics')
      .then(function(r) {
        return r.text().then(function(text) {
          if (!r.ok) throw new Error(text || 'diagnostics request failed');
          try {
            return JSON.parse(text);
          } catch (_) {
            throw new Error('diagnostics returned non-JSON response');
          }
        });
      })
      .then(function(summary) {
        diagnosticsData.summary = summary;
        diagnosticsData.loading = false;
        if (viewMode === 'observability') renderObservabilityView();
      })
      .catch(function(err) {
        diagnosticsData.summary = null;
        diagnosticsData.loading = false;
        diagnosticsData.error = String(err && err.message || err);
        if (viewMode === 'observability') renderObservabilityView();
      });
  }

  window.loadDiagnosticsSummary = loadDiagnosticsSummary;

  function renderDirectorSelectOptions(selected) {
    var labels = ['main'];
    var pool = data && data.pool || [];
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].label && labels.indexOf(pool[i].label) < 0) labels.push(pool[i].label);
    }
    var html = '';
    for (var li = 0; li < labels.length; li++) {
      html += '<option value="' + esc(labels[li]) + '"' + (selected === labels[li] ? ' selected' : '') + '>' + esc(labels[li]) + '</option>';
    }
    return html;
  }

  function renderTaskIdDatalist() {
    var tasks = [];
    if (data && data.tasks && data.tasks.recent) tasks = tasks.concat(data.tasks.recent);
    if (taskCenterData.tasks) tasks = tasks.concat(taskCenterData.tasks);
    var seen = {};
    var html = '<datalist id="parse-task-options">';
    for (var i = 0; i < tasks.length; i++) {
      var id = tasks[i].id;
      if (!id || seen[id]) continue;
      seen[id] = true;
      html += '<option value="' + esc(id) + '">' + esc(shortText(tasks[i].description || tasks[i].role || id, 90)) + '</option>';
    }
    html += '</datalist>';
    return html;
  }

  function renderParseLogPanel() {
    var result = parseLogData.result;
    var html = '<div class="workbench-panel parse-log-panel">';
    html += '<div class="panel-title"><span>Parse Log Results</span><div class="panel-actions">';
    html += '<button class="mini-btn" onclick="loadParsedLogResult()">' + (parseLogData.loading ? 'Parsing...' : 'Parse') + '</button>';
    if (result) {
      html += '<button class="mini-btn" onclick="copyParsedLogResult()">Copy Report</button>';
      html += '<button class="mini-btn" onclick="exportParsedLogResult()">Export Report</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromParsedLogReport()">Create Task</button>';
    }
    html += '</div></div>';
    html += '<div class="parse-controls">';
    html += '<label><span>Mode</span><select onchange="setParseLogMode(this.value)">';
    html += '<option value="conversation"' + (parseLogData.mode === 'conversation' ? ' selected' : '') + '>Conversation</option>';
    html += '<option value="task"' + (parseLogData.mode === 'task' ? ' selected' : '') + '>Task Log</option>';
    html += '</select></label>';
    if (parseLogData.mode === 'conversation') {
      html += '<label><span>Director</span><select onchange="setParseLogField(\'director\', this.value)">' + renderDirectorSelectOptions(parseLogData.director || 'main') + '</select></label>';
    } else {
      html += '<label><span>Task ID</span><input list="parse-task-options" value="' + esc(parseLogData.taskId || '') + '" placeholder="T-0529-..." oninput="setParseLogField(\'taskId\', this.value)" onkeydown="if(event.key===\'Enter\')loadParsedLogResult()"></label>';
      html += renderTaskIdDatalist();
    }
    html += '</div>';
    if (parseLogData.loading) {
      html += '<div class="td-result-running"><div class="spinner"></div><span>Parsing structured log output...</span></div>';
    } else if (parseLogData.error) {
      html += '<div class="td-error compact">' + esc(parseLogData.error) + '</div>';
    } else if (!result) {
      html += '<div class="empty">Parse conversation logs or a task stdout log into structured records.</div>';
    } else if (parseLogData.mode === 'conversation') {
      var messages = Array.isArray(result) ? result : [];
      html += '<div class="parse-meta"><span class="badge completed">' + messages.length + ' messages</span><span class="muted">director ' + esc(parseLogData.director || 'main') + '</span></div>';
      if (messages.length === 0) {
        html += '<div class="empty compact">No parsed messages.</div>';
      } else {
        html += '<div class="parse-list">';
        for (var i = 0; i < Math.min(messages.length, 8); i++) {
          var m = messages[i];
          html += '<div class="parse-row"><span class="badge ' + (m.direction === 'in' ? 'pending' : 'completed') + '">' + esc(m.direction || 'msg') + '</span>';
          html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(shortText(m.content || '', 180)) + '</div>';
          html += '<div class="panel-row-sub">' + esc(m.sessionId || 'no session') + ' · ' + esc(fmtTimestamp(m.timestamp)) + '</div></div>';
          html += '<div class="panel-actions">';
          if (m.sessionId) html += '<button class="chat-msg-action" onclick="openParsedConversationSession(' + i + ')">Open Session</button>';
          html += '<button class="chat-msg-action" onclick="copyParsedConversationMessage(' + i + ')">Copy JSON</button>';
          html += '<button class="chat-msg-action" onclick="exportParsedConversationMessage(' + i + ')">Export</button>';
          html += '<button class="chat-msg-action" onclick="createTaskFromParsedConversationMessage(' + i + ')">Create Task</button>';
          html += '</div></div>';
        }
        html += '</div>';
      }
    } else {
      var entries = result.entries || [];
      html += '<div class="parse-meta"><span class="badge completed">' + entries.length + ' entries</span><span class="muted">' + esc(String(result.totalLines || 0)) + ' total lines</span></div>';
      if (entries.length === 0) {
        html += '<div class="empty compact">No structured task log entries.</div>';
      } else {
        html += '<div class="parse-list">';
        for (var ei = 0; ei < Math.min(entries.length, 10); ei++) {
          var e = entries[ei];
          html += '<div class="parse-row"><span class="badge pending">' + esc(e.type || 'log') + '</span>';
          html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(shortText(e.content || '', 180)) + '</div>';
          html += '<div class="panel-row-sub">line ' + esc(String(e.line || 0)) + (e.meta ? ' · meta' : '') + '</div></div>';
          html += '<div class="panel-actions">';
          if (parseLogData.taskId) html += '<button class="chat-msg-action" onclick="selectTask(\'' + jsq(parseLogData.taskId) + '\')">Open Task</button>';
          html += '<button class="chat-msg-action" onclick="copyParsedTaskLogEntry(' + ei + ')">Copy JSON</button>';
          html += '<button class="chat-msg-action" onclick="exportParsedTaskLogEntry(' + ei + ')">Export</button>';
          html += '<button class="chat-msg-action" onclick="createTaskFromParsedTaskLogEntry(' + ei + ')">Create Task</button>';
          html += '</div></div>';
        }
        html += '</div>';
      }
    }
    html += '</div>';
    return html;
  }

  window.setParseLogMode = function(mode) {
    parseLogData.mode = mode === 'task' ? 'task' : 'conversation';
    parseLogData.error = null;
    parseLogData.result = null;
    if (!parseLogData.taskId && data && data.tasks && data.tasks.recent && data.tasks.recent[0]) {
      parseLogData.taskId = data.tasks.recent[0].id || '';
    }
    if (viewMode === 'observability') renderObservabilityView();
  };

  window.setParseLogField = function(key, value) {
    parseLogData[key] = String(value || '');
  };

  window.loadParsedLogResult = async function() {
    parseLogData.loading = true;
    parseLogData.error = null;
    parseLogData.result = null;
    if (viewMode === 'observability') renderObservabilityView();
    try {
      var url = '';
      if (parseLogData.mode === 'task') {
        var taskId = String(parseLogData.taskId || '').trim();
        if (!taskId) throw new Error('Task ID is required');
        url = '/api/tasks/' + encodeURIComponent(taskId) + '/logs';
      } else {
        var director = parseLogData.director && parseLogData.director !== 'main' ? parseLogData.director : '';
        url = '/api/messages?limit=80' + (director ? '&director=' + encodeURIComponent(director) : '');
      }
      var res = await fetch(url);
      var text = await res.text();
      if (!res.ok) throw new Error(text || 'parse request failed');
      try {
        parseLogData.result = JSON.parse(text);
      } catch (_) {
        throw new Error('parse endpoint returned non-JSON response');
      }
    } catch (err) {
      parseLogData.error = String(err && err.message || err);
    } finally {
      parseLogData.loading = false;
      if (viewMode === 'observability') renderObservabilityView();
    }
  };

  window.copyParsedLogResult = function() {
    if (!parseLogData.result) {
      showToast('No parsed log result loaded', false);
      return;
    }
    copyText(JSON.stringify(parsedLogResultPayload(), null, 2));
  };

  window.exportParsedLogResult = function() {
    if (!parseLogData.result) {
      showToast('No parsed log result loaded', false);
      return;
    }
    downloadTextFile('persona-parsed-log-' + safeAssetName(parseLogData.mode, 'log') + '-' + Date.now() + '.json', JSON.stringify(parsedLogResultPayload(), null, 2));
    showToast('Parsed log report exported', true);
  };

  function parsedConversationMessages() {
    return Array.isArray(parseLogData.result) ? parseLogData.result : [];
  }

  function parsedTaskLogEntries() {
    return parseLogData.result && Array.isArray(parseLogData.result.entries) ? parseLogData.result.entries : [];
  }

  function parsedLogResultPayload() {
    var conversation = parsedConversationMessages();
    var taskEntries = parsedTaskLogEntries();
    return {
      exportedAt: new Date().toISOString(),
      mode: parseLogData.mode || 'conversation',
      source: {
        director: parseLogData.mode === 'conversation' ? parseLogData.director || 'main' : null,
        taskId: parseLogData.mode === 'task' ? parseLogData.taskId || null : null,
      },
      counts: {
        messages: conversation.length,
        entries: taskEntries.length,
        totalLines: parseLogData.result && parseLogData.result.totalLines || null,
      },
      result: parseLogData.result,
    };
  }

  function parsedConversationMessagePayload(index) {
    var message = parsedConversationMessages()[index];
    return {
      exportedAt: new Date().toISOString(),
      mode: 'conversation',
      index: index,
      source: {
        director: parseLogData.director || 'main',
        sessionId: message && message.sessionId || null,
      },
      message: message || null,
    };
  }

  function parsedTaskLogEntryPayload(index) {
    var entry = parsedTaskLogEntries()[index];
    return {
      exportedAt: new Date().toISOString(),
      mode: 'task',
      index: index,
      source: {
        taskId: parseLogData.taskId || null,
        totalLines: parseLogData.result && parseLogData.result.totalLines || null,
      },
      entry: entry || null,
    };
  }

  function parsedLogTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench parsed log handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate or continue from this specific parsed log item.',
      '- Use the selected item first, then compare it with the full parsed report for surrounding context.',
      '- If the item is an error, failed tool result, or suspicious message, identify the likely cause and propose or implement a scoped fix.',
      '- Preserve the original session/task source unless the task prompt is edited.',
      '',
      'Parsed log handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function parsedLogReportTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench parsed log report as task context.',
      '',
      'Operator intent:',
      '- Review the full parsed conversation or task log report before focusing on individual records.',
      '- Identify repeated failures, suspicious tool results, missing session/task links, noisy messages, or follow-up work implied by the parsed structure.',
      '- Use the source metadata, counts, parsed result, runtime snapshot, and approval context before acting.',
      '- Preserve the original session/task source unless the task prompt is edited.',
      '',
      'Parsed log report handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromParsedLogReport = function() {
    if (!parseLogData.result) {
      showToast('No parsed log report loaded', false);
      return;
    }
    var report = parsedLogResultPayload();
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'parsedLogReport',
      report: report,
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    var source = report.source || {};
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: source.director || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review parsed log report: ' + (report.mode || 'log') + ' · ' + String(report.counts.messages || report.counts.entries || 0) + ' item(s)',
      prompt: parsedLogReportTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Parsed log report loaded into task form', true);
  };

  window.openParsedConversationSession = function(index) {
    var message = parsedConversationMessages()[index];
    if (!message || !message.sessionId) {
      showToast('Parsed message has no session id', false);
      return;
    }
    var director = parseLogData.director || 'main';
    chatSearchQuery = shortText(message.content || '', 80);
    if (director && director !== 'main') {
      selectSubSession(director, message.sessionId, message.sessionId.slice(0, 16));
    } else {
      selectSession(message.sessionId);
    }
  };

  window.copyParsedConversationMessage = function(index) {
    var payload = parsedConversationMessagePayload(index);
    if (!payload.message) {
      showToast('Parsed message not found', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportParsedConversationMessage = function(index) {
    var payload = parsedConversationMessagePayload(index);
    if (!payload.message) {
      showToast('Parsed message not found', false);
      return;
    }
    var safe = safeAssetName(payload.message.sessionId || payload.message.direction || 'message', 'message');
    downloadTextFile('persona-parsed-message-' + safe + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Parsed message exported', true);
  };

  window.createTaskFromParsedConversationMessage = function(index) {
    var payload = parsedConversationMessagePayload(index);
    if (!payload.message) {
      showToast('Parsed message not found', false);
      return;
    }
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: payload.source.director || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Follow up parsed message: ' + shortText(payload.message.content || payload.message.sessionId || 'message', 80),
      prompt: parsedLogTaskPromptPayload({ type: 'parsedConversationMessage', item: payload, report: parsedLogResultPayload() }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Parsed message loaded into task form', true);
  };

  window.copyParsedTaskLogEntry = function(index) {
    var payload = parsedTaskLogEntryPayload(index);
    if (!payload.entry) {
      showToast('Parsed task log entry not found', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportParsedTaskLogEntry = function(index) {
    var payload = parsedTaskLogEntryPayload(index);
    if (!payload.entry) {
      showToast('Parsed task log entry not found', false);
      return;
    }
    var safeTask = safeAssetName(payload.source.taskId || 'task', 'task');
    var safeLine = payload.entry.line == null ? 'entry' : 'line-' + safeAssetName(String(payload.entry.line), 'entry');
    downloadTextFile('persona-parsed-task-log-' + safeTask + '-' + safeLine + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Parsed task log entry exported', true);
  };

  window.createTaskFromParsedTaskLogEntry = function(index) {
    var payload = parsedTaskLogEntryPayload(index);
    if (!payload.entry) {
      showToast('Parsed task log entry not found', false);
      return;
    }
    var entry = payload.entry || {};
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Follow up parsed task log: ' + shortText(entry.content || payload.source.taskId || 'log entry', 80),
      prompt: parsedLogTaskPromptPayload({ type: 'parsedTaskLogEntry', item: payload, report: parsedLogResultPayload() }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Parsed task log loaded into task form', true);
  };

  function pctText(value) {
    if (value == null || !isFinite(Number(value))) return '0%';
    return Number(value).toFixed(1).replace(/\.0$/, '') + '%';
  }

  function runtimeEventSources() {
    var sys = data && data.system || {};
    var act = data && data.activity || {};
    var items = [{
      label: 'main',
      name: 'Main Director',
      activity: act.state || 'idle',
      recentRestartAt: sys.recentRestartAt || [],
      lastRestartAt: sys.lastRestartAt || null,
      lastRestartReason: sys.lastRestartReason || '',
      lastCrashAt: sys.lastCrashAt || null,
      lastCrashReason: sys.lastCrashReason || '',
      restartCount: sys.restartCount || 0,
    }];
    var poolData = data && data.pool || [];
    for (var i = 0; i < poolData.length; i++) {
      var p = poolData[i];
      items.push({
        label: p.label || '',
        name: p.groupName || p.label || 'Pool Director',
        activity: p.activity || (p.closed ? 'closed' : 'idle'),
        recentRestartAt: p.recentRestartAt || [],
        lastRestartAt: p.lastRestartAt || null,
        lastRestartReason: p.lastRestartReason || '',
        lastCrashAt: p.lastCrashAt || null,
        lastCrashReason: p.lastCrashReason || '',
        restartCount: p.restartCount || 0,
      });
    }
    return items;
  }

  function runtimeEventHistory() {
    var events = [];
    var sources = runtimeEventSources();
    for (var i = 0; i < sources.length; i++) {
      var src = sources[i];
      var seen = {};
      var recent = src.recentRestartAt || [];
      for (var j = 0; j < recent.length; j++) {
        var ts = Number(recent[j] || 0);
        if (!ts || seen[ts]) continue;
        seen[ts] = true;
        events.push({ type: 'restart', at: ts, reason: src.lastRestartReason || 'restart', label: src.label, name: src.name, activity: src.activity });
      }
      if (src.lastRestartAt && !seen[src.lastRestartAt]) {
        events.push({ type: 'restart', at: src.lastRestartAt, reason: src.lastRestartReason || 'restart', label: src.label, name: src.name, activity: src.activity });
      }
      if (src.lastCrashAt) {
        events.push({ type: 'crash', at: src.lastCrashAt, reason: src.lastCrashReason || 'crash', label: src.label, name: src.name, activity: src.activity });
      }
    }
    events.sort(function(a, b) { return Number(b.at || 0) - Number(a.at || 0); });
    return events.slice(0, 16);
  }

  function runtimeEventHistoryPayload() {
    return {
      exportedAt: new Date().toISOString(),
      events: runtimeEventHistory(),
      sources: runtimeEventSources(),
      snapshot: {
        system: data && data.system || null,
        poolCount: data && data.pool ? data.pool.length : 0,
        websocketConnected: !!wsConnected,
      },
    };
  }

  function runtimeEventPayload(index) {
    var events = runtimeEventHistory();
    var event = events[index] || null;
    var sources = runtimeEventSources();
    var source = event ? sources.find(function(item) { return item.label === event.label; }) || null : null;
    return {
      exportedAt: new Date().toISOString(),
      index: index,
      event: event,
      source: source,
      sources: sources,
    };
  }

  function runtimeEventTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench runtime event handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate the captured Director restart/crash evidence before changing runtime behavior.',
      '- Correlate event time, Director label, restart/crash reason, activity state, and nearby task/session evidence.',
      '- If this is a crash or suspicious restart loop, identify the most likely cause and propose or implement a scoped fix.',
      '- Preserve current safety boundaries; high-impact runtime actions should still use the existing approval paths.',
      '',
      'Runtime event handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function createTaskFromRuntimeEventPayload(payload, label) {
    var event = payload && payload.event || null;
    var history = payload && payload.history || null;
    if (!event && !(history && history.events && history.events.length)) {
      showToast('Runtime event evidence not found', false);
      return;
    }
    var director = event && event.label || 'main';
    var title = event
      ? (event.type || 'event') + ' on ' + (event.name || event.label || 'Director')
      : 'runtime event history';
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: director,
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate runtime event: ' + shortText(title, 80),
      prompt: runtimeEventTaskPromptPayload({ type: label || 'runtimeEvent', evidence: payload }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Runtime event handoff loaded into task form', true);
  }

  function renderRuntimeEventHistoryPanel() {
    var events = runtimeEventHistory();
    var html = '<div class="workbench-panel runtime-event-history"><div class="panel-title"><span>Runtime Event History</span><div class="panel-actions">';
    html += '<span>' + events.length + '</span>';
    if (events.length > 0) {
      html += '<button class="mini-btn" onclick="copyRuntimeEventHistory()">Copy Report</button>';
      html += '<button class="mini-btn" onclick="exportRuntimeEventHistory()">Export Report</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromRuntimeEventHistory()">Create Task</button>';
    }
    html += '</div></div>';
    if (events.length === 0) {
      html += '<div class="empty compact">No recent restart or crash events in the current runtime snapshot.</div>';
    } else {
      html += '<div class="runtime-event-list">';
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var badge = ev.type === 'crash' ? 'failed' : 'pending';
        html += '<div class="runtime-event-row"><span class="badge ' + badge + '">' + esc(ev.type) + '</span><div class="panel-row-main">';
        html += '<div class="panel-row-title">' + esc(ev.name || ev.label || '--') + '</div>';
        html += '<div class="panel-row-sub">' + esc(ev.label || '--') + ' · ' + esc(ev.reason || '--') + ' · ' + esc(formatMessageTime(ev.at) || fmtAgo(ev.at)) + '</div>';
        html += '</div><div class="panel-actions">';
        html += '<button class="chat-msg-action" onclick="openRuntimeEventDirector(' + i + ')">Open Director</button>';
        html += '<button class="chat-msg-action" onclick="copyRuntimeEvent(' + i + ')">Copy</button>';
        html += '<button class="chat-msg-action" onclick="exportRuntimeEvent(' + i + ')">Export</button>';
        html += '<button class="chat-msg-action" onclick="createTaskFromRuntimeEvent(' + i + ')">Create Task</button>';
        html += '</div></div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderDiagnosticsPanel() {
    var summary = diagnosticsData.summary;
    var html = '<div class="workbench-panel diagnostics-panel">';
    html += '<div class="panel-title"><span>Diagnostics</span><div class="panel-actions">';
    html += '<button class="mini-btn" onclick="loadDiagnosticsSummary()">' + (diagnosticsData.loading ? 'Loading...' : 'Refresh') + '</button>';
    html += '<button class="mini-btn" onclick="copyDiagnosticsSummary()">Copy Report</button>';
    html += '<button class="mini-btn" onclick="exportDiagnosticsSummary()">Export Report</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromDiagnosticsSummary()">Create Task</button>';
    html += '</div></div>';
    if (diagnosticsData.loading) {
      html += '<div class="td-result-running"><div class="spinner"></div><span>Aggregating tasks and logs...</span></div>';
    } else if (diagnosticsData.error) {
      html += '<div class="td-error compact">' + esc(diagnosticsData.error) + '</div>';
    } else if (!summary) {
      html += '<div class="empty">No diagnostics loaded.</div>';
    } else {
      var health = summary.health || {};
      html += '<div class="diagnostic-health">';
      html += '<div><span>Success</span><strong>' + esc(pctText(health.successRate)) + '</strong></div>';
      html += '<div><span>Failed</span><strong>' + esc(String(health.failed || 0)) + '</strong></div>';
      html += '<div><span>Cost</span><strong>' + esc(fmtCost(health.totalCostUsd || 0)) + '</strong></div>';
      html += '<div><span>Avg Duration</span><strong>' + esc(fmtDur(health.avgDurationMs || 0)) + '</strong></div>';
      html += '</div>';
      html += renderErrorAggregation(summary.errors || []);
      html += '<div class="diagnostic-columns">';
      html += renderRateList('Providers', summary.providerStats || []);
      html += renderRateList('Roles', summary.roleStats || []);
      html += '</div>';
      html += renderCronDiagnostics(summary.cronStats || []);
      html += renderMetricsTrendPanel(summary.trends || []);
      html += renderTrendStrip(summary.trends || []);
    }
    html += '</div>';
    return html;
  }

  function renderErrorAggregation(errors) {
    var html = '<div class="diagnostic-section"><div class="diagnostic-section-title">Error Aggregation</div>';
    if (!errors || errors.length === 0) {
      html += '<div class="empty compact">No recent errors found in tasks, runtime metrics, or log tails.</div></div>';
      return html;
    }
    html += '<div class="diagnostic-error-list">';
    for (var i = 0; i < Math.min(errors.length, 5); i++) {
      var err = errors[i];
      var taskId = firstDiagnosticTaskId(err);
      var logLabel = firstDiagnosticLogLabel(err);
      html += '<div class="diagnostic-error-row">';
      html += '<span class="badge failed">' + esc(String(err.count || 1)) + 'x</span>';
      html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(shortText(err.message || '', 160)) + '</div>';
      html += '<div class="panel-row-sub">' + esc((err.sources || []).join(', ') || 'unknown') + ' · last ' + esc(fmtAgo(err.lastAt)) + '</div>';
      html += '<div class="diagnostic-error-actions">';
      html += '<button class="chat-msg-action" onclick="copyDiagnosticError(' + i + ')">Copy</button>';
      html += '<button class="chat-msg-action" onclick="exportDiagnosticError(' + i + ')">Export</button>';
      html += '<button class="chat-msg-action" onclick="createTaskFromDiagnosticError(' + i + ')">Create Task</button>';
      if (taskId) html += '<button class="chat-msg-action" onclick="openDiagnosticErrorTask(' + i + ')">Open Task</button>';
      if (logLabel) html += '<button class="chat-msg-action" onclick="openDiagnosticErrorLog(' + i + ')">Open Log</button>';
      if (err.message) html += '<button class="chat-msg-action" onclick="searchDiagnosticError(' + i + ')">Search</button>';
      html += '</div></div></div>';
    }
    html += '</div></div>';
    return html;
  }

  function renderRateList(title, items) {
    var kind = title === 'Roles' ? 'role' : 'provider';
    var usageItems = enrichDiagnosticRateItems(items || []);
    var html = '<div class="diagnostic-section diagnostic-rate-section diagnostic-rate-' + esc(kind) + '"><div class="panel-title"><span>' + esc(title) + '</span><div class="panel-actions">';
    if (usageItems.length > 0) {
      html += '<button class="mini-btn" onclick="copyDiagnosticRateReport(\'' + kind + '\')">Copy Report</button>';
      html += '<button class="mini-btn" onclick="exportDiagnosticRateReport(\'' + kind + '\')">Export Report</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromDiagnosticRateReport(\'' + kind + '\')">Create Task</button>';
    }
    html += '</div></div>';
    if (usageItems.length === 0) {
      html += '<div class="empty compact">No data</div></div>';
      return html;
    }
    html += '<div class="diagnostic-rate-list">';
    for (var i = 0; i < Math.min(usageItems.length, 6); i++) {
      var item = usageItems[i];
      html += '<div class="diagnostic-rate-row">';
      html += '<div class="rate-row-head"><span>' + esc(item.name || 'unknown') + '</span><strong>' + esc(pctText(item.successRate)) + '</strong></div>';
      html += '<div class="rate-bar"><i style="width:' + Math.max(0, Math.min(100, Number(item.successRate || 0))) + '%"></i></div>';
      html += '<div class="diagnostic-usage-grid">';
      html += '<div><span>Tasks</span><strong>' + esc(String(item.total || 0)) + '</strong><em>' + esc(pctText(item.taskShare)) + '</em></div>';
      html += '<div><span>Cost</span><strong>' + esc(fmtCost(item.costUsd || 0)) + '</strong><em>' + esc(pctText(item.costShare)) + '</em></div>';
      html += '<div><span>Avg</span><strong>' + esc(item.durationCount ? fmtDur(item.avgDurationMs || 0) : '--') + '</strong><em>' + esc(String(item.durationCount || 0)) + ' measured</em></div>';
      html += '<div><span>Last</span><strong>' + esc(item.lastTaskAt ? fmtAgo(Date.parse(item.lastTaskAt)) : '--') + '</strong><em>' + esc(String(item.failed || 0)) + ' failed</em></div>';
      html += '</div>';
      html += '<div class="rate-bar usage"><i style="width:' + Math.max(0, Math.min(100, Number(item.taskShare || 0))) + '%"></i></div>';
      html += '<div class="panel-actions">';
      html += '<button class="chat-msg-action" onclick="openDiagnosticRateTasks(\'' + kind + '\',' + i + ')">Open Tasks</button>';
      html += '<button class="chat-msg-action" onclick="copyDiagnosticRateItem(\'' + kind + '\',' + i + ')">Copy</button>';
      html += '<button class="chat-msg-action" onclick="exportDiagnosticRateItem(\'' + kind + '\',' + i + ')">Export</button>';
      html += '<button class="chat-msg-action" onclick="createTaskFromDiagnosticRateItem(\'' + kind + '\',' + i + ')">Create Task</button>';
      html += '</div>';
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }

  function renderCronDiagnostics(items) {
    var active = (items || []).filter(function(item) { return item.total > 0 || item.failed > 0; });
    var html = '<div class="diagnostic-section cron-diagnostics-panel"><div class="panel-title"><span>Cron Failure Rate</span><div class="panel-actions">';
    if (active.length > 0) {
      html += '<button class="mini-btn" onclick="copyCronDiagnosticsReport()">Copy Report</button>';
      html += '<button class="mini-btn" onclick="exportCronDiagnosticsReport()">Export Report</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromCronDiagnosticsReport()">Create Task</button>';
    }
    html += '</div></div>';
    if (active.length === 0) {
      html += '<div class="empty compact">No cron task runs in the diagnostics window.</div></div>';
      return html;
    }
    html += '<div class="diagnostic-cron-list">';
    for (var i = 0; i < Math.min(active.length, 5); i++) {
      var item = active[i];
      html += '<div class="diagnostic-cron-row"><span class="badge ' + (item.failed ? 'failed' : 'completed') + '">' + esc(pctText(item.failureRate)) + '</span>';
      html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(item.name || item.id || 'cron') + '</div>';
      html += '<div class="panel-row-sub">' + esc(String(item.total || 0)) + ' runs · ' + esc(String(item.failed || 0)) + ' failed · last ' + esc(item.lastRunAt || '--') + '</div></div>';
      html += '<div class="panel-actions">';
      html += '<button class="chat-msg-action" onclick="openCronDiagnosticTasks(' + i + ')">Open Tasks</button>';
      html += '<button class="chat-msg-action" onclick="copyCronDiagnosticItem(' + i + ')">Copy</button>';
      html += '<button class="chat-msg-action" onclick="exportCronDiagnosticItem(' + i + ')">Export</button>';
      html += '<button class="chat-msg-action" onclick="createTaskFromCronDiagnosticItem(' + i + ')">Create Task</button>';
      html += '</div></div>';
    }
    html += '</div></div>';
    return html;
  }

  function renderTrendStrip(trends) {
    var html = '<div class="diagnostic-section task-trend-strip-panel"><div class="panel-title"><span>Task Trend</span><div class="panel-actions">';
    if (trends && trends.length > 0) {
      html += '<button class="mini-btn" onclick="copyDiagnosticTaskTrendReport()">Copy Report</button>';
      html += '<button class="mini-btn" onclick="exportDiagnosticTaskTrendReport()">Export Report</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromDiagnosticTaskTrendReport()">Create Task</button>';
    }
    html += '</div></div>';
    if (!trends || trends.length === 0) {
      html += '<div class="empty compact">No trend data</div></div>';
      return html;
    }
    var maxTotal = trends.reduce(function(max, item) { return Math.max(max, item.total || 0); }, 1);
    html += '<div class="trend-strip">';
    for (var i = 0; i < trends.length; i++) {
      var item = trends[i];
      var h = Math.max(8, Math.round(((item.total || 0) / maxTotal) * 54));
      html += '<div class="trend-day-wrap">';
      html += '<button class="trend-day" title="' + esc(item.day || '') + ': ' + esc(String(item.total || 0)) + ' tasks" onclick="openDiagnosticTaskTrendDayTasks(' + i + ')">';
      html += '<i style="height:' + h + 'px" class="' + ((item.failed || 0) > 0 ? 'has-failure' : '') + '"></i>';
      html += '<span>' + esc(String(item.day || '').slice(5)) + '</span></button>';
      html += '<button class="trend-day-export" title="Export ' + esc(item.day || 'day') + '" onclick="exportDiagnosticTaskTrendDay(' + i + ')">JSON</button>';
      html += '<button class="trend-day-export" title="Create task for ' + esc(item.day || 'day') + '" onclick="createTaskFromDiagnosticTaskTrendDay(' + i + ')">Task</button>';
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }

  function trendValues(trends, key) {
    return (trends || []).map(function(item) { return Number(item && item[key] || 0); });
  }

  function renderMiniTrend(values, className) {
    var max = values.reduce(function(m, value) { return Math.max(m, Number(value || 0)); }, 0);
    if (max <= 0) return '<div class="mini-trend empty-trend"><span>No history</span></div>';
    var html = '<div class="mini-trend ' + esc(className || '') + '">';
    for (var i = 0; i < values.length; i++) {
      var h = Math.max(6, Math.round((Number(values[i] || 0) / max) * 38));
      html += '<i style="height:' + h + 'px"></i>';
    }
    html += '</div>';
    return html;
  }

  function renderContextMetricRows() {
    var rows = contextMetricRows();
    var html = '<div class="context-metric-list">';
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var pct = Math.max(0, Math.min(100, contextRowPercent(row)));
      html += '<div class="context-metric-row">';
      html += '<div class="rate-row-head"><span>' + esc(row.label) + '</span><strong>' + (row.live ? esc(String(pct) + '%') : 'stale') + '</strong></div>';
      html += '<div class="rate-bar"><i style="width:' + pct + '%"></i></div>';
      html += '<div class="panel-row-sub">' + esc(fmtTokens(contextRowTokens(row))) + ' / ' + esc(fmtTokens(row.limit)) + '</div>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderMetricsTrendPanel(trends) {
    var metrics = data && data.metrics || {};
    var today = metrics.today || {};
    var health = diagnosticsData.summary && diagnosticsData.summary.health || {};
    var contextRows = contextMetricRows();
    var mainContext = contextRows[0] || {};
    var html = '<div class="diagnostic-section metrics-trend-panel">';
    html += '<div class="panel-title"><span>Metrics Trend</span><div class="panel-actions">';
    html += '<button class="mini-btn" onclick="copyMetricsTrendReport()">Copy Report</button>';
    html += '<button class="mini-btn" onclick="exportMetricsTrendReport()">Export Report</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromMetricsTrendReport()">Create Task</button>';
    html += '</div></div>';
    html += '<div class="metric-trend-grid">';
    html += '<div class="metric-trend-card"><div class="metric-trend-head"><span>Cost</span><strong>' + esc(fmtCost(health.totalCostUsd || 0)) + '</strong></div>' + renderMiniTrend(trendValues(trends, 'costUsd'), 'cost') + '<div class="panel-row-sub">14-day task cost</div></div>';
    html += '<div class="metric-trend-card"><div class="metric-trend-head"><span>Latency</span><strong>' + esc(fmtDur(health.avgDurationMs || 0)) + '</strong></div>' + renderMiniTrend(trendValues(trends, 'avgDurationMs'), 'latency') + '<div class="panel-row-sub">avg task duration by day</div></div>';
    html += '<div class="metric-trend-card"><div class="metric-trend-head"><span>Messages</span><strong>' + esc(String(today.messagesProcessed || 0)) + '</strong></div>' + renderMiniTrend((metrics.recentMessages || []).map(function(item) { return Number(item.responseSec || 0); }), 'messages') + '<div class="panel-row-sub">recent response seconds</div></div>';
    html += '<div class="metric-trend-card"><div class="metric-trend-head"><span>Context</span><strong>' + esc(mainContext.percent == null ? '--' : String(mainContext.percent) + '%') + '</strong></div>' + renderContextMetricRows() + '<div class="panel-row-sub">live token / context window</div></div>';
    html += '</div></div>';
    return html;
  }

  function renderDebugToolsPanel() {
    var checks = debugToolsData.env && debugToolsData.env.checks || [];
    var okCount = checks.filter(function(item) { return item.available; }).length;
    var html = '<div class="workbench-panel debug-tools-panel">';
    html += '<div class="panel-title"><span>Debug Tools</span><div class="panel-actions">';
    html += '<button class="mini-btn" onclick="runEnvCheck()">' + (debugToolsData.envLoading ? 'Checking...' : 'Run Env Check') + '</button>';
    if (debugToolsData.env || debugToolsData.envError) {
      html += '<button class="mini-btn" onclick="copyEnvCheckReport()">Copy Env</button>';
      html += '<button class="mini-btn" onclick="exportEnvCheckReport()">Export Env</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromEnvCheckReport()">Create Task</button>';
    }
    html += '<button class="mini-btn" onclick="exportDebugBundle()">' + (debugToolsData.bundleLoading ? 'Exporting...' : 'Export Bundle') + '</button>';
    if (debugToolsData.bundleEvidence) {
      html += '<button class="mini-btn" onclick="copyDebugBundleEvidence()">Copy Bundle Evidence</button>';
      html += '<button class="mini-btn" onclick="exportDebugBundleEvidence()">Export Bundle Evidence</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromDebugBundleEvidence()">Create Task</button>';
    }
    html += '</div></div>';
    if (debugToolsData.envError) {
      html += '<div class="td-error compact">' + esc(debugToolsData.envError) + '</div>';
    }
    if (debugToolsData.bundleError) {
      html += '<div class="td-error compact">' + esc(debugToolsData.bundleError) + '</div>';
    }
    if (debugToolsData.bundleEvidence) {
      var bundle = debugToolsData.bundleEvidence;
      html += '<div class="debug-sim-result">';
      html += '<div class="debug-sim-result-head"><span>Debug Bundle Evidence</span><div class="panel-actions">';
      html += '<span class="muted mono">' + esc(bundle.filename || 'bundle') + '</span>';
      html += '<button class="chat-msg-action" onclick="copyDebugBundleEvidence()">Copy</button>';
      html += '<button class="chat-msg-action" onclick="exportDebugBundleEvidence()">Export</button>';
      html += '<button class="chat-msg-action" onclick="createTaskFromDebugBundleEvidence()">Create Task</button>';
      html += '</div></div>';
      html += '<div class="debug-sim-result-text">' + esc('generated ' + (bundle.generatedAt || '--') + ' · ' + fmtFileSize(bundle.bytes || 0) + ' · ' + (bundle.summary && bundle.summary.logSources || 0) + ' logs · ' + (bundle.summary && bundle.summary.tasks || 0) + ' tasks') + '</div>';
      html += '</div>';
    }
    if (debugToolsData.simulateError) {
      html += '<div class="td-error compact">' + esc(debugToolsData.simulateError) + '</div>';
    }
    if (debugToolsData.simulateResult || debugToolsData.simulateEvidence) {
      html += '<div class="debug-sim-result">';
      html += '<div class="debug-sim-result-head"><span>Simulation Result</span><div class="panel-actions">';
      html += '<button class="chat-msg-action" onclick="copyDebugSimulationEvidence()">Copy Evidence</button>';
      html += '<button class="chat-msg-action" onclick="exportDebugSimulationEvidence()">Export Evidence</button>';
      html += '<button class="chat-msg-action" onclick="createTaskFromDebugSimulationEvidence()">Create Task</button>';
      html += '</div></div>';
      html += '<div class="debug-sim-result-text">' + esc(debugToolsData.simulateResult || debugToolsData.simulateError || 'Simulation evidence captured.') + '</div>';
      html += '</div>';
    }
    html += renderDebugSimulationPanel();
    if (debugToolsData.envLoading) {
      html += '<div class="td-result-running"><div class="spinner"></div><span>Checking local commands...</span></div>';
    } else if (checks.length === 0) {
      html += '<div class="empty">Run an environment check before exporting or debugging provider startup.</div>';
    } else {
      html += '<div class="debug-summary"><span class="badge ' + (okCount === checks.length ? 'completed' : 'pending') + '">' + okCount + '/' + checks.length + ' available</span><span class="muted">bun / claude / codex / kimi / providers</span></div>';
      html += '<div class="debug-check-list">';
      for (var i = 0; i < checks.length; i++) {
        var check = checks[i];
        html += '<div class="debug-check-row">';
        html += '<span class="badge ' + (check.available ? 'completed' : 'failed') + '">' + (check.available ? 'ok' : 'miss') + '</span>';
        html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(check.name) + '</div>';
        html += '<div class="panel-row-sub">' + esc(check.command || '--') +
          (check.path ? ' · ' + esc(check.path) : '') +
          (check.version ? ' · ' + esc(shortText(check.version, 80)) : '') +
          (check.error ? ' · ' + esc(shortText(check.error, 80)) : '') +
          '</div></div><div class="panel-actions settings-row-actions">';
        html += '<button class="chat-msg-action" onclick="copyEnvCheckItem(' + i + ')">Copy</button>';
        html += '<button class="chat-msg-action" onclick="exportEnvCheckItem(' + i + ')">Export</button>';
        html += '<button class="chat-msg-action" onclick="createTaskFromEnvCheckItem(' + i + ')">Create Task</button>';
        html += '</div></div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderDebugSimulationPanel() {
    var recentTaskId = data && data.tasks && data.tasks.recent && data.tasks.recent[0] && data.tasks.recent[0].id || '';
    var html = '<div class="debug-sim-panel">';
    html += renderTaskIdDatalist();
    html += '<div class="diagnostic-section-title">Simulators</div>';
    html += '<div class="debug-sim-grid">';
    html += '<form class="debug-sim-card" onsubmit="simulateIncomingMessage(event)">';
    html += '<div class="panel-row-title">Incoming Message</div>';
    html += '<div class="form-grid compact">';
    html += '<label><span>Chat Type</span><select name="chat_type"><option value="p2p">p2p</option><option value="group">group</option></select></label>';
    html += '<label><span>Chat ID</span><input name="chat_id" placeholder="debug-p2p / debug-group"></label>';
    html += '<label><span>Group</span><input name="group_name" placeholder="Debug Group"></label>';
    html += '<label><span>Sender</span><input name="sender_name" placeholder="Debug User"></label>';
    html += '</div>';
    html += '<label class="form-wide"><span>Text</span><textarea name="text" rows="3" required placeholder="message to route through the normal Director handler"></textarea></label>';
    html += '<div class="form-actions"><button class="mini-btn primary" type="submit">' + (debugToolsData.simulateLoading ? 'Running...' : 'Simulate Message') + '</button></div>';
    html += '</form>';
    html += '<form class="debug-sim-card" onsubmit="simulateTaskCompletion(event)">';
    html += '<div class="panel-row-title">Task Completion</div>';
    html += '<div class="form-grid compact">';
    html += '<label><span>Task ID</span><input name="task_id" list="parse-task-options" required value="' + esc(recentTaskId) + '"></label>';
    html += '<label><span>Result</span><select name="success"><option value="true">success</option><option value="false">failure</option></select></label>';
    html += '<label><span>Director</span><select name="director_label">' + sourceDirectorOptions('main') + '</select></label>';
    html += '<label><span>Reply To</span><input name="reply_to_message_id" placeholder="optional message id"></label>';
    html += '</div>';
    html += '<div class="form-actions"><button class="mini-btn primary" type="submit">' + (debugToolsData.simulateLoading ? 'Running...' : 'Simulate Completion') + '</button></div>';
    html += '</form>';
    html += '</div>';
    html += '<div class="form-note">Simulators use the same local handlers as real events and write audit entries.</div>';
    html += '</div>';
    return html;
  }

  function filteredWsEvents() {
    var q = String(wsEventsData.query || '').trim().toLowerCase();
    var filter = wsEventsData.filter || 'all';
    return (wsEventsData.events || []).filter(function(event) {
      if (filter !== 'all' && event.type !== filter) return false;
      if (!q) return true;
      var haystack = [
        event.type,
        event.summary,
        event.payload ? JSON.stringify(event.payload) : '',
        event.raw,
      ].join('\n').toLowerCase();
      return haystack.indexOf(q) >= 0;
    });
  }

  function wsEventTypes() {
    var seen = {};
    var types = ['all'];
    for (var i = 0; i < wsEventsData.events.length; i++) {
      var type = wsEventsData.events[i].type || 'message';
      if (!seen[type]) {
        seen[type] = true;
        types.push(type);
      }
    }
    return types;
  }

  function wsBadgeClass(type) {
    if (type === 'open' || type === 'chat_reply' || type === 'command_result') return 'completed';
    if (type === 'close' || type === 'error' || type === 'parse-error') return 'failed';
    if (type === 'chunk') return 'running';
    return 'pending';
  }

  function selectedWsEvent(events) {
    var list = events || filteredWsEvents();
    if (wsEventsData.selectedId) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === wsEventsData.selectedId) return list[i];
      }
    }
    return list[0] || null;
  }

  function wsEventJson(event) {
    if (!event) return '';
    return JSON.stringify({
      id: event.id,
      at: event.at,
      type: event.type,
      summary: event.summary,
      target: wsEventTarget(event),
      payload: event.payload,
      raw: event.raw,
    }, null, 2);
  }

  function wsEventTarget(event) {
    var payload = event && event.payload || {};
    var director = payload && typeof payload.director === 'string' ? payload.director : '';
    if (!director && event && event.type === 'chat_reply') director = 'main';
    var taskId = '';
    if (payload && typeof payload.taskId === 'string') taskId = payload.taskId;
    else if (payload && typeof payload.task_id === 'string') taskId = payload.task_id;
    else if (payload && payload.result && typeof payload.result.taskId === 'string') taskId = payload.result.taskId;
    else if (payload && payload.task && typeof payload.task.id === 'string') taskId = payload.task.id;
    return {
      director: director || null,
      taskId: taskId || null,
    };
  }

  function wsEventsReport() {
    var visible = filteredWsEvents();
    var all = wsEventsData.events || [];
    var counts = {};
    var targets = {};
    for (var i = 0; i < visible.length; i++) {
      var event = visible[i];
      var type = event.type || 'message';
      counts[type] = (counts[type] || 0) + 1;
      var target = wsEventTarget(event);
      if (target.director) targets['director:' + target.director] = true;
      if (target.taskId) targets['task:' + target.taskId] = true;
    }
    return {
      exportedAt: new Date().toISOString(),
      filters: {
        type: wsEventsData.filter || 'all',
        query: wsEventsData.query || '',
      },
      summary: {
        visible: visible.length,
        captured: all.length,
        max: wsEventsData.max,
        selectedId: wsEventsData.selectedId || null,
        typeCounts: counts,
        targets: Object.keys(targets).sort(),
      },
      selected: selectedWsEvent(visible) ? JSON.parse(wsEventJson(selectedWsEvent(visible))) : null,
      events: visible.map(function(event) { return JSON.parse(wsEventJson(event)); }),
    };
  }

  function wsEventsTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench WebSocket event handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate or continue from the captured WebSocket evidence.',
      '- Review filters, selected event, target Director/task, payload, raw frame, and nearby visible events before acting.',
      '- If the event is an error, parse-error, stream abort, or suspicious state transition, identify the likely cause and propose or implement a scoped fix.',
      '- Preserve console safety boundaries; runtime or task mutations should still go through the existing approval paths.',
      '',
      'WebSocket event handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function createTaskFromWsEventsPayload(payload, label) {
    var report = payload && payload.report || null;
    var event = payload && payload.event || null;
    if (!event && !(report && report.events && report.events.length)) {
      showToast('WebSocket event evidence not found', false);
      return;
    }
    var target = event && event.target || report && report.selected && report.selected.target || {};
    var sourceDirector = target && target.director || 'main';
    var summary = event
      ? (event.type || 'event') + ': ' + (event.summary || event.id || 'selected event')
      : String(report.summary && report.summary.visible || 0) + ' visible events';
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: sourceDirector,
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate WebSocket events: ' + shortText(summary, 80),
      prompt: wsEventsTaskPromptPayload({ type: label || 'webSocketEvents', evidence: payload }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('WebSocket event handoff loaded into task form', true);
  }

  function renderWsEventInspector(event) {
    if (!event) return '<div class="empty compact">Select a WebSocket event to inspect payload and raw data.</div>';
    var payloadText = event.payload == null ? '' : JSON.stringify(event.payload, null, 2);
    var rawText = event.raw || '';
    var target = wsEventTarget(event);
    var html = '<div class="ws-event-inspector">';
    html += '<div class="ws-event-inspector-head"><span class="badge ' + wsBadgeClass(event.type) + '">' + esc(event.type || 'event') + '</span><span class="muted mono">' + esc(fmtTimestamp(event.at)) + '</span><div class="ws-event-actions">';
    if (target.director) html += '<button class="mini-btn" onclick="openSelectedWsDirector()">Open Director</button>';
    if (target.taskId) html += '<button class="mini-btn" onclick="openSelectedWsTask()">Open Task</button>';
    html += '<button class="mini-btn" onclick="copySelectedWsEvent()">Copy Event</button><button class="mini-btn" onclick="copySelectedWsPayload()">Copy Payload</button><button class="mini-btn" onclick="copySelectedWsRaw()">Copy Raw</button><button class="mini-btn" onclick="exportSelectedWsEvent()">Export Event</button><button class="mini-btn primary" onclick="createTaskFromSelectedWsEvent()">Create Task</button></div></div>';
    html += '<div class="ws-event-summary selected">' + esc(event.summary || '') + '</div>';
    html += '<div class="ws-event-payload-grid">';
    html += '<div><div class="diagnostic-section-title">Payload</div><pre class="ws-event-payload">' + esc(payloadText || 'null') + '</pre></div>';
    html += '<div><div class="diagnostic-section-title">Raw</div><pre class="ws-event-payload">' + esc(rawText || '--') + '</pre></div>';
    html += '</div></div>';
    return html;
  }

  function renderWsEventViewerPanel() {
    var events = filteredWsEvents();
    var types = wsEventTypes();
    var selected = selectedWsEvent(events);
    if (selected && wsEventsData.selectedId !== selected.id) wsEventsData.selectedId = selected.id;
    var html = '<div class="workbench-panel ws-events-panel">';
    html += '<div class="panel-title"><span>WebSocket Events</span><div class="panel-actions">';
    html += '<button class="mini-btn" onclick="copyWsEvents()">Copy</button>';
    html += '<button class="mini-btn" onclick="exportWsEvents()">Export</button>';
    html += '<button class="mini-btn" onclick="copyWsEventsReport()">Copy Report</button>';
    html += '<button class="mini-btn" onclick="exportWsEventsReport()">Export Report</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromWsEventsReport()">Create Task</button>';
    html += '<button class="mini-btn danger" onclick="clearWsEvents()">Clear</button>';
    html += '</div></div>';
    html += '<div class="logs-controls ws-events-controls">';
    html += '<label><span>Search</span><input value="' + esc(wsEventsData.query || '') + '" placeholder="event text" oninput="setWsEventFilter(\'query\', this.value)"></label>';
    html += '<label><span>Type</span><select onchange="setWsEventFilter(\'filter\', this.value)">';
    for (var i = 0; i < types.length; i++) {
      html += '<option value="' + esc(types[i]) + '"' + (wsEventsData.filter === types[i] ? ' selected' : '') + '>' + esc(types[i]) + '</option>';
    }
    html += '</select></label></div>';
    if (events.length === 0) {
      html += '<div class="empty">No WebSocket events captured yet.</div>';
    } else {
      html += '<div class="ws-event-list">';
      for (var ei = 0; ei < events.length; ei++) {
        var event = events[ei];
        html += '<div class="ws-event-row clickable' + (selected && selected.id === event.id ? ' selected' : '') + '" onclick="selectWsEvent(\'' + jsq(event.id) + '\')">';
        html += '<div class="ws-event-head"><span class="badge ' + wsBadgeClass(event.type) + '">' + esc(event.type) + '</span><span class="muted">' + esc(fmtTimestamp(event.at)) + '</span></div>';
        html += '<div class="ws-event-summary">' + esc(event.summary || '') + '</div>';
        html += '</div>';
      }
      html += '</div>';
      html += renderWsEventInspector(selected);
    }
    html += '</div>';
    return html;
  }

  function setDebugSimulationState(patch) {
    debugToolsData.simulateLoading = !!patch.loading;
    debugToolsData.simulateError = patch.error || null;
    debugToolsData.simulateResult = patch.result || null;
    if (Object.prototype.hasOwnProperty.call(patch, 'evidence')) {
      debugToolsData.simulateEvidence = patch.evidence || null;
    } else if (patch.loading) {
      debugToolsData.simulateEvidence = null;
    }
    if (viewMode === 'observability') renderObservabilityView();
  }

  async function runDebugIncomingSimulation(payload) {
    setDebugSimulationState({ loading: true });
    try {
      var res = await fetch('/api/debug/simulate-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var body = await res.json().catch(function() { return {}; });
      if (!res.ok || body.error || body.ok === false) throw new Error(body.error || 'simulate message failed');
      var result = 'Simulated message ' + (body.message_id || '') + ' via ' + (body.handlers || 0) + ' handler(s).';
      setDebugSimulationState({ loading: false, result: result, evidence: {
        type: 'incoming_message',
        ok: true,
        at: new Date().toISOString(),
        auditAction: 'debug.simulate_message',
        request: payload,
        response: body,
        result: result,
      }});
      loadAuditLog();
      showToast('Incoming message simulated', true);
    } catch (err) {
      setDebugSimulationState({ loading: false, error: String(err.message || err), evidence: {
        type: 'incoming_message',
        ok: false,
        at: new Date().toISOString(),
        auditAction: 'debug.simulate_message',
        request: payload,
        error: String(err.message || err),
      }});
      showToast('Simulation failed: ' + err.message, false);
      throw err;
    }
  }

  async function runDebugTaskCompletionSimulation(payload) {
    setDebugSimulationState({ loading: true });
    try {
      var res = await fetch('/api/debug/simulate-task-completion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var body = await res.json().catch(function() { return {}; });
      if (!res.ok || body.error || body.ok === false) throw new Error(body.error || 'simulate task completion failed');
      var result = 'Simulated ' + (body.success ? 'success' : 'failure') + ' for ' + body.task_id + ' on ' + body.director_label + '.';
      setDebugSimulationState({ loading: false, result: result, evidence: {
        type: 'task_completion',
        ok: true,
        at: new Date().toISOString(),
        auditAction: 'debug.simulate_task_completion',
        request: payload,
        response: body,
        result: result,
      }});
      loadAuditLog();
      showToast('Task completion simulated', true);
    } catch (err) {
      setDebugSimulationState({ loading: false, error: String(err.message || err), evidence: {
        type: 'task_completion',
        ok: false,
        at: new Date().toISOString(),
        auditAction: 'debug.simulate_task_completion',
        request: payload,
        error: String(err.message || err),
      }});
      showToast('Simulation failed: ' + err.message, false);
      throw err;
    }
  }

  function debugSimulationEvidencePayload() {
    var evidence = debugToolsData.simulateEvidence || null;
    var auditAction = evidence && evidence.auditAction || '';
    var relatedAudit = (auditData.entries || []).filter(function(entry) {
      return !auditAction || entry && entry.action === auditAction;
    }).slice(0, 10);
    return {
      exportedAt: new Date().toISOString(),
      loading: !!debugToolsData.simulateLoading,
      result: debugToolsData.simulateResult || null,
      error: debugToolsData.simulateError || null,
      evidence: evidence,
      relatedAudit: {
        action: auditAction || null,
        loadedEntries: relatedAudit.length,
        entries: relatedAudit,
      },
      runtime: {
        connected: !!wsConnected,
        lastReceivedAt: lastRecvAt ? new Date(lastRecvAt).toISOString() : null,
        selectedDirector: selectedPoolLabel || 'main',
        activeSessionId: activeRuntimeSessionId(),
        tasksLoaded: data && data.tasks && data.tasks.recent ? data.tasks.recent.length : 0,
        pendingApprovals: (dangerApprovalQueue || []).length,
      },
    };
  }

  function debugSimulationTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench debug simulation handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate or continue from this local debug simulation result.',
      '- Review the simulated event type, request payload, response/error, related audit entries, runtime connection state, selected Director, and pending approvals.',
      '- If the simulation failed or produced suspicious behavior, identify the likely cause and propose or implement a scoped fix.',
      '- Preserve local safety boundaries; future simulations or task mutations should still go through existing approval paths.',
      '',
      'Debug simulation handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function debugSimulationTaskDescription(payload) {
    var evidence = payload && payload.evidence || {};
    var type = evidence.type || 'simulation';
    var request = evidence.request || {};
    if (type === 'task_completion') {
      return 'Investigate simulated task completion: ' + (request.task_id || 'task') + ' · ' + (evidence.ok ? 'ok' : 'failed');
    }
    if (type === 'incoming_message') {
      return 'Investigate simulated incoming message: ' + shortText(request.text || request.chat_id || request.chat_type || 'message', 80);
    }
    return 'Investigate debug simulation: ' + (evidence.ok ? 'ok' : 'failed');
  }

  window.copyDebugSimulationEvidence = function() {
    if (!debugToolsData.simulateEvidence && !debugToolsData.simulateResult && !debugToolsData.simulateError) {
      showToast('No simulation evidence to copy', false);
      return;
    }
    copyText(JSON.stringify(debugSimulationEvidencePayload(), null, 2));
  };

  window.exportDebugSimulationEvidence = function() {
    if (!debugToolsData.simulateEvidence && !debugToolsData.simulateResult && !debugToolsData.simulateError) {
      showToast('No simulation evidence to export', false);
      return;
    }
    var evidence = debugToolsData.simulateEvidence || {};
    downloadTextFile('persona-debug-simulation-' + safeAssetName(evidence.type || 'simulation', 'simulation') + '-' + Date.now() + '.json', JSON.stringify(debugSimulationEvidencePayload(), null, 2));
    showToast('Simulation evidence exported', true);
  };

  window.createTaskFromDebugSimulationEvidence = function() {
    if (!debugToolsData.simulateEvidence && !debugToolsData.simulateResult && !debugToolsData.simulateError) {
      showToast('No simulation evidence to turn into a task', false);
      return;
    }
    var payload = debugSimulationEvidencePayload();
    var evidence = payload.evidence || {};
    var request = evidence.request || {};
    var sourceDirector = request.director_label || payload.runtime && payload.runtime.selectedDirector || 'main';
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: sourceDirector,
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: debugSimulationTaskDescription(payload),
      prompt: debugSimulationTaskPromptPayload({
        type: 'debugSimulationEvidence',
        simulation: payload,
        relatedTask: request.task_id ? diagnosticTaskRecord(request.task_id) : null,
        snapshot: snapshotReportPayload(),
      }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Simulation handoff loaded into task form', true);
  };

  window.simulateIncomingMessage = async function(event) {
    event.preventDefault();
    var form = event.target;
    var fd = new FormData(form);
    var text = String(fd.get('text') || '').trim();
    if (!text) {
      showToast('Message text is required', false);
      return;
    }
    var payload = {
      text: text,
      chat_type: String(fd.get('chat_type') || 'p2p'),
      chat_id: String(fd.get('chat_id') || '').trim() || undefined,
      group_name: String(fd.get('group_name') || '').trim() || undefined,
      sender_name: String(fd.get('sender_name') || '').trim() || undefined,
    };
    queueDangerApproval({
      title: 'Simulate incoming message',
      target: payload.chat_id || payload.group_name || payload.chat_type,
      detail: shortText(payload.text, 180),
      severity: 'medium',
      payload: payload,
    }, async function() {
      await runDebugIncomingSimulation(payload);
    });
  };

  window.simulateTaskCompletion = async function(event) {
    event.preventDefault();
    var form = event.target;
    var fd = new FormData(form);
    var taskId = String(fd.get('task_id') || '').trim();
    if (!taskId) {
      showToast('Task ID is required', false);
      return;
    }
    var payload = {
      task_id: taskId,
      success: String(fd.get('success') || 'true') === 'true',
      director_label: String(fd.get('director_label') || 'main'),
      reply_to_message_id: String(fd.get('reply_to_message_id') || '').trim() || undefined,
    };
    queueDangerApproval({
      title: 'Simulate task completion',
      target: taskId,
      detail: (payload.success ? 'success' : 'failure') + ' on ' + payload.director_label,
      severity: 'medium',
      payload: payload,
    }, async function() {
      await runDebugTaskCompletionSimulation(payload);
    });
  };

  function snapshotPayload() {
    return {
      connected: wsConnected,
      lastReceivedAt: lastRecvAt ? fmtTimestamp(lastRecvAt) : null,
      viewMode: viewMode,
      selectedDirector: selectedPoolLabel || 'main',
      data: data || null,
    };
  }

  function snapshotJson() {
    return JSON.stringify(snapshotPayload(), null, 2);
  }

  function snapshotReportPayload() {
    var snapshot = snapshotPayload();
    var runtime = runtimeSnapshotPayload();
    var pool = data && data.pool || [];
    var context = data && data.context || {};
    var tasks = data && data.tasks || {};
    var wsReport = wsEventsReport();
    return {
      exportedAt: new Date().toISOString(),
      connection: {
        connected: !!wsConnected,
        lastReceivedAt: snapshot.lastReceivedAt,
        lastReceivedAgo: lastRecvAt ? fmtAgo(lastRecvAt) : '--',
      },
      view: {
        mode: viewMode,
        selectedDirector: selectedPoolLabel || 'main',
        selectedSessionId: selectedSessionId || null,
        selectedTaskId: selectedTaskId || null,
      },
      runtimeSummary: {
        directorAlive: !!(data && data.system && data.system.directorAlive),
        mainSessionId: data && data.system && data.system.sessionId || null,
        mainProvider: data && data.system && (data.system.directorAgentName || data.system.directorAgentType) || null,
        personaRole: data && data.system && data.system.personaRole || null,
        activity: data && data.activity && data.activity.state || null,
        queueLength: data && data.queue ? data.queue.length : 0,
        poolTotal: pool.length,
        poolAlive: pool.filter(function(item) { return item && item.alive; }).length,
        poolClosed: pool.filter(function(item) { return item && item.closed; }).length,
        activeWork: runtime.activeWork && runtime.activeWork.summary || null,
      },
      context: {
        tokens: context.tokens == null ? null : context.tokens,
        limit: context.limit == null ? null : context.limit,
        percent: context.percent == null ? null : context.percent,
        live: context.live == null ? null : !!context.live,
      },
      tasks: {
        summary: tasks.summary || null,
        recentCount: tasks.recent ? tasks.recent.length : 0,
      },
      websocket: wsReport.summary,
      snapshot: snapshot,
    };
  }

  function snapshotTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench snapshot handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate or continue from the current Workbench snapshot report.',
      '- Review connection health, Runtime summary, context window state, task summary, WebSocket summary, and selected view/targets before acting.',
      '- If the snapshot shows an offline console, stale context, queue pressure, dead Director, or task/WebSocket anomalies, identify the likely cause and propose or implement a scoped fix.',
      '- Preserve the current runtime and approval boundaries unless the task prompt is edited.',
      '',
      'Snapshot handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function snapshotTaskWarnings(report) {
    var warnings = [];
    var runtime = report && report.runtimeSummary || {};
    var context = report && report.context || {};
    var websocket = report && report.websocket || {};
    var tasks = report && report.tasks && report.tasks.summary || {};
    if (report && report.connection && !report.connection.connected) warnings.push('console websocket is offline');
    if (runtime && runtime.directorAlive === false) warnings.push('main director is not alive');
    if (Number(runtime.queueLength || 0) > 0) warnings.push(String(runtime.queueLength) + ' runtime queue item(s)');
    if (context.live === false) warnings.push('context snapshot is stale');
    if (context.percent != null && Number(context.percent) >= 80) warnings.push('context window is above 80%');
    if (Number(tasks.failed || 0) > 0) warnings.push(String(tasks.failed) + ' failed task(s)');
    if (websocket && websocket.typeCounts && (websocket.typeCounts.error || websocket.typeCounts['parse-error'])) warnings.push('websocket error events captured');
    return warnings;
  }

  function renderSnapshotPanel() {
    var json = snapshotJson();
    var report = snapshotReportPayload();
    var html = '<div class="workbench-panel snapshot-panel">';
    html += '<div class="panel-title"><span>Snapshot JSON</span><div class="panel-actions">';
    html += '<button class="mini-btn" onclick="copySnapshotReport()">Copy Report</button>';
    html += '<button class="mini-btn" onclick="exportSnapshotReport()">Export Report</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromSnapshotReport()">Create Task</button>';
    html += '<button class="mini-btn" onclick="copySnapshotJson()">Copy</button>';
    html += '<button class="mini-btn" onclick="exportSnapshotJson()">Export</button>';
    html += '</div></div>';
    html += '<div class="snapshot-meta"><span class="badge ' + (wsConnected ? 'completed' : 'failed') + '">' + (wsConnected ? 'connected' : 'offline') + '</span><span>last ' + esc(fmtAgo(lastRecvAt)) + '</span><span>' + esc(String(report.runtimeSummary.poolAlive || 0)) + '/' + esc(String(report.runtimeSummary.poolTotal || 0)) + ' pool alive</span><span>' + esc(String(report.runtimeSummary.queueLength || 0)) + ' queued</span></div>';
    html += '<pre class="snapshot-json">' + esc(json) + '</pre>';
    html += '</div>';
    return html;
  }

  window.setApiExplorerPath = function(path) {
    apiExplorerData.path = String(path || '');
    if (viewMode === 'observability') renderObservabilityView();
  };

  window.setApiExplorerMethod = function(method) {
    apiExplorerData.method = ['GET', 'POST', 'PUT', 'DELETE'].indexOf(String(method || '').toUpperCase()) >= 0 ? String(method).toUpperCase() : 'GET';
    if (viewMode === 'observability') renderObservabilityView();
  };

  window.setApiExplorerBody = function(body) {
    apiExplorerData.body = String(body || '');
  };

  window.setApiExplorerPreset = function(method, path, body) {
    apiExplorerData.method = String(method || 'GET').toUpperCase();
    apiExplorerData.path = String(path || '');
    apiExplorerData.body = String(body || '');
    apiExplorerData.result = null;
    if (viewMode === 'observability') renderObservabilityView();
  };

  function apiExplorerRequestOptions(method) {
    var options = { method: method };
    if (method !== 'GET') {
      var raw = String(apiExplorerData.body || '').trim();
      if (raw) {
        try {
          options.body = JSON.stringify(JSON.parse(raw));
        } catch (_) {
          throw new Error('JSON body is invalid');
        }
      }
      options.headers = { 'Content-Type': 'application/json' };
    }
    return options;
  }

  function apiExplorerRequestBody(method) {
    if (method === 'GET') return null;
    var raw = String(apiExplorerData.body || '').trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return raw;
    }
  }

  function apiExplorerReport(result) {
    var r = result || apiExplorerData.result;
    if (!r) return null;
    return {
      exportedAt: new Date().toISOString(),
      request: {
        at: r.at || null,
        method: r.method,
        path: r.path,
        body: r.requestBody == null ? null : r.requestBody,
        curl: apiExplorerCurlCommand(r),
      },
      response: {
        ok: !!r.ok,
        status: r.status,
        durationMs: r.durationMs || 0,
        body: r.body || '',
      },
    };
  }

  function shellQuote(value) {
    return "'" + String(value == null ? '' : value).replace(/'/g, "'\"'\"'") + "'";
  }

  function apiExplorerCurlCommand(result) {
    var r = result || apiExplorerData.result;
    if (!r) return '';
    var method = String(r.method || 'GET').toUpperCase();
    var url = String(r.path || '/');
    if (url[0] === '/') url = location.origin + url;
    var parts = ['curl', '-i', '-X', shellQuote(method), shellQuote(url)];
    if (method !== 'GET') {
      parts.push('-H', shellQuote('Content-Type: application/json'));
      if (r.requestBody != null) {
        var body = typeof r.requestBody === 'string' ? r.requestBody : JSON.stringify(r.requestBody);
        parts.push('--data', shellQuote(body));
      }
    }
    return parts.join(' ');
  }

  function apiExplorerTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench API Explorer handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate or continue from this local Console API request and response.',
      '- Review request method/path/body, response status/body, duration, and cURL before acting.',
      '- If the response failed or looks suspicious, identify the likely cause and propose or implement a scoped fix.',
      '- Preserve API safety boundaries; non-GET mutations should still go through the existing approval paths.',
      '',
      'API Explorer handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function apiExplorerHistoryTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench API Explorer history as task context.',
      '',
      'Operator intent:',
      '- Review recent Console API requests as a batch, not only one request.',
      '- Identify repeated failures, suspicious mutations, slow endpoints, inconsistent responses, or missing safety coverage.',
      '- Compare request method/path/body, response status/body, duration, cURL, runtime snapshot, and approval context before acting.',
      '- Preserve API safety boundaries; non-GET mutations should still go through the existing approval paths.',
      '',
      'API Explorer history handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function apiExplorerHistoryReport() {
    var history = apiExplorerData.history || [];
    var reports = history.map(function(item) { return apiExplorerReport(item); }).filter(Boolean);
    var failures = history.filter(function(item) { return !item.ok; }).length;
    var slowest = history.slice().sort(function(a, b) { return Number(b.durationMs || 0) - Number(a.durationMs || 0); })[0] || null;
    return {
      exportedAt: new Date().toISOString(),
      count: history.length,
      failures: failures,
      current: apiExplorerReport(),
      slowest: slowest ? apiExplorerReport(slowest) : null,
      history: reports,
    };
  }

  function createTaskFromApiExplorerReport(report, label) {
    if (!report) {
      showToast('API Explorer report not found', false);
      return;
    }
    var request = report.request || {};
    var response = report.response || {};
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: (response.ok ? 'Review API response: ' : 'Investigate API failure: ') + shortText((request.method || 'GET') + ' ' + (request.path || label || '/'), 80),
      prompt: apiExplorerTaskPromptPayload({ type: 'apiExplorerRequest', label: label || 'current', report: report, historyCount: (apiExplorerData.history || []).length }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('API Explorer handoff loaded into task form', true);
  }

  function rememberApiExplorerResult(result) {
    apiExplorerData.history = [result].concat(apiExplorerData.history || []).slice(0, 8);
  }

  async function executeApiExplorerRequest(path, method) {
    apiExplorerData.loading = true;
    apiExplorerData.result = null;
    renderObservabilityView();
    var started = Date.now();
    var requestBody = apiExplorerRequestBody(method);
    try {
      var res = await fetch(path, apiExplorerRequestOptions(method));
      var text = await res.text();
      var body = text;
      try {
        body = JSON.stringify(JSON.parse(text), null, 2);
      } catch (_) {
        // keep plain text
      }
      if (body.length > 20000) body = body.slice(0, 20000) + '\n... truncated ...';
      apiExplorerData.result = { at: new Date(started).toISOString(), ok: res.ok, status: res.status, durationMs: Date.now() - started, method: method, path: path, requestBody: requestBody, body: body };
    } catch (err) {
      apiExplorerData.result = { at: new Date(started).toISOString(), ok: false, status: 'ERR', durationMs: Date.now() - started, method: method, path: path, requestBody: requestBody, body: String(err && err.message || err) };
    } finally {
      rememberApiExplorerResult(apiExplorerData.result);
      apiExplorerData.loading = false;
      if (viewMode === 'observability') renderObservabilityView();
    }
  }

  window.runApiExplorer = function() {
    var path = String(apiExplorerData.path || '').trim();
    if (!path || path[0] !== '/' || path.startsWith('//')) {
      showToast('API path must start with /', false);
      return;
    }
    var method = (apiExplorerData.method || 'GET').toUpperCase();
    if (['GET', 'POST', 'PUT', 'DELETE'].indexOf(method) < 0) {
      showToast('Unsupported method', false);
      return;
    }
    try {
      apiExplorerRequestOptions(method);
    } catch (err) {
      showToast(err.message || String(err), false);
      return;
    }
    if (method === 'GET') {
      executeApiExplorerRequest(path, method);
      return;
    }
    queueDangerApproval({
      title: 'API Explorer ' + method,
      target: path,
      detail: 'Run a local console API request with the supplied JSON body.',
      severity: method === 'DELETE' ? 'critical' : 'medium',
      payload: { method: method, path: path, body: apiExplorerRequestBody(method) },
    }, async function() {
      await executeApiExplorerRequest(path, method);
    });
  };

  window.copyApiExplorerResult = function() {
    if (!apiExplorerData.result) return;
    copyText(apiExplorerData.result.body || '');
  };

  window.copyApiExplorerReport = function() {
    var report = apiExplorerReport();
    if (!report) return;
    copyText(JSON.stringify(report, null, 2));
  };

  window.exportApiExplorerReport = function() {
    var report = apiExplorerReport();
    if (!report) return;
    downloadTextFile('persona-api-explorer-' + Date.now() + '.json', JSON.stringify(report, null, 2));
    showToast('API report exported', true);
  };

  window.copyApiExplorerHistoryReport = function() {
    var report = apiExplorerHistoryReport();
    if (!report.count) {
      showToast('No API history to copy', false);
      return;
    }
    copyText(JSON.stringify(report, null, 2));
  };

  window.exportApiExplorerHistoryReport = function() {
    var report = apiExplorerHistoryReport();
    if (!report.count) {
      showToast('No API history to export', false);
      return;
    }
    downloadTextFile('persona-api-explorer-history-report-' + Date.now() + '.json', JSON.stringify(report, null, 2));
    showToast('API history report exported', true);
  };

  window.createTaskFromApiExplorerHistoryReport = function() {
    var report = apiExplorerHistoryReport();
    if (!report.count) {
      showToast('No API history to turn into a task', false);
      return;
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'apiExplorerHistory',
      report: report,
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review API Explorer history: ' + String(report.count || 0) + ' request(s) · ' + String(report.failures || 0) + ' failed',
      prompt: apiExplorerHistoryTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('API history loaded into task form', true);
  };

  window.createTaskFromApiExplorerResult = function() {
    createTaskFromApiExplorerReport(apiExplorerReport(), 'current');
  };

  window.copyApiExplorerCurl = function() {
    var curl = apiExplorerCurlCommand();
    if (!curl) {
      showToast('No API request to copy', false);
      return;
    }
    copyText(curl);
  };

  window.replayApiExplorerHistory = function(index) {
    var item = (apiExplorerData.history || [])[index];
    if (!item) return;
    apiExplorerData.method = item.method || 'GET';
    apiExplorerData.path = item.path || '/';
    apiExplorerData.body = item.requestBody == null ? '' : JSON.stringify(item.requestBody, null, 2);
    runApiExplorer();
  };

  window.copyApiExplorerHistory = function(index) {
    var item = (apiExplorerData.history || [])[index];
    var report = apiExplorerReport(item);
    if (!report) return;
    copyText(JSON.stringify(report, null, 2));
  };

  window.copyApiExplorerHistoryCurl = function(index) {
    var item = (apiExplorerData.history || [])[index];
    var curl = apiExplorerCurlCommand(item);
    if (!curl) {
      showToast('API history item not found', false);
      return;
    }
    copyText(curl);
  };

  window.exportApiExplorerHistory = function(index) {
    var item = (apiExplorerData.history || [])[index];
    var report = apiExplorerReport(item);
    if (!report) return;
    downloadTextFile('persona-api-explorer-history-' + Date.now() + '.json', JSON.stringify(report, null, 2));
    showToast('API history exported', true);
  };

  window.createTaskFromApiExplorerHistory = function(index) {
    var item = (apiExplorerData.history || [])[index];
    createTaskFromApiExplorerReport(apiExplorerReport(item), 'history #' + String(index + 1));
  };

  window.copyRuntimeEventHistory = function() {
    var payload = runtimeEventHistoryPayload();
    if (!payload.events.length) {
      showToast('No runtime events to copy', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportRuntimeEventHistory = function() {
    var payload = runtimeEventHistoryPayload();
    if (!payload.events.length) {
      showToast('No runtime events to export', false);
      return;
    }
    downloadTextFile('persona-runtime-events-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Runtime events exported', true);
  };

  window.copyRuntimeEvent = function(index) {
    var payload = runtimeEventPayload(index);
    if (!payload.event) {
      showToast('Runtime event not found', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportRuntimeEvent = function(index) {
    var payload = runtimeEventPayload(index);
    if (!payload.event) {
      showToast('Runtime event not found', false);
      return;
    }
    var safe = String(payload.event.type || 'event').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-runtime-event-' + safe + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Runtime event exported', true);
  };

  window.createTaskFromRuntimeEventHistory = function() {
    var payload = runtimeEventHistoryPayload();
    createTaskFromRuntimeEventPayload({ history: payload }, 'runtimeEventHistory');
  };

  window.createTaskFromRuntimeEvent = function(index) {
    var payload = runtimeEventPayload(index);
    createTaskFromRuntimeEventPayload(payload, 'runtimeEvent');
  };

  window.openRuntimeEventDirector = function(index) {
    var payload = runtimeEventPayload(index);
    var event = payload.event;
    if (!event || !event.label) {
      showToast('Runtime event director not found', false);
      return;
    }
    if (event.label === 'main') {
      selectSession(null);
    } else {
      selectPoolDirector(event.label, event.name || event.label);
    }
  };

  function diagnosticsPayload() {
    return {
      exportedAt: new Date().toISOString(),
      ok: !!diagnosticsData.summary,
      summary: diagnosticsData.summary || null,
      error: diagnosticsData.error || null,
      loading: !!diagnosticsData.loading,
      window: diagnosticsData.summary && diagnosticsData.summary.window || null,
      websocket: {
        connected: !!wsConnected,
        recentEvents: (wsEventsData.events || []).slice(0, 25),
      },
      snapshot: {
        tasks: data && data.tasks && data.tasks.summary || null,
        metrics: data && data.metrics || null,
        directors: runtimeDirectorSnapshots(data && data.system || {}, data && data.pool || [], data && data.activity || {}),
      },
    };
  }

  function diagnosticErrors() {
    return diagnosticsData.summary && Array.isArray(diagnosticsData.summary.errors) ? diagnosticsData.summary.errors : [];
  }

  function firstDiagnosticSource(err, prefix) {
    var sources = err && Array.isArray(err.sources) ? err.sources : [];
    for (var i = 0; i < sources.length; i++) {
      var source = String(sources[i] || '');
      if (source.indexOf(prefix) === 0) return source.slice(prefix.length);
    }
    return '';
  }

  function firstDiagnosticTaskId(err) {
    return firstDiagnosticSource(err, 'task:');
  }

  function firstDiagnosticLogLabel(err) {
    return firstDiagnosticSource(err, 'log:');
  }

  function diagnosticLogSourceId(label) {
    var sources = logsData.sources || [];
    for (var i = 0; i < sources.length; i++) {
      if (sources[i].id === label || sources[i].label === label) return sources[i].id;
    }
    return '';
  }

  function diagnosticErrorPayload(index) {
    var err = diagnosticErrors()[index];
    var taskId = firstDiagnosticTaskId(err);
    var logLabel = firstDiagnosticLogLabel(err);
    return {
      exportedAt: new Date().toISOString(),
      index: index,
      error: err || null,
      source: {
        taskId: taskId || null,
        logLabel: logLabel || null,
        logSourceId: logLabel ? diagnosticLogSourceId(logLabel) || null : null,
        searchQuery: err && err.message ? shortText(err.message, 120).trim() : '',
      },
      diagnostics: diagnosticsData.summary ? {
        window: diagnosticsData.summary.window || null,
        health: diagnosticsData.summary.health || null,
      } : null,
      snapshot: {
        tasks: data && data.tasks && data.tasks.summary || null,
        metrics: data && data.metrics || null,
        directors: runtimeDirectorSnapshots(data && data.system || {}, data && data.pool || [], data && data.activity || {}),
      },
    };
  }

  function diagnosticTaskRecord(taskId) {
    if (!taskId) return null;
    var sources = [];
    if (data && data.tasks && data.tasks.recent) sources = sources.concat(data.tasks.recent);
    if (taskCenterData.tasks) sources = sources.concat(taskCenterData.tasks);
    if (taskDetail && taskDetail.id === taskId) sources.push(taskDetail);
    for (var i = 0; i < sources.length; i++) {
      if (sources[i] && sources[i].id === taskId) return sources[i];
    }
    return null;
  }

  function diagnosticErrorTaskPrompt(payload) {
    return [
      'Use the following Observability diagnostic error handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate the error, identify the likely root cause, and propose or implement a concrete fix.',
      '- Use source.taskId, source.logSourceId, diagnostics.window, health, and runtime snapshot as evidence.',
      '- If code changes are needed, keep them scoped and verify with the repository checks.',
      '',
      'Diagnostic error handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function activeCronDiagnostics() {
    var items = diagnosticsData.summary && Array.isArray(diagnosticsData.summary.cronStats) ? diagnosticsData.summary.cronStats : [];
    return items.filter(function(item) { return item && (item.total > 0 || item.failed > 0); });
  }

  function cronDiagnosticsPayload() {
    var active = activeCronDiagnostics();
    return {
      exportedAt: new Date().toISOString(),
      generatedAt: diagnosticsData.summary && diagnosticsData.summary.generatedAt || null,
      window: diagnosticsData.summary && diagnosticsData.summary.window || null,
      count: active.length,
      items: active,
      summary: {
        totalRuns: active.reduce(function(sum, item) { return sum + Number(item.total || 0); }, 0),
        failedRuns: active.reduce(function(sum, item) { return sum + Number(item.failed || 0); }, 0),
        runningRuns: active.reduce(function(sum, item) { return sum + Number(item.running || 0); }, 0),
      },
      snapshot: {
        tasks: data && data.tasks && data.tasks.summary || null,
        cronJobs: cronJobs || [],
      },
    };
  }

  function cronDiagnosticItemPayload(index) {
    var item = activeCronDiagnostics()[index];
    var jobs = cronJobs || [];
    var job = item && item.id ? jobs.find(function(cron) { return cron.id === item.id; }) || null : null;
    return {
      exportedAt: new Date().toISOString(),
      index: index,
      item: item || null,
      job: job,
      diagnostics: diagnosticsData.summary ? {
        generatedAt: diagnosticsData.summary.generatedAt || null,
        window: diagnosticsData.summary.window || null,
        health: diagnosticsData.summary.health || null,
      } : null,
    };
  }

  function cronDiagnosticTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench cron diagnostics handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate automation health using the diagnostics failure-rate evidence.',
      '- Review the diagnostics window, failed/running/total counts, linked Cron job configuration, recent task filters, and runtime snapshot.',
      '- If a Cron job is failing, stale, or noisy, identify the likely cause and propose or implement a scoped fix.',
      '- Preserve existing schedule/action semantics unless the task prompt is edited.',
      '',
      'Cron diagnostics handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function createTaskFromCronDiagnosticPayload(payload, description, sourceDirector) {
    if (!payload) {
      showToast('Cron diagnostics evidence not found', false);
      return;
    }
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: sourceDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: shortText(description || 'Investigate cron diagnostics', 120),
      prompt: cronDiagnosticTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Cron diagnostics handoff loaded into task form', true);
  }

  window.openCronDiagnosticTasks = function(index) {
    var item = activeCronDiagnostics()[index];
    if (!item || !item.id) {
      showToast('Cron diagnostic item not found', false);
      return;
    }
    openCronRunsInTasks(item.id);
  };

  function diagnosticRateItems(kind) {
    var summary = diagnosticsData.summary || {};
    var source = kind === 'role' ? summary.roleStats : summary.providerStats;
    return Array.isArray(source) ? source : [];
  }

  function enrichDiagnosticRateItems(items) {
    var rows = Array.isArray(items) ? items : [];
    var totalTasks = rows.reduce(function(sum, item) { return sum + Number(item && item.total || 0); }, 0);
    var totalCost = rows.reduce(function(sum, item) { return sum + Number(item && item.costUsd || 0); }, 0);
    return rows.map(function(item) {
      var copy = Object.assign({}, item || {});
      copy.taskShare = totalTasks > 0 ? Math.round((Number(copy.total || 0) / totalTasks) * 1000) / 10 : 0;
      copy.costShare = totalCost > 0 ? Math.round((Number(copy.costUsd || 0) / totalCost) * 1000) / 10 : 0;
      return copy;
    });
  }

  function diagnosticRatePayload(kind) {
    var safeKind = kind === 'role' ? 'role' : 'provider';
    var items = enrichDiagnosticRateItems(diagnosticRateItems(safeKind));
    return {
      exportedAt: new Date().toISOString(),
      generatedAt: diagnosticsData.summary && diagnosticsData.summary.generatedAt || null,
      kind: safeKind,
      label: safeKind === 'role' ? 'Role Usage' : 'Provider Usage',
      window: diagnosticsData.summary && diagnosticsData.summary.window || null,
      health: diagnosticsData.summary && diagnosticsData.summary.health || null,
      count: items.length,
      items: items,
      summary: {
        totalTasks: items.reduce(function(sum, item) { return sum + Number(item.total || 0); }, 0),
        completedTasks: items.reduce(function(sum, item) { return sum + Number(item.completed || 0); }, 0),
        failedTasks: items.reduce(function(sum, item) { return sum + Number(item.failed || 0); }, 0),
        runningTasks: items.reduce(function(sum, item) { return sum + Number(item.running || 0); }, 0),
        costUsd: Number(items.reduce(function(sum, item) { return sum + Number(item.costUsd || 0); }, 0).toFixed(6)),
      },
    };
  }

  function diagnosticRateItemPayload(kind, index) {
    var safeKind = kind === 'role' ? 'role' : 'provider';
    var item = enrichDiagnosticRateItems(diagnosticRateItems(safeKind))[index];
    return {
      exportedAt: new Date().toISOString(),
      kind: safeKind,
      index: index,
      item: item || null,
      diagnostics: diagnosticsData.summary ? {
        generatedAt: diagnosticsData.summary.generatedAt || null,
        window: diagnosticsData.summary.window || null,
        health: diagnosticsData.summary.health || null,
      } : null,
    };
  }

  window.openDiagnosticRateTasks = function(kind, index) {
    var safeKind = kind === 'role' ? 'role' : 'provider';
    var item = enrichDiagnosticRateItems(diagnosticRateItems(safeKind))[index];
    if (!item || !item.name) {
      showToast('Diagnostic usage item not found', false);
      return;
    }
    taskCenterData.filters = {
      status: 'all',
      role: safeKind === 'role' ? item.name : '',
      source: 'all',
      provider: safeKind === 'provider' ? item.name : '',
      model: '',
      cronJobId: '',
      day: '',
    };
    taskCenterData.selected = {};
    selectNav('tasks');
  };

  function diagnosticTaskTrendItems() {
    var trends = diagnosticsData.summary && Array.isArray(diagnosticsData.summary.trends) ? diagnosticsData.summary.trends : [];
    return trends;
  }

  function diagnosticTaskTrendPayload() {
    var trends = diagnosticTaskTrendItems();
    return {
      exportedAt: new Date().toISOString(),
      generatedAt: diagnosticsData.summary && diagnosticsData.summary.generatedAt || null,
      window: diagnosticsData.summary && diagnosticsData.summary.window || null,
      count: trends.length,
      days: trends,
      summary: {
        totalTasks: trends.reduce(function(sum, item) { return sum + Number(item.total || 0); }, 0),
        completedTasks: trends.reduce(function(sum, item) { return sum + Number(item.completed || 0); }, 0),
        failedTasks: trends.reduce(function(sum, item) { return sum + Number(item.failed || 0); }, 0),
        runningTasks: trends.reduce(function(sum, item) { return sum + Number(item.running || 0); }, 0),
        costUsd: Number(trends.reduce(function(sum, item) { return sum + Number(item.costUsd || 0); }, 0).toFixed(6)),
      },
      diagnostics: diagnosticsData.summary ? {
        health: diagnosticsData.summary.health || null,
        providerStats: diagnosticsData.summary.providerStats || [],
        roleStats: diagnosticsData.summary.roleStats || [],
        cronStats: diagnosticsData.summary.cronStats || [],
      } : null,
    };
  }

  function diagnosticTaskTrendDayPayload(index) {
    var day = diagnosticTaskTrendItems()[index];
    return {
      exportedAt: new Date().toISOString(),
      index: index,
      day: day || null,
      diagnostics: diagnosticsData.summary ? {
        generatedAt: diagnosticsData.summary.generatedAt || null,
        window: diagnosticsData.summary.window || null,
        health: diagnosticsData.summary.health || null,
      } : null,
    };
  }

  window.openDiagnosticTaskTrendDayTasks = function(index) {
    var day = diagnosticTaskTrendItems()[index];
    if (!day || !day.day) {
      showToast('Task trend day not found', false);
      return;
    }
    taskCenterData.filters = {
      status: 'all',
      role: '',
      source: 'all',
      provider: '',
      model: '',
      cronJobId: '',
      day: String(day.day),
    };
    taskCenterData.selected = {};
    selectNav('tasks');
  };

  function metricsTrendPayload() {
    var summary = diagnosticsData.summary || {};
    var metrics = data && data.metrics || {};
    var today = metrics.today || {};
    var recentMessages = metrics.recentMessages || [];
    var contextRows = contextMetricRows();
    return {
      exportedAt: new Date().toISOString(),
      generatedAt: summary.generatedAt || null,
      window: summary.window || null,
      health: summary.health || null,
      trends: summary.trends || [],
      series: {
        costUsd: trendValues(summary.trends || [], 'costUsd'),
        avgDurationMs: trendValues(summary.trends || [], 'avgDurationMs'),
        totalTasks: trendValues(summary.trends || [], 'total'),
        failedTasks: trendValues(summary.trends || [], 'failed'),
        recentResponseSec: recentMessages.map(function(item) { return Number(item.responseSec || 0); }),
        contextPercent: contextRows.map(function(row) { return contextRowPercent(row); }),
      },
      messages: {
        today: today,
        recent: recentMessages.slice(0, 25),
      },
      context: contextRows.map(function(row) {
        return {
          label: row.label,
          name: row.name,
          tokens: contextRowTokens(row),
          observedTokens: row.observedTokens,
          contextTokens: row.contextTokens,
          limit: row.limit,
          percent: contextRowPercent(row),
          live: !!row.live,
          lastFlushAgoMs: row.lastFlushAgoMs,
          flushLimit: row.flushLimit,
          contextWindow: row.contextWindow,
          autoFlushDisabled: !!row.autoFlushDisabled,
        };
      }),
    };
  }

  function diagnosticMetricsTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench diagnostics metrics handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate the selected metrics, provider/role rate, or task trend evidence before changing behavior.',
      '- Correlate success rate, failed/running counts, cost, duration, day/provider/role filters, and current runtime snapshot.',
      '- If the evidence points to a regression, bottleneck, or unhealthy provider/role/day, identify the likely cause and propose or implement a scoped fix.',
      '- Preserve task safety boundaries; mutations should still go through the existing approval paths.',
      '',
      'Diagnostics metrics handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function createTaskFromDiagnosticMetricsPayload(payload, description) {
    if (!payload) {
      showToast('Diagnostics metrics evidence not found', false);
      return;
    }
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: shortText(description || 'Investigate diagnostics metrics', 120),
      prompt: diagnosticMetricsTaskPromptPayload({
        handoff: payload,
        snapshot: {
          tasks: data && data.tasks && data.tasks.summary || null,
          metrics: data && data.metrics || null,
          directors: runtimeDirectorSnapshots(data && data.system || {}, data && data.pool || [], data && data.activity || {}),
        },
      }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Diagnostics metrics handoff loaded into task form', true);
  }

  window.copyDiagnosticsSummary = function() {
    copyText(JSON.stringify(diagnosticsPayload(), null, 2));
  };

  window.exportDiagnosticsSummary = function() {
    downloadTextFile('persona-diagnostics-' + Date.now() + '.json', JSON.stringify(diagnosticsPayload(), null, 2));
    showToast('Diagnostics report exported', true);
  };

  function diagnosticsSummaryTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench diagnostics report as task context.',
      '',
      'Operator intent:',
      '- Investigate overall runtime, task, log, provider, role, cron, cost, latency, and context health before changing behavior.',
      '- Use diagnostics.summary, diagnostics.window, WebSocket events, runtime snapshot, log source manifest, and approval context as evidence.',
      '- If the report shows failures, regressions, unhealthy provider/role/cron patterns, stale logs, or context pressure, identify the likely root cause and propose or implement a scoped fix.',
      '- Preserve task safety boundaries; mutations should still go through existing approval paths.',
      '',
      'Diagnostics report handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromDiagnosticsSummary = function() {
    var diagnostics = diagnosticsPayload();
    if (!diagnostics.ok && diagnostics.error) {
      showToast('Creating diagnostics task from error report', false);
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'diagnosticsSummary',
      diagnostics: diagnostics,
      logSources: typeof logSourceManifestPayload === 'function' ? logSourceManifestPayload() : null,
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    var health = diagnostics.summary && diagnostics.summary.health || {};
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate diagnostics report: ' + pctText(health.successRate) + ' success, ' + String(health.failed || 0) + ' failed',
      prompt: diagnosticsSummaryTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Diagnostics report loaded into task form', true);
  };

  window.copyDiagnosticError = function(index) {
    var payload = diagnosticErrorPayload(index);
    if (!payload.error) {
      showToast('Diagnostic error not found', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportDiagnosticError = function(index) {
    var payload = diagnosticErrorPayload(index);
    if (!payload.error) {
      showToast('Diagnostic error not found', false);
      return;
    }
    var safe = safeAssetName(payload.error.message || 'error', 'error');
    downloadTextFile('persona-diagnostic-error-' + safe + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Diagnostic error exported', true);
  };

  window.createTaskFromDiagnosticError = function(index) {
    var payload = diagnosticErrorPayload(index);
    if (!payload.error) {
      showToast('Diagnostic error not found', false);
      return;
    }
    var task = diagnosticTaskRecord(payload.source && payload.source.taskId);
    var sourceDirector = task && (task.source_director || task.sourceDirector) || 'main';
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: sourceDirector,
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate diagnostic error: ' + shortText(payload.error.message || 'runtime error', 80),
      prompt: diagnosticErrorTaskPrompt(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Diagnostic error loaded into task form', true);
  };

  window.copyCronDiagnosticsReport = function() {
    var payload = cronDiagnosticsPayload();
    if (!payload.count) {
      showToast('No cron diagnostics to copy', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportCronDiagnosticsReport = function() {
    var payload = cronDiagnosticsPayload();
    if (!payload.count) {
      showToast('No cron diagnostics to export', false);
      return;
    }
    downloadTextFile('persona-cron-diagnostics-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Cron diagnostics exported', true);
  };

  window.copyCronDiagnosticItem = function(index) {
    var payload = cronDiagnosticItemPayload(index);
    if (!payload.item) {
      showToast('Cron diagnostic item not found', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportCronDiagnosticItem = function(index) {
    var payload = cronDiagnosticItemPayload(index);
    if (!payload.item) {
      showToast('Cron diagnostic item not found', false);
      return;
    }
    var safe = safeAssetName(payload.item.id || payload.item.name || 'cron', 'cron');
    downloadTextFile('persona-cron-diagnostic-' + safe + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Cron diagnostic exported', true);
  };

  window.createTaskFromCronDiagnosticsReport = function() {
    var payload = cronDiagnosticsPayload();
    if (!payload.count) {
      showToast('No cron diagnostics found', false);
      return;
    }
    createTaskFromCronDiagnosticPayload({
      type: 'cronDiagnosticsReport',
      report: payload,
      diagnostics: diagnosticsData.summary ? {
        generatedAt: diagnosticsData.summary.generatedAt || null,
        window: diagnosticsData.summary.window || null,
        health: diagnosticsData.summary.health || null,
      } : null,
      runtime: {
        tasks: data && data.tasks && data.tasks.summary || null,
        directors: runtimeDirectorSnapshots(data && data.system || {}, data && data.pool || [], data && data.activity || {}),
      },
    }, 'Investigate cron diagnostics: ' + String(payload.summary.failedRuns || 0) + ' failed / ' + String(payload.summary.totalRuns || 0) + ' runs', 'main');
  };

  window.createTaskFromCronDiagnosticItem = function(index) {
    var payload = cronDiagnosticItemPayload(index);
    if (!payload.item) {
      showToast('Cron diagnostic item not found', false);
      return;
    }
    var item = payload.item;
    var job = payload.job || {};
    createTaskFromCronDiagnosticPayload({
      type: 'cronDiagnosticItem',
      item: payload,
      report: cronDiagnosticsPayload(),
      relatedCronEvidence: item.id ? cronEvidencePayload(item.id) : null,
      runtime: {
        tasks: data && data.tasks && data.tasks.summary || null,
        directors: runtimeDirectorSnapshots(data && data.system || {}, data && data.pool || [], data && data.activity || {}),
      },
    }, 'Investigate cron failure rate: ' + (item.name || item.id || 'cron') + ' · ' + String(item.failed || 0) + ' failed / ' + String(item.total || 0) + ' runs', job.source_director || 'main');
  };

  window.copyDiagnosticRateReport = function(kind) {
    var payload = diagnosticRatePayload(kind);
    if (!payload.count) {
      showToast('No diagnostic rate data to copy', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportDiagnosticRateReport = function(kind) {
    var payload = diagnosticRatePayload(kind);
    if (!payload.count) {
      showToast('No diagnostic rate data to export', false);
      return;
    }
    downloadTextFile('persona-diagnostic-' + payload.kind + '-rates-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Diagnostic rate report exported', true);
  };

  window.copyDiagnosticRateItem = function(kind, index) {
    var payload = diagnosticRateItemPayload(kind, index);
    if (!payload.item) {
      showToast('Diagnostic rate item not found', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportDiagnosticRateItem = function(kind, index) {
    var payload = diagnosticRateItemPayload(kind, index);
    if (!payload.item) {
      showToast('Diagnostic rate item not found', false);
      return;
    }
    var safe = safeAssetName(payload.item.name || payload.kind, payload.kind);
    downloadTextFile('persona-diagnostic-' + payload.kind + '-rate-' + safe + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Diagnostic rate item exported', true);
  };

  window.createTaskFromDiagnosticRateReport = function(kind) {
    var payload = diagnosticRatePayload(kind);
    if (!payload.count) {
      showToast('No diagnostic rate data found', false);
      return;
    }
    createTaskFromDiagnosticMetricsPayload({
      type: 'diagnosticRateReport',
      report: payload,
    }, 'Investigate ' + payload.label + ': ' + String(payload.summary.failedTasks || 0) + ' failed / ' + String(payload.summary.totalTasks || 0) + ' tasks');
  };

  window.createTaskFromDiagnosticRateItem = function(kind, index) {
    var payload = diagnosticRateItemPayload(kind, index);
    if (!payload.item) {
      showToast('Diagnostic rate item not found', false);
      return;
    }
    var item = payload.item;
    createTaskFromDiagnosticMetricsPayload({
      type: 'diagnosticRateItem',
      item: payload,
      report: diagnosticRatePayload(payload.kind),
    }, 'Investigate ' + payload.kind + ' metrics: ' + (item.name || 'unknown') + ' · ' + pctText(item.successRate) + ' success · ' + String(item.failed || 0) + ' failed');
  };

  window.copyDiagnosticTaskTrendReport = function() {
    var payload = diagnosticTaskTrendPayload();
    if (!payload.count) {
      showToast('No task trend data to copy', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportDiagnosticTaskTrendReport = function() {
    var payload = diagnosticTaskTrendPayload();
    if (!payload.count) {
      showToast('No task trend data to export', false);
      return;
    }
    downloadTextFile('persona-diagnostic-task-trend-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Task trend report exported', true);
  };

  window.exportDiagnosticTaskTrendDay = function(index) {
    var payload = diagnosticTaskTrendDayPayload(index);
    if (!payload.day) {
      showToast('Task trend day not found', false);
      return;
    }
    var safe = safeAssetName(payload.day.day || 'day', 'day');
    downloadTextFile('persona-diagnostic-task-trend-day-' + safe + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Task trend day exported', true);
  };

  window.createTaskFromDiagnosticTaskTrendReport = function() {
    var payload = diagnosticTaskTrendPayload();
    if (!payload.count) {
      showToast('No task trend data found', false);
      return;
    }
    createTaskFromDiagnosticMetricsPayload({
      type: 'diagnosticTaskTrendReport',
      report: payload,
    }, 'Investigate task trend: ' + String(payload.summary.failedTasks || 0) + ' failed / ' + String(payload.summary.totalTasks || 0) + ' tasks');
  };

  window.createTaskFromDiagnosticTaskTrendDay = function(index) {
    var payload = diagnosticTaskTrendDayPayload(index);
    if (!payload.day) {
      showToast('Task trend day not found', false);
      return;
    }
    var day = payload.day;
    createTaskFromDiagnosticMetricsPayload({
      type: 'diagnosticTaskTrendDay',
      day: payload,
      report: diagnosticTaskTrendPayload(),
    }, 'Investigate task trend day: ' + (day.day || 'day') + ' · ' + String(day.failed || 0) + ' failed / ' + String(day.total || 0) + ' tasks');
  };

  window.copyMetricsTrendReport = function() {
    copyText(JSON.stringify(metricsTrendPayload(), null, 2));
  };

  window.exportMetricsTrendReport = function() {
    downloadTextFile('persona-metrics-trend-' + Date.now() + '.json', JSON.stringify(metricsTrendPayload(), null, 2));
    showToast('Metrics trend report exported', true);
  };

  window.createTaskFromMetricsTrendReport = function() {
    var payload = metricsTrendPayload();
    createTaskFromDiagnosticMetricsPayload({
      type: 'metricsTrendReport',
      report: payload,
    }, 'Investigate metrics trend: cost/latency/messages/context');
  };

  window.openDiagnosticErrorTask = function(index) {
    var err = diagnosticErrors()[index];
    var taskId = firstDiagnosticTaskId(err);
    if (!taskId) {
      showToast('No task source on this error', false);
      return;
    }
    selectTask(taskId);
  };

  window.openDiagnosticErrorLog = function(index) {
    var err = diagnosticErrors()[index];
    var label = firstDiagnosticLogLabel(err);
    if (!label) {
      showToast('No log source on this error', false);
      return;
    }
    var sourceId = diagnosticLogSourceId(label);
    if (!sourceId) {
      showToast('Log source not loaded: ' + label, false);
      return;
    }
    openSearchLogResult(sourceId);
  };

  window.searchDiagnosticError = function(index) {
    var err = diagnosticErrors()[index];
    var query = shortText(err && err.message || '', 120).trim();
    if (!query) {
      showToast('No error message to search', false);
      return;
    }
    globalSearchData.query = query;
    runGlobalSearch();
  };

  window.runEnvCheck = async function() {
    debugToolsData.envLoading = true;
    debugToolsData.envError = null;
    if (viewMode === 'settings') renderSettingsView();
    else renderObservabilityView();
    try {
      var res = await fetch('/api/env-check');
      var text = await res.text();
      var body = {};
      try {
        body = JSON.parse(text);
      } catch (_) {
        if (!res.ok) throw new Error(text || ('HTTP ' + res.status));
        throw new Error('environment check returned non-JSON response');
      }
      if (!res.ok || body.error) throw new Error(body.error || 'environment check failed');
      debugToolsData.env = body;
      showToast('Environment check complete', true);
    } catch (err) {
      debugToolsData.env = null;
      debugToolsData.envError = String(err && err.message || err);
      showToast('Environment check failed', false);
    } finally {
      debugToolsData.envLoading = false;
      if (viewMode === 'settings') renderSettingsView();
      else if (viewMode === 'observability') renderObservabilityView();
    }
  };

  function envCheckReport() {
    var checks = debugToolsData.env && debugToolsData.env.checks || [];
    var okCount = checks.filter(function(item) { return item.available; }).length;
    return {
      exportedAt: new Date().toISOString(),
      loading: !!debugToolsData.envLoading,
      ok: !!debugToolsData.env && !debugToolsData.envError,
      error: debugToolsData.envError || null,
      summary: {
        available: okCount,
        total: checks.length,
      },
      env: debugToolsData.env || null,
    };
  }

  function envCheckItemPayload(index) {
    var report = envCheckReport();
    var check = report.env && Array.isArray(report.env.checks) ? report.env.checks[index] : null;
    return {
      exportedAt: new Date().toISOString(),
      index: index,
      check: check || null,
      summary: report.summary,
      ok: report.ok,
      loading: report.loading,
      error: report.error,
    };
  }

  function envCheckTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench environment check handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate this local environment check report or selected command result.',
      '- Use the full environment report first, then compare any selected check with Settings, safety, provider permissions, and config assets.',
      '- If a command is missing or unhealthy, identify the likely setup/configuration issue and propose or implement a scoped fix.',
      '- Preserve the existing local runtime and provider configuration unless the task prompt is edited.',
      '',
      'Environment check handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.copyEnvCheckReport = function() {
    copyText(JSON.stringify(envCheckReport(), null, 2));
  };

  window.exportEnvCheckReport = function() {
    downloadTextFile('persona-env-check-' + Date.now() + '.json', JSON.stringify(envCheckReport(), null, 2));
    showToast('Environment check exported', true);
  };

  window.createTaskFromEnvCheckReport = function() {
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'envCheckReport',
      report: envCheckReport(),
      settings: settingsSummaryPayload(),
      safety: safetyReportPayload(),
      providerPermissions: providerPermissionsPayload(),
      configAssets: configAssetsReport(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate environment check report',
      prompt: envCheckTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Environment check report loaded into task form', true);
  };

  window.copyEnvCheckItem = function(index) {
    var payload = envCheckItemPayload(index);
    if (!payload.check) {
      showToast('Environment check item not found', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportEnvCheckItem = function(index) {
    var payload = envCheckItemPayload(index);
    if (!payload.check) {
      showToast('Environment check item not found', false);
      return;
    }
    downloadTextFile('persona-env-check-' + safeAssetName(payload.check.name || payload.check.command || 'check', 'check') + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Environment check item exported', true);
  };

  window.createTaskFromEnvCheckItem = function(index) {
    var payload = envCheckItemPayload(index);
    if (!payload.check) {
      showToast('Environment check item not found', false);
      return;
    }
    var check = payload.check || {};
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate environment check: ' + (check.name || check.command || 'local command'),
      prompt: envCheckTaskPromptPayload({ type: 'envCheckItem', item: payload, report: envCheckReport() }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Environment check loaded into task form', true);
  };

  function debugBundleEvidencePayload() {
    return {
      exportedAt: new Date().toISOString(),
      evidence: debugToolsData.bundleEvidence || null,
      error: debugToolsData.bundleError || null,
      loading: !!debugToolsData.bundleLoading,
    };
  }

  function debugBundleTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench debug bundle handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate or continue from the exported local debug bundle evidence.',
      '- Start with the bundle filename, generated time, size, log/task/audit/env summary, then correlate with the live snapshot and diagnostics hints.',
      '- If the bundle was exported after a failure, identify likely failure areas and propose or implement a scoped fix.',
      '- Preserve local privacy and safety boundaries; do not assume the full downloaded bundle exists outside this machine unless the task prompt is edited.',
      '',
      'Debug bundle handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function debugBundleTaskPayload() {
    return {
      evidence: debugBundleEvidencePayload(),
      snapshot: snapshotReportPayload(),
      diagnostics: diagnosticsData.summary ? {
        health: diagnosticsData.summary.health || null,
        errors: (diagnosticsData.summary.errors || []).slice(0, 8),
        providerStats: (diagnosticsData.summary.providerStats || []).slice(0, 8),
        roleStats: (diagnosticsData.summary.roleStats || []).slice(0, 8),
      } : null,
      env: debugToolsData.env ? envCheckReport() : null,
      websocket: wsEventsReport().summary,
    };
  }

  function summarizeDebugBundle(bundle) {
    var logs = bundle && bundle.logs || {};
    var tasks = bundle && bundle.tasks || [];
    var audit = bundle && bundle.audit || [];
    var env = bundle && bundle.env || [];
    var pool = bundle && bundle.snapshot && bundle.snapshot.pool || [];
    return {
      generatedAt: bundle && bundle.generatedAt || null,
      sessionId: bundle && bundle.snapshot && bundle.snapshot.system && bundle.snapshot.system.sessionId || null,
      directorAlive: bundle && bundle.snapshot && bundle.snapshot.system && bundle.snapshot.system.directorAlive || false,
      poolDirectors: Array.isArray(pool) ? pool.length : 0,
      logSources: Array.isArray(logs.sources) ? logs.sources.length : 0,
      logTails: logs.tails ? Object.keys(logs.tails).length : 0,
      tasks: Array.isArray(tasks) ? tasks.length : 0,
      auditEntries: Array.isArray(audit) ? audit.length : 0,
      envChecks: Array.isArray(env) ? env.length : 0,
      envAvailable: Array.isArray(env) ? env.filter(function(item) { return item && item.available; }).length : 0,
    };
  }

  window.exportDebugBundle = async function() {
    debugToolsData.bundleLoading = true;
    debugToolsData.bundleError = null;
    renderObservabilityView();
    try {
      var res = await fetch('/api/debug-bundle');
      var bodyText = await res.text();
      var body = bodyText;
      var parsedBundle = null;
      try {
        parsedBundle = JSON.parse(bodyText);
        body = JSON.stringify(parsedBundle, null, 2);
      } catch (_) {
        // keep raw text for error reporting
      }
      if (!res.ok) throw new Error(bodyText || 'debug bundle request failed');
      var filename = 'persona-debug-bundle-' + Date.now() + '.json';
      downloadTextFile(filename, body);
      debugToolsData.bundleEvidence = {
        exportedAt: new Date().toISOString(),
        filename: filename,
        bytes: new Blob([body]).size,
        generatedAt: parsedBundle && parsedBundle.generatedAt || null,
        source: '/api/debug-bundle',
        summary: summarizeDebugBundle(parsedBundle),
      };
      showToast('Debug bundle exported', true);
    } catch (err) {
      debugToolsData.bundleError = String(err && err.message || err);
      showToast('Debug bundle export failed', false);
    } finally {
      debugToolsData.bundleLoading = false;
      if (viewMode === 'observability') renderObservabilityView();
    }
  };

  window.copyDebugBundleEvidence = function() {
    if (!debugToolsData.bundleEvidence) {
      showToast('No debug bundle evidence to copy', false);
      return;
    }
    copyText(JSON.stringify(debugBundleEvidencePayload(), null, 2));
  };

  window.exportDebugBundleEvidence = function() {
    if (!debugToolsData.bundleEvidence) {
      showToast('No debug bundle evidence to export', false);
      return;
    }
    downloadTextFile('persona-debug-bundle-evidence-' + Date.now() + '.json', JSON.stringify(debugBundleEvidencePayload(), null, 2));
    showToast('Debug bundle evidence exported', true);
  };

  window.createTaskFromDebugBundleEvidence = function() {
    if (!debugToolsData.bundleEvidence) {
      showToast('No debug bundle evidence found', false);
      return;
    }
    var bundle = debugToolsData.bundleEvidence;
    var summary = bundle.summary || {};
    var label = bundle.filename || bundle.source || 'debug bundle';
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate debug bundle: ' + shortText(label + ' · ' + String(summary.logSources || 0) + ' logs · ' + String(summary.tasks || 0) + ' tasks', 80),
      prompt: debugBundleTaskPromptPayload({ type: 'debugBundleEvidence', bundle: debugBundleTaskPayload() }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Debug bundle handoff loaded into task form', true);
  };

  window.setWsEventFilter = function(key, value) {
    wsEventsData[key] = String(value || '');
    if (key === 'filter' || key === 'query') wsEventsData.selectedId = '';
    if (viewMode === 'observability') renderObservabilityView();
  };

  window.selectWsEvent = function(id) {
    wsEventsData.selectedId = String(id || '');
    if (viewMode === 'observability') renderObservabilityView();
  };

  window.clearWsEvents = function() {
    wsEventsData.events = [];
    wsEventsData.selectedId = '';
    if (viewMode === 'observability') renderObservabilityView();
  };

  window.copyWsEvents = function() {
    var text = JSON.stringify(filteredWsEvents(), null, 2);
    if (text === '[]') {
      showToast('No WebSocket events to copy', false);
      return;
    }
    copyText(text);
  };

  window.copyWsEventsReport = function() {
    var report = wsEventsReport();
    if (!report.events.length) {
      showToast('No WebSocket events to copy', false);
      return;
    }
    copyText(JSON.stringify(report, null, 2));
  };

  window.copySelectedWsEvent = function() {
    var event = selectedWsEvent();
    if (!event) {
      showToast('No WebSocket event selected', false);
      return;
    }
    copyText(wsEventJson(event));
  };

  window.copySelectedWsPayload = function() {
    var event = selectedWsEvent();
    if (!event) {
      showToast('No WebSocket event selected', false);
      return;
    }
    copyText(event.payload == null ? 'null' : JSON.stringify(event.payload, null, 2));
  };

  window.copySelectedWsRaw = function() {
    var event = selectedWsEvent();
    if (!event) {
      showToast('No WebSocket event selected', false);
      return;
    }
    copyText(event.raw || '');
  };

  window.exportSelectedWsEvent = function() {
    var event = selectedWsEvent();
    if (!event) {
      showToast('No WebSocket event selected', false);
      return;
    }
    downloadTextFile('persona-websocket-event-' + String(event.type || 'event').replace(/[^a-z0-9._-]+/gi, '-') + '-' + Date.now() + '.json', wsEventJson(event));
    showToast('WebSocket event exported', true);
  };

  window.openSelectedWsDirector = function() {
    var event = selectedWsEvent();
    var target = wsEventTarget(event);
    if (!target.director) {
      showToast('WebSocket event has no director target', false);
      return;
    }
    if (target.director === 'main') {
      selectSession(null);
    } else {
      selectPoolDirector(target.director, target.director);
    }
  };

  window.openSelectedWsTask = function() {
    var event = selectedWsEvent();
    var target = wsEventTarget(event);
    if (!target.taskId) {
      showToast('WebSocket event has no task target', false);
      return;
    }
    selectTask(target.taskId);
  };

  window.exportWsEvents = function() {
    var text = JSON.stringify(filteredWsEvents(), null, 2);
    if (text === '[]') {
      showToast('No WebSocket events to export', false);
      return;
    }
    downloadTextFile('persona-websocket-events-' + Date.now() + '.json', text);
    showToast('WebSocket events exported', true);
  };

  window.exportWsEventsReport = function() {
    var report = wsEventsReport();
    if (!report.events.length) {
      showToast('No WebSocket events to export', false);
      return;
    }
    downloadTextFile('persona-websocket-events-report-' + Date.now() + '.json', JSON.stringify(report, null, 2));
    showToast('WebSocket events report exported', true);
  };

  window.createTaskFromWsEventsReport = function() {
    var report = wsEventsReport();
    createTaskFromWsEventsPayload({ report: report }, 'webSocketEventReport');
  };

  window.createTaskFromSelectedWsEvent = function() {
    var event = selectedWsEvent();
    if (!event) {
      showToast('No WebSocket event selected', false);
      return;
    }
    var report = wsEventsReport();
    createTaskFromWsEventsPayload({
      event: JSON.parse(wsEventJson(event)),
      report: report,
    }, 'selectedWebSocketEvent');
  };

  window.copySnapshotJson = function() {
    copyText(snapshotJson());
  };

  window.exportSnapshotJson = function() {
    downloadTextFile('persona-snapshot-' + Date.now() + '.json', snapshotJson());
    showToast('Snapshot exported', true);
  };

  window.copySnapshotReport = function() {
    copyText(JSON.stringify(snapshotReportPayload(), null, 2));
  };

  window.exportSnapshotReport = function() {
    downloadTextFile('persona-snapshot-report-' + Date.now() + '.json', JSON.stringify(snapshotReportPayload(), null, 2));
    showToast('Snapshot report exported', true);
  };

  window.createTaskFromSnapshotReport = function() {
    var report = snapshotReportPayload();
    var warnings = snapshotTaskWarnings(report);
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: report.view && report.view.selectedDirector || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate snapshot: ' + (warnings.length ? shortText(warnings.join(', '), 90) : 'runtime/context/tasks/websocket state'),
      prompt: snapshotTaskPromptPayload({
        type: 'snapshotReport',
        warnings: warnings,
        report: report,
        diagnostics: diagnosticsData.summary ? {
          window: diagnosticsData.summary.window || null,
          health: diagnosticsData.summary.health || null,
          errors: (diagnosticsData.summary.errors || []).slice(0, 8),
        } : null,
      }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Snapshot handoff loaded into task form', true);
  };

  window.selectLogSource = function(id) {
    logsData.selectedId = id;
    logsData.tail = null;
    renderObservabilityView();
    loadLogTail(id);
  };

  function loadLogTail(id) {
    var bytes = Number(logsData.bytes || 196608);
    fetch('/api/logs/tail?id=' + encodeURIComponent(id) + '&bytes=' + encodeURIComponent(String(bytes)))
      .then(function(r) {
        if (!r.ok) return r.text().then(function(text) { throw new Error(text || 'log tail request failed'); });
        return r.json();
      })
      .then(function(tail) {
        logsData.tail = tail;
        if (viewMode === 'observability') renderObservabilityView();
      })
      .catch(function(err) {
        logsData.tail = { id: id, error: String(err) };
        if (viewMode === 'observability') renderObservabilityView();
      });
  }

  function logLineLevel(line) {
    var s = String(line || '').toLowerCase();
    if (/\b(error|failed|failure|exception|fatal|traceback)\b/.test(s)) return 'error';
    if (/\b(warn|warning)\b/.test(s)) return 'warn';
    if (/\b(debug|verbose)\b/.test(s)) return 'debug';
    if (/\b(info|ok|done|success|started|completed)\b/.test(s)) return 'info';
    return 'other';
  }

  function visibleLogLines() {
    var tail = logsData.tail;
    if (!tail || tail.error || !tail.content) return [];
    var q = String(logsData.query || '').trim().toLowerCase();
    var level = logsData.level || 'all';
    return String(tail.content).split('\n').filter(function(line) {
      if (level !== 'all' && logLineLevel(line) !== level) return false;
      if (q && line.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function renderLogContent(lines) {
    var q = String(logsData.query || '').trim();
    var html = '';
    var pattern = q ? new RegExp(escapeRegExp(esc(q)), 'ig') : null;
    for (var i = 0; i < lines.length; i++) {
      var level = logLineLevel(lines[i]);
      var safe = esc(lines[i]);
      if (pattern) safe = safe.replace(pattern, '<mark>$&</mark>');
      html += '<span class="log-line log-line-' + esc(level) + '">' + safe + '</span>';
      if (i < lines.length - 1) html += '\n';
    }
    return html;
  }

  window.setLogFilter = function(key, value) {
    logsData[key] = value;
    renderObservabilityView();
  };

  window.setLogBytes = function(value) {
    logsData.bytes = Number(value || 196608);
    if (logsData.selectedId) {
      logsData.tail = null;
      renderObservabilityView();
      loadLogTail(logsData.selectedId);
    }
  };

  window.copyCurrentLogTail = function() {
    var text = visibleLogLines().join('\n');
    if (!text) {
      showToast('No log lines to copy', false);
      return;
    }
    copyText(text);
  };

  window.exportCurrentLogTail = function() {
    var text = visibleLogLines().join('\n');
    if (!text) {
      showToast('No log lines to export', false);
      return;
    }
    var source = (logsData.sources || []).find(function(item) { return item.id === logsData.selectedId; });
    var name = source ? source.label : 'log-tail';
    var safe = name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'log-tail';
    downloadTextFile('persona-' + safe + '-' + Date.now() + '.log', text);
    showToast('Log tail exported', true);
  };

  function currentLogSource() {
    return (logsData.sources || []).find(function(item) { return item.id === logsData.selectedId; }) || null;
  }

  function logTailEvidencePayload() {
    var tail = logsData.tail || {};
    var source = currentLogSource();
    var allLines = tail && tail.content ? String(tail.content).split('\n') : [];
    var visible = visibleLogLines();
    return {
      exportedAt: new Date().toISOString(),
      source: source ? {
        id: source.id,
        label: source.label,
        group: source.group || 'shell',
        category: logSourceCategory(source),
        path: source.path,
        size: source.size,
        mtimeMs: source.mtimeMs,
      } : null,
      request: {
        bytes: Number(logsData.bytes || 196608),
        query: logsData.query || '',
        level: logsData.level || 'all',
      },
      tail: {
        id: tail.id || null,
        path: tail.path || null,
        size: tail.size || null,
        mtimeMs: tail.mtimeMs || null,
        error: tail.error || null,
        totalLines: allLines.length,
        visibleLines: visible.length,
        content: tail.content || '',
        visible: visible,
      },
    };
  }

  window.copyCurrentLogTailEvidence = function() {
    var payload = logTailEvidencePayload();
    if (!payload.source || payload.tail.error || !payload.tail.content) {
      showToast('No log tail evidence to copy', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportCurrentLogTailEvidence = function() {
    var payload = logTailEvidencePayload();
    if (!payload.source || payload.tail.error || !payload.tail.content) {
      showToast('No log tail evidence to export', false);
      return;
    }
    downloadTextFile('persona-log-tail-evidence-' + safeAssetName(payload.source.label || payload.source.id, 'log-tail') + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Log tail evidence exported', true);
  };

  function logTailTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench log tail handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate or continue from the current log tail evidence.',
      '- Review source, request filters, visible lines, and full tail content before acting.',
      '- If the visible lines include errors or failed operations, identify the likely cause and propose or implement a scoped fix.',
      '- Preserve the current log source and filter context unless the task prompt is edited.',
      '',
      'Log tail handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromCurrentLogTail = function() {
    var payload = logTailEvidencePayload();
    if (!payload.source || payload.tail.error || !payload.tail.content) {
      showToast('No log tail evidence to turn into a task', false);
      return;
    }
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate log tail: ' + (payload.source.label || payload.source.id || 'log'),
      prompt: logTailTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Log tail evidence loaded into task form', true);
  };

  function renderLogTailPanel(source) {
    if (!source) {
      if (logsData.tail && logsData.tail.error) {
        return '<div class="panel-title"><span>Tail</span></div><div class="td-error">' + esc(logsData.tail.error) + '</div>';
      }
      return '<div class="panel-title"><span>Tail</span></div><div class="empty">Select a log source</div>';
    }
    var tail = logsData.tail;
    var html = '<div class="panel-title"><span>Tail</span><span class="muted">' + esc(source.label) + '</span></div>';
    html += '<div class="logs-controls">';
    html += '<label><span>Search</span><input value="' + esc(logsData.query || '') + '" placeholder="grep tail" oninput="setLogFilter(\'query\', this.value)"></label>';
    html += '<label><span>Level</span><select onchange="setLogFilter(\'level\', this.value)">';
    var levels = [['all', 'All'], ['error', 'Error'], ['warn', 'Warn'], ['info', 'Info'], ['debug', 'Debug']];
    for (var li = 0; li < levels.length; li++) {
      html += '<option value="' + levels[li][0] + '"' + (logsData.level === levels[li][0] ? ' selected' : '') + '>' + levels[li][1] + '</option>';
    }
    html += '</select></label>';
    html += '<label><span>Window</span><select onchange="setLogBytes(this.value)">';
    var byteOptions = [[65536, '64 KB'], [196608, '192 KB'], [524288, '512 KB']];
    for (var bi = 0; bi < byteOptions.length; bi++) {
      html += '<option value="' + byteOptions[bi][0] + '"' + (Number(logsData.bytes) === byteOptions[bi][0] ? ' selected' : '') + '>' + byteOptions[bi][1] + '</option>';
    }
    html += '</select></label>';
    html += '</div>';
    html += '<div class="panel-actions" style="margin-bottom:10px">';
    html += '<button class="mini-btn" onclick="loadLogTail(\'' + jsq(source.id) + '\')">Refresh Tail</button>';
    html += '<button class="mini-btn" onclick="copyText(\'' + jsq(source.path) + '\')">Copy Path</button>';
    html += '<button class="mini-btn" onclick="revealLocalPath(\'' + jsq(source.path) + '\')">Reveal</button>';
    html += '<button class="mini-btn" onclick="copyCurrentLogTail()">Copy Tail</button>';
    html += '<button class="mini-btn" onclick="exportCurrentLogTail()">Export Tail</button>';
    html += '<button class="mini-btn" onclick="copyCurrentLogTailEvidence()">Copy Evidence</button>';
    html += '<button class="mini-btn" onclick="exportCurrentLogTailEvidence()">Export Evidence</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromCurrentLogTail()">Create Task</button>';
    html += '</div>';
    if (!tail || tail.id !== source.id) {
      html += '<div class="td-result-running"><div class="spinner"></div><span>Loading log tail...</span></div>';
    } else if (tail.error) {
      html += '<div class="td-error">' + esc(tail.error) + '</div>';
    } else {
      var lines = visibleLogLines();
      html += '<div class="log-tail-meta">' + lines.length + ' / ' + String(tail.content || '').split('\n').length + ' lines' + (tail.size ? ' · ' + fmtFileSize(tail.size) : '') + '</div>';
      html += '<pre class="log-tail">' + renderLogContent(lines) + '</pre>';
    }
    return html;
  }

  window.loadLogTail = loadLogTail;

  function loadSettingsSummary() {
    settingsData.loading = true;
    settingsData.error = null;
    renderSettingsView();
    fetch('/api/config-summary')
      .then(function(r) {
        if (!r.ok) return r.text().then(function(text) { throw new Error(text || 'config summary request failed'); });
        return r.json();
      })
      .then(function(summary) {
        settingsData.summary = summary;
        settingsData.loading = false;
        renderSettingsView();
      })
      .catch(function(err) {
        settingsData.loading = false;
        settingsData.error = String(err);
        renderSettingsView();
      });
  }

  window.loadSettingsSummary = loadSettingsSummary;

  function loadAuditLog() {
    auditData.loading = true;
    auditData.error = null;
    if (viewMode === 'settings') renderSettingsView();
    else if (viewMode === 'automations') renderAutomationsView();
    fetch('/api/audit-log?limit=80')
      .then(function(r) {
        return r.text().then(function(text) {
          if (!r.ok) throw new Error(text || 'audit log request failed');
          try {
            return JSON.parse(text);
          } catch (_) {
            throw new Error('audit log returned non-JSON response');
          }
        });
      })
      .then(function(body) {
        auditData.entries = body.entries || [];
        auditData.path = body.path || '';
        auditData.loading = false;
        var deliveryChanged = syncSentArtifactsFromAudit(auditData.entries);
        if (viewMode === 'settings') renderSettingsView();
        else if (viewMode === 'automations') renderAutomationsView();
        else if (viewMode === 'files' && deliveryChanged) renderFilesView();
      })
      .catch(function(err) {
        auditData.entries = [];
        auditData.path = '';
        auditData.loading = false;
        auditData.error = String(err && err.message || err);
        if (viewMode === 'settings') renderSettingsView();
        else if (viewMode === 'automations') renderAutomationsView();
      });
  }

  window.loadAuditLog = loadAuditLog;

  function loadConfigAssets() {
    configAssetsData.loading = true;
    configAssetsData.error = null;
    if (viewMode === 'settings') renderSettingsView();
    else if (viewMode === 'persona' && personaLoaded) renderPersonaView();
    else if (viewMode === 'agents') renderRuntimeView();
    fetch('/api/config-assets')
      .then(function(r) {
        return r.text().then(function(text) {
          if (!r.ok) throw new Error(text || 'config assets request failed');
          try {
            return JSON.parse(text);
          } catch (_) {
            throw new Error('config assets returned non-JSON response');
          }
        });
      })
      .then(function(body) {
        configAssetsData.configFiles = body.configFiles || [];
        configAssetsData.mcpConfigs = body.mcpConfigs || [];
        configAssetsData.skills = body.skills || [];
        configAssetsData.loading = false;
        if (viewMode === 'settings') renderSettingsView();
        else if (viewMode === 'persona' && personaLoaded) renderPersonaView();
        else if (viewMode === 'agents') renderRuntimeView();
      })
      .catch(function(err) {
        configAssetsData.configFiles = [];
        configAssetsData.mcpConfigs = [];
        configAssetsData.skills = [];
        configAssetsData.loading = false;
        configAssetsData.error = String(err && err.message || err);
        if (viewMode === 'settings') renderSettingsView();
        else if (viewMode === 'persona' && personaLoaded) renderPersonaView();
        else if (viewMode === 'agents') renderRuntimeView();
      });
  }

  window.loadConfigAssets = loadConfigAssets;

  function renderSettingsView() {
    if (settingsData.loading) {
      $('detail-content').innerHTML = '<div class="td-result-running"><div class="spinner"></div><span>Loading settings...</span></div>';
      return;
    }
    if (settingsData.error) {
      $('detail-content').innerHTML = '<div class="page-grid">' + renderUiPreferencesPanel() + renderSettingsSafetyPanel(null) + renderSettingsEnvPanel() + renderConfigAssetsPanel() + renderAuditLogPanel() + '<div class="workbench-panel wide"><div class="panel-title"><span>Runtime Config</span><div class="panel-actions"><button class="mini-btn" onclick="loadSettingsSummary()">Retry</button><button class="mini-btn" onclick="copySettingsSummary()">Copy Summary</button><button class="mini-btn" onclick="exportSettingsSummary()">Export Summary</button><button class="mini-btn primary" onclick="createTaskFromSettingsSummary()">Create Task</button></div></div><div class="td-error">' + esc(settingsData.error) + '</div></div></div>';
      return;
    }
    var s = settingsData.summary;
    if (!s) {
      $('detail-content').innerHTML = '<div class="empty">No settings loaded</div>';
      return;
    }

    var providers = s.agents && s.agents.providers || {};
    var roles = s.agents && s.agents.roles || {};
    var html = '<div class="page-grid">';
    html += renderUiPreferencesPanel();
    html += renderRuntimeConfigPanel(s);
    html += renderSettingsEnvPanel();
    html += renderConfigAssetsPanel();

    html += '<div class="workbench-panel wide"><div class="panel-title"><span>Providers</span><span>' + Object.keys(providers).length + '</span></div><div class="panel-list">';
    Object.keys(providers).sort().forEach(function(name) {
      var p = providers[name];
      html += '<div class="panel-row"><span class="badge pending">' + esc(p.type) + '</span><div class="panel-row-main">';
      html += '<div class="panel-row-title">' + esc(name) + '</div>';
      html += '<div class="panel-row-sub">' + esc(p.command || '--') +
        (p.model ? ' · ' + esc(p.model) : '') +
        (p.sandbox ? ' · sandbox ' + esc(p.sandbox) : '') +
        (p.approval ? ' · approval ' + esc(p.approval) : '') +
        (p.mcpMode ? ' · mcp ' + esc(p.mcpMode) : '') +
        '</div></div><div class="panel-actions settings-row-actions">' +
        '<button class="chat-msg-action" onclick="copySettingsProvider(\'' + jsq(name) + '\')">Copy</button>' +
        '<button class="chat-msg-action" onclick="exportSettingsProvider(\'' + jsq(name) + '\')">Export</button>' +
        '<button class="chat-msg-action" onclick="createTaskFromSettingsProvider(\'' + jsq(name) + '\')">Create Task</button>' +
        '</div></div>';
    });
    html += '</div></div>';

    html += '<div class="workbench-panel"><div class="panel-title"><span>Role Defaults</span><span>' + Object.keys(roles).length + '</span></div><div class="panel-list">';
    var defaultKeys = Object.keys(s.agents.defaults || {}).sort();
    for (var i = 0; i < defaultKeys.length; i++) {
      html += '<div class="panel-row"><div class="panel-row-main"><div class="panel-row-title">' + esc(defaultKeys[i]) + '</div><div class="panel-row-sub">default provider: ' + esc(s.agents.defaults[defaultKeys[i]]) + '</div></div><div class="panel-actions settings-row-actions">' +
        '<button class="chat-msg-action" onclick="copySettingsRoleDefault(\'' + jsq(defaultKeys[i]) + '\')">Copy</button>' +
        '<button class="chat-msg-action" onclick="exportSettingsRoleDefault(\'' + jsq(defaultKeys[i]) + '\')">Export</button>' +
        '<button class="chat-msg-action" onclick="createTaskFromSettingsRoleDefault(\'' + jsq(defaultKeys[i]) + '\')">Create Task</button>' +
        '</div></div>';
    }
    Object.keys(roles).sort().forEach(function(role) {
      html += '<div class="panel-row"><div class="panel-row-main"><div class="panel-row-title">' + esc(role) + '</div><div class="panel-row-sub">' + esc(JSON.stringify(roles[role])) + '</div></div><div class="panel-actions settings-row-actions">' +
        '<button class="chat-msg-action" onclick="copySettingsRoleOverride(\'' + jsq(role) + '\')">Copy</button>' +
        '<button class="chat-msg-action" onclick="exportSettingsRoleOverride(\'' + jsq(role) + '\')">Export</button>' +
        '<button class="chat-msg-action" onclick="createTaskFromSettingsRoleOverride(\'' + jsq(role) + '\')">Create Task</button>' +
        '</div></div>';
    });
    html += '</div></div>';

    html += renderProviderPermissionsMatrix(s);
    html += renderSettingsSafetyPanel(s);
    html += renderAuditLogPanel();
    html += '</div>';
    $('detail-content').innerHTML = html;
  }

  function configValue(value) {
    if (value == null || value === '') return '--';
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    return String(value);
  }

  function msConfigValue(value) {
    if (value == null) return '--';
    var n = Number(value);
    if (!isFinite(n)) return String(value);
    if (n >= 60000 && n % 60000 === 0) return String(n / 60000) + 'm';
    if (n >= 1000 && n % 1000 === 0) return String(n / 1000) + 's';
    return String(n) + 'ms';
  }

  function configDetailRow(label, value, note, badge, badgeClass) {
    var html = '<div class="panel-row config-detail-row">';
    if (badge) html += '<span class="badge ' + esc(badgeClass || 'pending') + '">' + esc(badge) + '</span>';
    html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(label) + '</div>';
    html += '<div class="panel-row-sub">' + esc(configValue(value)) + (note ? ' · ' + esc(note) : '') + '</div></div></div>';
    return html;
  }

  function renderConfigDetailSection(title, rows) {
    var html = '<div class="config-detail-section"><div class="diagnostic-section-title">' + esc(title) + '</div><div class="panel-list compact">';
    for (var i = 0; i < rows.length; i++) html += rows[i];
    html += '</div></div>';
    return html;
  }

  function renderRuntimeConfigPanel(s) {
    var consoleCfg = s.console || {};
    var feishu = s.feishu || {};
    var director = s.director || {};
    var pool = s.pool || {};
    var task = s.task || {};
    var scheduler = s.scheduler || {};
    var logging = s.logging || {};
    var providers = s.agents && s.agents.providers || {};
    var roles = s.agents && s.agents.roles || {};
    var providerNames = Object.keys(providers);
    var searchProviders = providerNames.filter(function(name) { return providers[name] && providers[name].search; });
    var dangerousProviders = providerNames.filter(function(name) {
      var p = providers[name] || {};
      return p.dangerouslySkipPermissions || p.approval === 'never' || p.bare || p.sandbox === 'danger-full-access';
    });
    var html = '<div class="workbench-panel wide runtime-config-panel"><div class="panel-title"><span>Runtime Config</span><div class="panel-actions">';
    html += '<button class="mini-btn" onclick="loadSettingsSummary()">Refresh</button>';
    html += '<button class="mini-btn" onclick="copySettingsSummary()">Copy Summary</button>';
    html += '<button class="mini-btn" onclick="exportSettingsSummary()">Export Summary</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromSettingsSummary()">Create Task</button>';
    html += '</div></div>';
    html += '<div class="kv-grid">';
    html += settingsKv('Console', configValue(consoleCfg.bind || '127.0.0.1') + ':' + configValue(consoleCfg.port) + (consoleCfg.tokenConfigured ? ' · token on' : ' · no token'));
    html += settingsKv('Feishu', 'app ' + configValue(feishu.appId) + ' · secret ' + (feishu.appSecretConfigured ? 'configured' : 'missing'));
    html += settingsKv('Director', 'flush ' + fmtTokens(director.flushContextLimit || 0) + ' · interval ' + msConfigValue(director.flushIntervalMs));
    html += settingsKv('Pool', configValue(pool.max_directors) + ' max · ' + configValue(pool.idle_timeout_minutes) + 'm idle');
    html += settingsKv('Scheduler', scheduler.enabled ? ('on · every ' + configValue(scheduler.intervalMinutes) + 'm') : 'off');
    html += settingsKv('Providers', providerNames.length + ' total · ' + searchProviders.length + ' search · ' + dangerousProviders.length + ' flagged');
    html += '</div>';
    html += '<div class="config-detail-grid">';
    html += renderConfigDetailSection('Console & Feishu', [
      configDetailRow('Console Enabled', consoleCfg.enabled !== false, 'bind ' + configValue(consoleCfg.bind || '127.0.0.1'), consoleCfg.tokenConfigured ? 'token' : 'local', consoleCfg.tokenConfigured ? 'completed' : 'pending'),
      configDetailRow('Console Port', consoleCfg.port, 'HTTP and WebSocket entrypoint'),
      configDetailRow('Feishu App', feishu.appId || '--', feishu.appSecretConfigured ? 'secret configured' : 'secret missing', feishu.appSecretConfigured ? 'secret' : 'warn', feishu.appSecretConfigured ? 'completed' : 'pending'),
      configDetailRow('Feishu Master', feishu.masterId || '--', 'streaming ' + configValue(feishu.streamingReplyEnabled)),
      configDetailRow('Feishu Stream Debounce', msConfigValue(feishu.streamUpdateDebounceMs), 'min chars ' + configValue(feishu.streamMinUpdateChars)),
    ]);
    html += renderConfigDetailSection('Director', [
      configDetailRow('Persona Dir', director.personaDir),
      configDetailRow('Pipe Dir', director.pipeDir),
      configDetailRow('PID File', director.pidFile),
      configDetailRow('Flush Context Limit', fmtTokens(director.flushContextLimit || 0), 'auto compaction boundary'),
      configDetailRow('Flush Interval', msConfigValue(director.flushIntervalMs)),
      configDetailRow('Time Sync Interval', msConfigValue(director.timeSyncIntervalMs)),
      configDetailRow('Quote Max Length', director.quoteMaxLength),
    ]);
    html += renderConfigDetailSection('Pool & Tasks', [
      configDetailRow('Pool Max Directors', pool.max_directors),
      configDetailRow('Pool Idle Timeout', configValue(pool.idle_timeout_minutes) + 'm'),
      configDetailRow('Small Group Threshold', pool.small_group_threshold),
      configDetailRow('Task Timeout', msConfigValue(task.timeout_ms || task.timeoutMs)),
      configDetailRow('Task Max Retry', task.max_retry != null ? task.max_retry : task.maxRetry),
      configDetailRow('Task Provider Defaults', Object.keys(task || {}).length + ' fields', 'see exported summary for raw shape'),
    ]);
    html += renderConfigDetailSection('Scheduler & Logging', [
      configDetailRow('Scheduler Enabled', scheduler.enabled !== false, 'interval ' + configValue(scheduler.intervalMinutes) + 'm', scheduler.enabled === false ? 'off' : 'on', scheduler.enabled === false ? 'cancelled' : 'completed'),
      configDetailRow('Scheduler Interval', configValue(scheduler.intervalMinutes) + 'm'),
      configDetailRow('Logging Level', logging.level || '--'),
      configDetailRow('Logging Dir', logging.dir || logging.logDir || '--'),
      configDetailRow('Role Defaults', Object.keys(s.agents && s.agents.defaults || {}).length + ' defaults', Object.keys(roles).length + ' role overrides'),
      configDetailRow('Provider Risk', dangerousProviders.length + ' flagged', dangerousProviders.length ? dangerousProviders.join(', ') : 'no elevated providers', dangerousProviders.length ? 'risk' : 'ok', dangerousProviders.length ? 'failed' : 'completed'),
    ]);
    html += '</div></div>';
    return html;
  }

  function providerNetworkAccess(provider) {
    if (!provider) return null;
    if (provider.network != null) return provider.network;
    if (provider.networkAccess != null) return provider.networkAccess;
    if (provider.network_access != null) return provider.network_access;
    return null;
  }

  function providerPermissionRisk(provider) {
    if (!provider) return { badge: 'unknown', badgeClass: 'pending', elevated: false };
    if (provider.dangerouslySkipPermissions || provider.approval === 'never' || provider.bare || provider.sandbox === 'danger-full-access') {
      return { badge: 'elevated', badgeClass: 'failed', elevated: true };
    }
    if (provider.search || providerNetworkAccess(provider)) return { badge: 'review', badgeClass: 'pending', elevated: false };
    return { badge: 'bounded', badgeClass: 'completed', elevated: false };
  }

  function providerPermissionsPayload() {
    var summary = settingsData.summary || {};
    var providers = summary.agents && summary.agents.providers || {};
    var rows = Object.keys(providers).sort().map(function(name) {
      var provider = providers[name] || {};
      var risk = providerPermissionRisk(provider);
      return {
        name: name,
        type: provider.type || null,
        sandbox: provider.sandbox || null,
        approval: provider.approval || null,
        network: providerNetworkAccess(provider),
        search: !!provider.search,
        mcpMode: provider.mcpMode || null,
        bare: !!provider.bare,
        dangerouslySkipPermissions: !!provider.dangerouslySkipPermissions,
        cwd: provider.cwd || null,
        elevated: risk.elevated,
        risk: risk.badge,
      };
    });
    return {
      exportedAt: new Date().toISOString(),
      configLoaded: !!settingsData.summary,
      error: settingsData.error || null,
      summary: {
        total: rows.length,
        elevated: rows.filter(function(row) { return row.elevated; }).length,
        searchEnabled: rows.filter(function(row) { return row.search; }).length,
        networkConfigured: rows.filter(function(row) { return row.network != null && row.network !== false; }).length,
      },
      providers: rows,
    };
  }

  function renderProviderPermissionsMatrix(summary) {
    var providers = summary && summary.agents && summary.agents.providers || {};
    var names = Object.keys(providers).sort();
    var payload = providerPermissionsPayload();
    var html = '<div class="workbench-panel wide provider-permissions-panel"><div class="panel-title"><span>Provider Permissions</span><div class="panel-actions">';
    html += '<span>' + payload.summary.elevated + ' elevated · ' + payload.summary.searchEnabled + ' search</span>';
    html += '<button class="mini-btn" onclick="copyProviderPermissions()">Copy Matrix</button>';
    html += '<button class="mini-btn" onclick="exportProviderPermissions()">Export Matrix</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromProviderPermissions()">Create Task</button>';
    html += '</div></div>';
    if (names.length === 0) {
      html += '<div class="empty compact">No providers are configured.</div></div>';
      return html;
    }
    html += '<div class="panel-list compact">';
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var p = providers[name] || {};
      var risk = providerPermissionRisk(p);
      var network = providerNetworkAccess(p);
      var parts = [
        'sandbox ' + configValue(p.sandbox),
        'approval ' + configValue(p.approval),
        'network ' + configValue(network),
        'search ' + (p.search ? 'on' : 'off'),
        'mcp ' + configValue(p.mcpMode),
        'cwd ' + configValue(p.cwd),
      ];
      html += '<div class="panel-row provider-permission-row">';
      html += '<span class="badge ' + esc(risk.badgeClass) + '">' + esc(risk.badge) + '</span>';
      html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(name) + ' <span class="muted mono">' + esc(p.type || '--') + '</span></div>';
      html += '<div class="panel-row-sub">' + esc(parts.join(' · ')) + '</div></div>';
      html += '<div class="panel-actions settings-row-actions">';
      html += '<button class="chat-msg-action" onclick="copySettingsProvider(\'' + jsq(name) + '\')">Provider</button>';
      html += '<button class="chat-msg-action" onclick="copyProviderPermissionRow(\'' + jsq(name) + '\')">Copy Row</button>';
      html += '<button class="chat-msg-action" onclick="exportProviderPermissionRow(\'' + jsq(name) + '\')">Export Row</button>';
      html += '<button class="chat-msg-action" onclick="createTaskFromProviderPermissionRow(\'' + jsq(name) + '\')">Create Task</button>';
      html += '</div></div>';
    }
    html += '</div></div>';
    return html;
  }

  function renderSettingsSafetyPanel(summary) {
    var hasSummary = !!summary;
    var safety = summary && summary.safety || {};
    var consoleCfg = summary && summary.console || {};
    var providers = summary && summary.agents && summary.agents.providers || {};
    var flagged = safety.dangerousProviders || [];
    var providerNames = Object.keys(providers);
    var searchEnabled = providerNames.filter(function(name) { return providers[name] && providers[name].search; }).length;
    var warnings = [];
    if (!hasSummary) {
      warnings.push('Runtime config summary is unavailable; safety posture cannot be verified.');
      if (settingsData.error) warnings.push(settingsData.error);
    } else {
      if (!consoleCfg.tokenConfigured) warnings.push('Web console token is not configured.');
      if (safety.localOnly !== true) warnings.push('Console bind should be checked.');
      for (var wi = 0; wi < flagged.length; wi++) {
        warnings.push('Provider ' + flagged[wi].name + ' has elevated local permissions.');
      }
    }
    var postureClass = !hasSummary ? 'pending' : (warnings.length === 0 ? 'ok' : (warnings.length <= 2 ? 'pending' : 'failed'));
    var postureLabel = !hasSummary ? 'Unknown' : (warnings.length === 0 ? 'Ready' : (warnings.length <= 2 ? 'Watch' : 'Risk'));
    var html = '<div class="workbench-panel wide safety-posture-panel"><div class="panel-title"><span>Safety</span><div class="panel-actions">';
    html += '<span>' + (hasSummary ? flagged.length : '--') + ' flagged · ' + dangerApprovalQueue.length + ' pending</span>';
    html += '<button class="mini-btn" onclick="copySafetyReport()">Copy Report</button>';
    html += '<button class="mini-btn" onclick="exportSafetyReport()">Export Report</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromSafetyReport()">Create Task</button>';
    html += '</div></div>';
    html += '<div class="safety-posture-summary">';
    html += '<div><span>Posture</span><strong><span class="badge ' + postureClass + '">' + postureLabel + '</span></strong><em>' + warnings.length + ' warnings</em></div>';
    html += '<div><span>Bind</span><strong>' + esc(!hasSummary ? 'unknown' : (safety.localOnly ? '127.0.0.1' : 'check')) + '</strong><em>' + esc(!hasSummary ? 'unverified' : (safety.localOnly ? 'local only' : 'review bind')) + '</em></div>';
    html += '<div><span>Token</span><strong>' + esc(!hasSummary ? 'unknown' : (consoleCfg.tokenConfigured ? 'on' : 'off')) + '</strong><em>' + esc(!hasSummary ? 'unverified' : (consoleCfg.tokenConfigured ? 'API protected' : 'local trust only')) + '</em></div>';
    html += '<div><span>Search</span><strong>' + (hasSummary ? searchEnabled : '--') + '</strong><em>providers enabled</em></div>';
    html += '</div>';
    html += '<div class="panel-list">';
    if (!hasSummary) {
      html += '<div class="panel-row"><span class="badge pending">unknown</span><div class="panel-row-main"><div class="panel-row-title">Config Summary</div><div class="panel-row-sub">' + esc(settingsData.error || 'runtime config summary has not loaded') + '</div></div></div>';
    }
    html += '<div class="panel-row"><span class="badge ' + (hasSummary && safety.localOnly ? 'ok' : 'pending') + '">' + (hasSummary ? (safety.localOnly ? 'ok' : 'risk') : 'unknown') + '</span><div class="panel-row-main"><div class="panel-row-title">Local Only</div><div class="panel-row-sub">' + (hasSummary ? (safety.localOnly ? 'Web console binds to 127.0.0.1' : 'Check bind configuration') : 'Cannot verify bind configuration without config summary') + '</div></div></div>';
    html += '<div class="panel-row"><span class="badge ' + (hasSummary && consoleCfg.tokenConfigured ? 'ok' : 'pending') + '">' + (hasSummary ? (consoleCfg.tokenConfigured ? 'on' : 'off') : 'unknown') + '</span><div class="panel-row-main"><div class="panel-row-title">Web Console Token</div><div class="panel-row-sub">' + (hasSummary ? (consoleCfg.tokenConfigured ? 'HTTP APIs and WebSocket can require the configured token' : 'No token configured; rely on localhost boundary') : 'Cannot verify token configuration without config summary') + '</div></div></div>';
    html += '<div class="panel-row"><span class="badge pending">queue</span><div class="panel-row-main"><div class="panel-row-title">Dangerous actions require queue approval</div><div class="panel-row-sub">Flush, Clear, Esc, Restart, delete cron, close web chats, send attachment, task cancellation and history cleanup</div></div></div>';
    if (warnings.length) {
      html += '<div class="safety-warning-list">';
      for (var w = 0; w < warnings.length; w++) {
        html += '<div class="safety-warning-row"><span class="badge ' + (w === 0 && !consoleCfg.tokenConfigured ? 'pending' : 'failed') + '">warn</span><div>' + esc(warnings[w]) + '</div><div class="panel-actions">';
        html += '<button class="chat-msg-action" onclick="copySafetyWarning(' + w + ')">Copy</button>';
        html += '<button class="chat-msg-action" onclick="exportSafetyWarning(' + w + ')">Export</button>';
        html += '<button class="chat-msg-action" onclick="createTaskFromSafetyWarning(' + w + ')">Create Task</button>';
        html += '</div></div>';
      }
      html += '</div>';
    }
    for (var d = 0; d < flagged.length; d++) {
      var dp = flagged[d];
      html += '<div class="panel-row"><span class="badge failed">risk</span><div class="panel-row-main"><div class="panel-row-title">' + esc(dp.name) + '</div><div class="panel-row-sub">' +
        (dp.dangerouslySkipPermissions ? 'skip permissions · ' : '') +
        (dp.sandbox ? 'sandbox ' + esc(dp.sandbox) + ' · ' : '') +
        (dp.approval ? 'approval ' + esc(dp.approval) : '') +
        '</div></div><div class="panel-actions settings-row-actions">' +
        '<button class="chat-msg-action" onclick="copySafetyProviderRisk(' + d + ')">Copy</button>' +
        '<button class="chat-msg-action" onclick="exportSafetyProviderRisk(' + d + ')">Export</button>' +
        '<button class="chat-msg-action" onclick="createTaskFromSafetyProviderRisk(' + d + ')">Create Task</button>' +
        '</div></div>';
    }
    html += renderDangerApprovalQueue();
    html += '</div></div>';
    return html;
  }

  function settingsSummaryPayload() {
    var summary = settingsData.summary || {};
    return {
      exportedAt: new Date().toISOString(),
      error: settingsData.error || null,
      console: summary.console || null,
      feishu: summary.feishu || null,
      director: summary.director || null,
      pool: summary.pool || null,
      task: summary.task || null,
      scheduler: summary.scheduler || null,
      logging: summary.logging || null,
      agents: summary.agents || null,
      configAssets: {
        configFiles: (configAssetsData.configFiles || []).map(function(file) {
          return {
            label: file.label,
            path: file.path,
            exists: !!file.exists,
            size: file.size || 0,
            mtimeMs: file.mtimeMs || null,
          };
        }),
        mcpConfigs: (configAssetsData.mcpConfigs || []).map(function(cfg) {
          return {
            label: cfg.label,
            path: cfg.path,
            exists: !!cfg.exists,
            parseError: cfg.parseError || null,
            servers: (cfg.servers || []).map(function(server) {
              return {
                name: server.name,
                command: server.command,
                args: server.args || [],
                envKeys: server.envKeys || [],
                disabled: !!server.disabled,
              };
            }),
          };
        }),
      },
    };
  }

  function settingsProviderPayload(name) {
    var summary = settingsData.summary || {};
    var providers = summary.agents && summary.agents.providers || {};
    var provider = providers[name] || null;
    var flagged = (summary.safety && summary.safety.dangerousProviders || []).filter(function(item) { return item.name === name; });
    var roles = summary.agents && summary.agents.roles || {};
    var defaults = summary.agents && summary.agents.defaults || {};
    var defaultFor = Object.keys(defaults).filter(function(key) { return defaults[key] === name; });
    var roleOverrides = Object.keys(roles).filter(function(role) {
      var cfg = roles[role] || {};
      return cfg.provider === name || cfg.agent === name;
    });
    return {
      exportedAt: new Date().toISOString(),
      providerName: name,
      provider: provider,
      risk: flagged[0] || null,
      defaultFor: defaultFor,
      roleOverrides: roleOverrides,
      configLoaded: !!settingsData.summary,
      error: settingsData.error || null,
    };
  }

  function settingsRoleDefaultPayload(key) {
    var summary = settingsData.summary || {};
    var defaults = summary.agents && summary.agents.defaults || {};
    var providerName = defaults[key] || '';
    return {
      exportedAt: new Date().toISOString(),
      defaultKey: key,
      providerName: providerName,
      provider: providerName ? settingsProviderPayload(providerName).provider : null,
      configLoaded: !!settingsData.summary,
      error: settingsData.error || null,
    };
  }

  function settingsRoleOverridePayload(role) {
    var summary = settingsData.summary || {};
    var roles = summary.agents && summary.agents.roles || {};
    var override = roles[role] || null;
    var providerName = override && (override.provider || override.agent) || '';
    return {
      exportedAt: new Date().toISOString(),
      role: role,
      override: override,
      providerName: providerName,
      provider: providerName ? settingsProviderPayload(providerName).provider : null,
      configLoaded: !!settingsData.summary,
      error: settingsData.error || null,
    };
  }

  function safetyReportPayload() {
    var hasSummary = !!settingsData.summary;
    var summary = settingsData.summary || {};
    var consoleCfg = summary.console || {};
    var safety = summary.safety || {};
    var providers = summary.agents && summary.agents.providers || {};
    var providerNames = Object.keys(providers);
    var searchProviders = providerNames.filter(function(name) { return providers[name] && providers[name].search; });
    var flagged = safety.dangerousProviders || [];
    var warnings = [];
    if (!hasSummary) {
      warnings.push('Runtime config summary is unavailable; safety posture cannot be verified.');
      if (settingsData.error) warnings.push(settingsData.error);
    } else {
      if (!consoleCfg.tokenConfigured) warnings.push('Web console token is not configured.');
      if (safety.localOnly !== true) warnings.push('Console bind should be checked.');
      for (var i = 0; i < flagged.length; i++) {
        warnings.push('Provider ' + flagged[i].name + ' has elevated local permissions.');
      }
    }
    return {
      exportedAt: new Date().toISOString(),
      configLoaded: hasSummary,
      error: settingsData.error || null,
      posture: !hasSummary ? 'unknown' : (warnings.length === 0 ? 'ready' : (warnings.length <= 2 ? 'watch' : 'risk')),
      warnings: warnings,
      console: {
        bind: hasSummary ? (consoleCfg.bind || '127.0.0.1') : null,
        port: consoleCfg.port || null,
        tokenConfigured: !!consoleCfg.tokenConfigured,
        enabled: hasSummary ? consoleCfg.enabled !== false : null,
      },
      localOnly: hasSummary ? safety.localOnly === true : null,
      searchProviders: searchProviders,
      dangerousProviders: flagged,
      providerPermissions: providerPermissionsPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
  }

  function safetyWarningPayload(index) {
    var report = safetyReportPayload();
    var warning = (report.warnings || [])[index];
    return {
      exportedAt: new Date().toISOString(),
      index: index,
      warning: warning || null,
      posture: report.posture,
      configLoaded: report.configLoaded,
      console: report.console,
      localOnly: report.localOnly,
      searchProviders: report.searchProviders,
      dangerousProviders: report.dangerousProviders,
      approvalQueue: {
        count: report.approvalQueue && report.approvalQueue.count || 0,
        entries: report.approvalQueue && report.approvalQueue.entries || [],
      },
    };
  }

  function safetyProviderRiskPayload(index) {
    var report = safetyReportPayload();
    var provider = (report.dangerousProviders || [])[index];
    var providerName = provider && provider.name || '';
    return {
      exportedAt: new Date().toISOString(),
      index: index,
      provider: provider || null,
      config: providerName ? settingsProviderPayload(providerName).provider : null,
      posture: report.posture,
      console: report.console,
      localOnly: report.localOnly,
      warnings: report.warnings,
    };
  }

  function safetyTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench safety handoff as task context.',
      '',
      'Operator intent:',
      '- Review this security report or configuration risk and identify the safest remediation.',
      '- Use the safety report, warning/provider evidence, provider permissions, console token/local bind state, and approval queue context before acting.',
      '- If config edits are needed, keep them scoped, preserve intended provider behavior, and verify with repository checks.',
      '- Do not weaken sandbox, approval, or network boundaries unless the task prompt is explicitly edited to request that.',
      '',
      'Safety handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function providerPermissionTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench provider permission handoff as task context.',
      '',
      'Operator intent:',
      '- Review this provider permission matrix or row and decide whether permissions should be narrowed.',
      '- Use the selected evidence, provider config, full provider permissions matrix, Settings summary, and safety report before acting.',
      '- If config changes are needed, keep them scoped and preserve intended provider behavior.',
      '- Do not weaken sandbox, approval, network, MCP, or cwd boundaries unless the task prompt is explicitly edited.',
      '',
      'Provider permission handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function settingsConfigTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench settings configuration handoff as task context.',
      '',
      'Operator intent:',
      '- Review the selected runtime config, provider, role default, or role override evidence before changing configuration.',
      '- Use the settings summary, provider permissions matrix, safety posture, config assets, environment checks, and approval context before acting.',
      '- If config edits are needed, keep them scoped, preserve intended provider and role behavior, and verify with repository checks.',
      '- Do not weaken sandbox, approval, network, MCP, cwd, or token boundaries unless the task prompt is explicitly edited.',
      '',
      'Settings configuration handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function settingsConfigTaskContext(type, evidence) {
    return {
      exportedAt: new Date().toISOString(),
      type: type,
      evidence: evidence || null,
      settings: settingsSummaryPayload(),
      providerPermissions: providerPermissionsPayload(),
      safety: safetyReportPayload(),
      configAssets: configAssetsReport(),
      environment: envCheckReport(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
  }

  function openSettingsConfigTask(payload, description) {
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: description,
      prompt: settingsConfigTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Settings config loaded into task form', true);
  }

  window.copySettingsSummary = function() {
    copyText(JSON.stringify(settingsSummaryPayload(), null, 2));
  };

  window.exportSettingsSummary = function() {
    downloadTextFile('persona-settings-summary-' + Date.now() + '.json', JSON.stringify(settingsSummaryPayload(), null, 2));
    showToast('Settings summary exported', true);
  };

  window.createTaskFromSettingsSummary = function() {
    openSettingsConfigTask(settingsConfigTaskContext('settingsSummary', settingsSummaryPayload()), 'Review runtime config summary');
  };

  window.copyProviderPermissions = function() {
    copyText(JSON.stringify(providerPermissionsPayload(), null, 2));
  };

  window.exportProviderPermissions = function() {
    downloadTextFile('persona-provider-permissions-' + Date.now() + '.json', JSON.stringify(providerPermissionsPayload(), null, 2));
    showToast('Provider permissions exported', true);
  };

  window.createTaskFromProviderPermissions = function() {
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'providerPermissionMatrix',
      matrix: providerPermissionsPayload(),
      settings: settingsSummaryPayload(),
      safety: safetyReportPayload(),
      configAssets: configAssetsReport(),
      environment: envCheckReport(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review provider permissions matrix',
      prompt: providerPermissionTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Provider permissions matrix loaded into task form', true);
  };

  window.copyProviderPermissionRow = function(name) {
    var row = (providerPermissionsPayload().providers || []).find(function(item) { return item.name === name; });
    if (!row) {
      showToast('Provider permission row not found', false);
      return;
    }
    copyText(JSON.stringify(row, null, 2));
  };

  window.exportProviderPermissionRow = function(name) {
    var row = (providerPermissionsPayload().providers || []).find(function(item) { return item.name === name; });
    if (!row) {
      showToast('Provider permission row not found', false);
      return;
    }
    downloadTextFile('persona-provider-permission-' + safeAssetName(name, 'provider') + '-' + Date.now() + '.json', JSON.stringify(row, null, 2));
    showToast('Provider permission exported', true);
  };

  window.createTaskFromProviderPermissionRow = function(name) {
    var row = (providerPermissionsPayload().providers || []).find(function(item) { return item.name === name; });
    if (!row) {
      showToast('Provider permission row not found', false);
      return;
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'providerPermissionRow',
      row: row,
      provider: settingsProviderPayload(name),
      matrix: providerPermissionsPayload(),
      safety: safetyReportPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review provider permissions: ' + name,
      prompt: providerPermissionTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Provider permission loaded into task form', true);
  };

  window.copySafetyReport = function() {
    copyText(JSON.stringify(safetyReportPayload(), null, 2));
  };

  window.exportSafetyReport = function() {
    downloadTextFile('persona-safety-report-' + Date.now() + '.json', JSON.stringify(safetyReportPayload(), null, 2));
    showToast('Safety report exported', true);
  };

  window.createTaskFromSafetyReport = function() {
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'safetyReport',
      safetyReport: safetyReportPayload(),
      settings: settingsSummaryPayload(),
      providerPermissions: providerPermissionsPayload(),
      configAssets: configAssetsReport(),
      environment: envCheckReport(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review Workbench safety posture',
      prompt: safetyTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Safety report loaded into task form', true);
  };

  window.copySafetyWarning = function(index) {
    var payload = safetyWarningPayload(index);
    if (!payload.warning) {
      showToast('Safety warning not found', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportSafetyWarning = function(index) {
    var payload = safetyWarningPayload(index);
    if (!payload.warning) {
      showToast('Safety warning not found', false);
      return;
    }
    downloadTextFile('persona-safety-warning-' + safeAssetName(payload.warning, 'warning') + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Safety warning exported', true);
  };

  window.createTaskFromSafetyWarning = function(index) {
    var payload = safetyWarningPayload(index);
    if (!payload.warning) {
      showToast('Safety warning not found', false);
      return;
    }
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review safety warning: ' + shortText(payload.warning, 80),
      prompt: safetyTaskPromptPayload({ type: 'safetyWarning', warning: payload, safetyReport: safetyReportPayload() }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Safety warning loaded into task form', true);
  };

  window.copySafetyProviderRisk = function(index) {
    var payload = safetyProviderRiskPayload(index);
    if (!payload.provider) {
      showToast('Safety provider risk not found', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportSafetyProviderRisk = function(index) {
    var payload = safetyProviderRiskPayload(index);
    if (!payload.provider) {
      showToast('Safety provider risk not found', false);
      return;
    }
    downloadTextFile('persona-safety-provider-risk-' + safeAssetName(payload.provider.name || 'provider', 'provider') + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Safety provider risk exported', true);
  };

  window.createTaskFromSafetyProviderRisk = function(index) {
    var payload = safetyProviderRiskPayload(index);
    if (!payload.provider) {
      showToast('Safety provider risk not found', false);
      return;
    }
    var providerName = payload.provider && payload.provider.name || 'provider';
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review provider safety risk: ' + providerName,
      prompt: safetyTaskPromptPayload({ type: 'providerRisk', providerRisk: payload, safetyReport: safetyReportPayload() }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Provider risk loaded into task form', true);
  };

  window.copySettingsProvider = function(name) {
    if (!settingsProviderPayload(name).provider) {
      showToast('Provider not found', false);
      return;
    }
    copyText(JSON.stringify(settingsProviderPayload(name), null, 2));
  };

  window.exportSettingsProvider = function(name) {
    var payload = settingsProviderPayload(name);
    if (!payload.provider) {
      showToast('Provider not found', false);
      return;
    }
    downloadTextFile('persona-provider-' + safeAssetName(name, 'provider') + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Provider config exported', true);
  };

  window.createTaskFromSettingsProvider = function(name) {
    var payload = settingsProviderPayload(name);
    if (!payload.provider) {
      showToast('Provider not found', false);
      return;
    }
    openSettingsConfigTask(settingsConfigTaskContext('settingsProvider', payload), 'Review provider config: ' + name);
  };

  window.copySettingsRoleDefault = function(key) {
    var payload = settingsRoleDefaultPayload(key);
    if (!payload.providerName) {
      showToast('Role default not found', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportSettingsRoleDefault = function(key) {
    var payload = settingsRoleDefaultPayload(key);
    if (!payload.providerName) {
      showToast('Role default not found', false);
      return;
    }
    downloadTextFile('persona-role-default-' + safeAssetName(key, 'default') + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Role default exported', true);
  };

  window.createTaskFromSettingsRoleDefault = function(key) {
    var payload = settingsRoleDefaultPayload(key);
    if (!payload.providerName) {
      showToast('Role default not found', false);
      return;
    }
    openSettingsConfigTask(settingsConfigTaskContext('settingsRoleDefault', payload), 'Review role default: ' + key);
  };

  window.copySettingsRoleOverride = function(role) {
    var payload = settingsRoleOverridePayload(role);
    if (!payload.override) {
      showToast('Role override not found', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportSettingsRoleOverride = function(role) {
    var payload = settingsRoleOverridePayload(role);
    if (!payload.override) {
      showToast('Role override not found', false);
      return;
    }
    downloadTextFile('persona-role-override-' + safeAssetName(role, 'role') + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Role override exported', true);
  };

  window.createTaskFromSettingsRoleOverride = function(role) {
    var payload = settingsRoleOverridePayload(role);
    if (!payload.override) {
      showToast('Role override not found', false);
      return;
    }
    openSettingsConfigTask(settingsConfigTaskContext('settingsRoleOverride', payload), 'Review role override: ' + role);
  };

  function renderAuditLogPanel() {
    var entries = auditData.entries || [];
    var visibleEntries = filteredAuditEntries();
    var html = '<div class="workbench-panel wide audit-panel"><div class="panel-title"><span>Operation Audit</span><div class="panel-actions">';
    html += '<button class="mini-btn" onclick="loadAuditLog()">' + (auditData.loading ? 'Loading...' : 'Refresh') + '</button>';
    if (entries.length > 0) {
      html += '<button class="mini-btn" onclick="copyAuditLog()">Copy</button>';
      html += '<button class="mini-btn" onclick="exportAuditLog()">Export</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromAuditLog()">Create Task</button>';
    }
    html += '</div></div>';
    if (auditData.path) {
      html += '<div class="file-path mono" style="margin-bottom:10px">' + esc(auditData.path) + '</div>';
    }
    if (entries.length > 0) {
      html += renderAuditFilters(entries, visibleEntries);
    }
    if (auditData.loading) {
      html += '<div class="td-result-running"><div class="spinner"></div><span>Loading audit log...</span></div>';
    } else if (auditData.error) {
      html += '<div class="td-error compact">' + esc(auditData.error) + '</div>';
    } else if (entries.length === 0) {
      html += '<div class="empty">No audited Web Console operations yet.</div>';
    } else if (visibleEntries.length === 0) {
      html += '<div class="empty">No audit entries match the current filters.</div>';
    } else {
      html += '<div class="audit-list">';
      for (var i = 0; i < Math.min(visibleEntries.length, 60); i++) {
        var entry = visibleEntries[i];
        var detail = entry.detail || {};
        var detailParts = [];
        if (entry.target) detailParts.push('target ' + entry.target);
        if (detail.correlationId) detailParts.push('cid ' + detail.correlationId);
        if (detail.error) detailParts.push('error ' + shortText(detail.error, 120));
        if (detail.path) detailParts.push(detail.path);
        html += '<div class="audit-row"><span class="badge ' + (entry.ok ? 'completed' : 'failed') + '">' + (entry.ok ? 'ok' : 'fail') + '</span>';
        html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(entry.action || 'operation') + '</div>';
        html += '<div class="panel-row-sub">' + esc(fmtTimestamp(Date.parse(entry.timestamp)) || entry.timestamp || '--') + (detailParts.length ? ' · ' + esc(detailParts.join(' · ')) : '') + '</div></div>';
        html += '<div class="audit-row-actions">';
        if (auditEntryCanOpen(entry)) html += '<button class="chat-msg-action" onclick="openAuditEntryTarget(' + i + ')">Open Target</button>';
        html += '<button class="chat-msg-action" onclick="copyAuditEntry(' + i + ')">Copy JSON</button>';
        html += '<button class="chat-msg-action" onclick="exportAuditEntry(' + i + ')">Export</button>';
        html += '<button class="chat-msg-action" onclick="createTaskFromAuditEntry(' + i + ')">Create Task</button>';
        html += '</div></div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function auditEntryMatches(entry) {
    var filters = auditData.filters || {};
    var status = filters.status || 'all';
    if (status === 'ok' && !entry.ok) return false;
    if (status === 'failed' && entry.ok) return false;
    var action = filters.action || 'all';
    if (action !== 'all' && entry.action !== action) return false;
    var query = String(filters.query || '').trim().toLowerCase();
    if (!query) return true;
    var haystack = [
      entry.action,
      entry.timestamp,
      entry.actor,
      entry.target,
      entry.ok ? 'ok success completed' : 'fail failed error',
      entry.detail ? JSON.stringify(entry.detail) : '',
    ].filter(Boolean).join('\n').toLowerCase();
    return haystack.indexOf(query) >= 0;
  }

  function filteredAuditEntries() {
    return (auditData.entries || []).filter(auditEntryMatches);
  }

  function auditEntryTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench audit entry handoff as task context.',
      '',
      'Operator intent:',
      '- Review this specific Web Console operation audit entry.',
      '- If it failed, identify the likely cause and propose or implement a scoped fix.',
      '- If it succeeded but is high impact, verify the outcome and note any follow-up risk.',
      '- Use the audit entry first, then compare it with the visible audit filter context.',
      '',
      'Audit entry handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function auditEntryPath(entry) {
    var detail = entry && entry.detail || {};
    if (Array.isArray(detail.files) && detail.files.length > 0) return detail.files[0] || '';
    return detail.path || detail.target || entry && entry.target || '';
  }

  function auditEntryCanOpen(entry) {
    var action = String(entry && entry.action || '');
    var target = String(entry && entry.target || '');
    var path = auditEntryPath(entry);
    if (/^task\./.test(action) && target) return true;
    if (action === 'task.cleanup') return true;
    if (/^cron\./.test(action) && target) return true;
	    if (/^(file|attachment)\./.test(action) && path) return true;
    if (/^state\./.test(action) && path) return true;
	    if (/^persona\.doc\./.test(action) && path) return true;
	    if (/^persona\.session_link\./.test(action) && (target || entry && entry.detail)) return true;
	    if (/^director\./.test(action) && target) return true;
    if (/^debug\.simulate_task_completion$/.test(action) && target) return true;
    if (/^session\./.test(action) && target) return true;
    if (/^web_session\./.test(action) && target) return true;
    if (/^queue\./.test(action) && (target || entry && entry.detail && entry.detail.correlationId)) return true;
    return false;
  }

  function auditActionOptions(entries) {
    var seen = {};
    var options = [];
    for (var i = 0; i < entries.length; i++) {
      var action = entries[i].action || 'operation';
      if (!seen[action]) {
        seen[action] = true;
        options.push(action);
      }
    }
    return options.sort();
  }

  function renderAuditFilters(entries, visibleEntries) {
    var filters = auditData.filters || {};
    var actions = auditActionOptions(entries);
    var html = '<div class="audit-filters">';
    html += '<label class="audit-filter-search"><span>Search</span><input value="' + esc(filters.query || '') + '" placeholder="action, target, path, error..." oninput="setAuditFilter(\'query\', this.value)"></label>';
    html += '<label><span>Status</span><select onchange="setAuditFilter(\'status\', this.value)">';
    var statuses = [['all', 'All'], ['ok', 'OK'], ['failed', 'Failed']];
    for (var s = 0; s < statuses.length; s++) {
      html += '<option value="' + statuses[s][0] + '"' + ((filters.status || 'all') === statuses[s][0] ? ' selected' : '') + '>' + statuses[s][1] + '</option>';
    }
    html += '</select></label>';
    html += '<label><span>Action</span><select onchange="setAuditFilter(\'action\', this.value)">';
    html += '<option value="all"' + ((filters.action || 'all') === 'all' ? ' selected' : '') + '>All actions</option>';
    for (var i = 0; i < actions.length; i++) {
      html += '<option value="' + esc(actions[i]) + '"' + (filters.action === actions[i] ? ' selected' : '') + '>' + esc(actions[i]) + '</option>';
    }
    html += '</select></label>';
    html += '<button class="mini-btn" onclick="clearAuditFilters()">Clear</button>';
    html += '<span class="muted mono">' + visibleEntries.length + '/' + entries.length + '</span>';
    html += '</div>';
    return html;
  }

  window.setAuditFilter = function(key, value) {
    auditData.filters = auditData.filters || { query: '', status: 'all', action: 'all' };
    if (key === 'query') auditData.filters.query = String(value || '');
    if (key === 'status') auditData.filters.status = value || 'all';
    if (key === 'action') auditData.filters.action = value || 'all';
    if (viewMode === 'settings') renderSettingsView();
  };

  window.clearAuditFilters = function() {
    auditData.filters = { query: '', status: 'all', action: 'all' };
    if (viewMode === 'settings') renderSettingsView();
  };

  window.copyAuditEntry = function(index) {
    var entry = filteredAuditEntries()[index];
    if (!entry) {
      showToast('Audit entry not found', false);
      return;
    }
    copyText(JSON.stringify(entry, null, 2));
  };

  window.exportAuditEntry = function(index) {
    var entry = filteredAuditEntries()[index];
    if (!entry) {
      showToast('Audit entry not found', false);
      return;
    }
    var safe = String(entry.action || 'audit-entry').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-audit-entry-' + safe + '-' + Date.now() + '.json', JSON.stringify(entry, null, 2));
    showToast('Audit entry exported', true);
  };

  window.createTaskFromAuditEntry = function(index) {
    var entry = filteredAuditEntries()[index];
    if (!entry) {
      showToast('Audit entry not found', false);
      return;
    }
    var action = entry.action || 'operation';
    var target = entry.target || auditEntryPath(entry) || '';
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'auditEntry',
      auditPath: auditData.path || '',
      filters: auditData.filters || {},
      visibleCount: filteredAuditEntries().length,
      entry: entry,
      canOpenTarget: auditEntryCanOpen(entry),
      targetPath: auditEntryPath(entry),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: (entry.ok ? 'Review audited operation: ' : 'Investigate failed operation: ') + shortText(action + (target ? ' ' + target : ''), 80),
      prompt: auditEntryTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Audit entry loaded into task form', true);
  };

  window.openAuditEntryTarget = function(index) {
    var entry = filteredAuditEntries()[index];
    if (!entry) {
      showToast('Audit entry not found', false);
      return;
    }
    var action = String(entry.action || '');
    var target = String(entry.target || '');
    var path = auditEntryPath(entry);
    if (action === 'task.cleanup') {
      selectNav('tasks');
      return;
    }
    if (/^task\./.test(action) && target) {
      selectTask(target);
      return;
    }
    if (/^cron\./.test(action) && target) {
      selectedAutomationCronId = target;
      editingCronId = null;
      selectNav('automations');
      return;
    }
    if (/^(file|attachment)\./.test(action) && path) {
      openWorkbenchFile(path);
      return;
    }
    if (/^state\./.test(action) && path) {
      selectNav('persona');
      setTimeout(function() { selectPersonaAssetDoc(path); }, 250);
      return;
    }
	    if (/^persona\.doc\./.test(action) && path) {
	      selectNav('persona');
	      setTimeout(function() { selectPersonaAssetDoc(path); }, 250);
	      return;
	    }
	    if (/^persona\.session_link\./.test(action)) {
	      var detail = entry.detail || {};
	      var linkKey = personaSessionLinkKeyFromAudit(entry);
	      personaSessionLinkFocusKey = linkKey;
	      if (detail.channel || detail.externalId || detail.directorLabel || detail.role) {
	        personaData.sessionLinkDraft = {
	          channel: detail.channel || (linkKey.split(':')[0] || 'web'),
	          external_id: detail.externalId || linkKey.split(':').slice(1).join(':'),
	          persona_session_id: detail.personaSessionId || '',
	          codex_thread_id: detail.codexThreadId || '',
	          director_label: detail.directorLabel || detail.director_label || 'main',
	          role: detail.role || personaData.selectedRole || '',
	        };
	      }
	      selectNav('persona');
	      scrollPersonaSessionLinkIntoView(linkKey);
	      return;
	    }
    if (/^director\./.test(action) && target) {
      if (target === 'main') selectSession(null);
      else selectPoolDirector(target, target);
      return;
    }
    if (/^debug\.simulate_task_completion$/.test(action) && target) {
      selectTask(target);
      return;
    }
    if (/^session\./.test(action) && target) {
      var sessionDetail = entry.detail || {};
      selectSubSession(sessionDetail.director || sessionDetail.directorLabel || 'main', target, sessionDetail.sessionName || target.slice(0, 16));
      return;
    }
    if (/^web_session\./.test(action) && target) {
      selectPoolDirector(target, target);
      return;
    }
    if (/^queue\./.test(action)) {
      var detail = entry.detail || {};
      var correlationId = String(detail.correlationId || (/^cid-/.test(target) ? target : ''));
      var directorLabel = String(detail.director_label || detail.directorLabel || detail.director || (!/^cid-/.test(target) && target ? target : 'main'));
      focusRuntimeActiveWork(directorLabel || 'main', correlationId);
      return;
    }
    showToast('No supported target for this audit entry', false);
  };

  function auditLogPayload() {
    var entries = filteredAuditEntries();
    var failed = entries.filter(function(entry) { return !entry.ok; });
    var highImpact = entries.filter(function(entry) {
      return /^(task|cron|queue|attachment|file|state|persona|director|debug)\./.test(String(entry.action || ''));
    });
    return {
      exportedAt: new Date().toISOString(),
      path: auditData.path || '',
      filters: auditData.filters || {},
      totalEntries: (auditData.entries || []).length,
      visibleCount: entries.length,
      failedCount: failed.length,
      highImpactCount: highImpact.length,
      entries: entries,
      summary: {
        failed: failed.slice(0, 20),
        highImpact: highImpact.slice(0, 20),
        actions: fileCountBy(entries, function(entry) { return entry.action || 'operation'; }),
        statuses: fileCountBy(entries, function(entry) { return entry.ok ? 'ok' : 'failed'; }),
      },
    };
  }

  function auditLogTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench operation audit log as task context.',
      '',
      'Operator intent:',
      '- Review the visible Web Console operation audit trail before changing runtime, task, automation, file, persona, or settings state.',
      '- Use failed entries, high-impact operations, current filters, runtime snapshot, and approval context as evidence.',
      '- If the audit trail shows failed, repeated, risky, stale, or ambiguous operations, identify likely causes and propose or implement a scoped fix.',
      '- Do not repeat high-impact operations unless the task prompt is explicitly edited.',
      '',
      'Operation audit handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.copyAuditLog = function() {
    var payload = auditLogPayload();
    if (payload.visibleCount === 0) {
      showToast('No audit entries to copy', false);
      return;
    }
    copyText(JSON.stringify(payload, null, 2));
  };

  window.exportAuditLog = function() {
    var payload = auditLogPayload();
    if (payload.visibleCount === 0) {
      showToast('No audit entries to export', false);
      return;
    }
    downloadTextFile('persona-audit-log-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Audit log exported', true);
  };

  window.createTaskFromAuditLog = function() {
    var report = auditLogPayload();
    if (report.visibleCount === 0) {
      showToast('No audit entries to use', false);
      return;
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'auditLogReport',
      audit: report,
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review operation audit log: ' + String(report.visibleCount) + ' visible, ' + String(report.failedCount) + ' failed',
      prompt: auditLogTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Audit log loaded into task form', true);
  };

  function renderConfigAssetsPanel() {
    var files = configAssetsData.configFiles || [];
    var mcpConfigs = configAssetsData.mcpConfigs || [];
    var hasReport = files.length > 0 || mcpConfigs.length > 0 || (configAssetsData.skills || []).length > 0 || configAssetsData.error;
    var html = '<div class="workbench-panel wide config-assets-panel"><div class="panel-title"><span>Config Preview</span><div class="panel-actions">';
    html += '<button class="mini-btn" onclick="loadConfigAssets()">' + (configAssetsData.loading ? 'Loading...' : 'Refresh') + '</button>';
    if (hasReport) {
      html += '<button class="mini-btn" onclick="copyConfigAssets()">Copy Report</button>';
      html += '<button class="mini-btn" onclick="exportConfigAssets()">Export Report</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromConfigAssetsReport()">Create Task</button>';
    }
    html += '</div></div>';
    if (configAssetsData.loading) {
      html += '<div class="td-result-running"><div class="spinner"></div><span>Loading config assets...</span></div>';
    } else if (configAssetsData.error) {
      html += '<div class="td-error compact">' + esc(configAssetsData.error) + '</div>';
    } else {
      html += '<div class="config-assets-layout">';
      html += '<div><div class="diagnostic-section-title">Files</div><div class="config-file-list">';
      if (files.length === 0) {
        html += '<div class="empty compact">No config files found.</div>';
      } else {
        for (var i = 0; i < files.length; i++) {
          var file = files[i];
          html += '<div class="config-file-card">';
          html += '<div class="panel-row-title">' + esc(file.label || 'config') + ' <span class="badge ' + (file.exists ? 'completed' : 'cancelled') + '">' + (file.exists ? 'found' : 'missing') + '</span></div>';
          html += '<div class="panel-row-sub">' + esc(file.path || '--') + (file.size ? ' · ' + fmtFileSize(file.size) : '') + '</div>';
          html += '<div class="panel-actions config-card-actions">';
          if (file.path) html += '<button class="chat-msg-action" onclick="copyConfigAssetPath(' + i + ')">Copy Path</button>';
          if (file.content) html += '<button class="chat-msg-action" onclick="copyConfigAssetContent(' + i + ')">Copy Content</button>';
          html += '<button class="chat-msg-action" onclick="exportConfigAsset(' + i + ')">Export</button>';
          html += '<button class="chat-msg-action" onclick="createTaskFromConfigAsset(' + i + ')">Create Task</button>';
          html += '</div>';
          if (file.exists && file.content) html += '<pre class="config-preview">' + esc(file.content) + '</pre>';
          html += '</div>';
        }
      }
      html += '</div></div>';
      html += '<div><div class="diagnostic-section-title">MCP Servers</div><div class="config-file-list">';
      if (mcpConfigs.length === 0) {
        html += '<div class="empty compact">No MCP config files found.</div>';
      } else {
        for (var mi = 0; mi < mcpConfigs.length; mi++) {
          var cfg = mcpConfigs[mi];
          html += '<div class="config-file-card">';
          html += '<div class="panel-row-title">' + esc(cfg.label || 'mcp') + ' <span class="badge pending">' + esc(String((cfg.servers || []).length)) + ' servers</span></div>';
          html += '<div class="panel-row-sub">' + esc(cfg.path || '--') + '</div>';
          html += '<div class="panel-actions config-card-actions">';
          if (cfg.path) html += '<button class="chat-msg-action" onclick="copyMcpConfigPath(' + mi + ')">Copy Path</button>';
          html += '<button class="chat-msg-action" onclick="copyMcpConfigJson(' + mi + ')">Copy JSON</button>';
          html += '<button class="chat-msg-action" onclick="exportMcpConfigJson(' + mi + ')">Export</button>';
          html += '<button class="chat-msg-action" onclick="createTaskFromMcpConfig(' + mi + ')">Create Task</button>';
          html += '</div>';
          if (cfg.parseError) html += '<div class="td-error compact">' + esc(cfg.parseError) + '</div>';
          if (cfg.servers && cfg.servers.length) {
            html += '<div class="mcp-server-list">';
            for (var si = 0; si < cfg.servers.length; si++) {
              var server = cfg.servers[si];
              html += '<div class="mcp-server-row"><span class="badge ' + (server.disabled ? 'cancelled' : 'completed') + '">' + (server.disabled ? 'off' : 'on') + '</span>';
              html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(server.name || '--') + '</div>';
              html += '<div class="panel-row-sub">' + esc(server.command || '--') + (server.args && server.args.length ? ' · ' + esc(server.args.join(' ')) : '') + (server.envKeys && server.envKeys.length ? ' · env ' + esc(server.envKeys.join(', ')) : '') + '</div></div></div>';
            }
            html += '</div>';
          }
          html += '</div>';
        }
      }
      html += '</div></div></div>';
    }
    html += '</div>';
    return html;
  }

  function configAssetsReport() {
    var files = configAssetsData.configFiles || [];
    var mcpConfigs = configAssetsData.mcpConfigs || [];
    var skills = configAssetsData.skills || [];
    return {
      exportedAt: new Date().toISOString(),
      loading: !!configAssetsData.loading,
      error: configAssetsData.error || null,
      summary: {
        configFiles: files.length,
        existingConfigFiles: files.filter(function(file) { return !!file.exists; }).length,
        mcpConfigs: mcpConfigs.length,
        mcpServers: mcpConfigs.reduce(function(total, cfg) { return total + ((cfg.servers || []).length); }, 0),
        skills: skills.length,
      },
      configFiles: files,
      mcpConfigs: mcpConfigs,
      skills: skills,
    };
  }

  function configAssetAt(index) {
    return (configAssetsData.configFiles || [])[index] || null;
  }

  function mcpConfigAt(index) {
    return (configAssetsData.mcpConfigs || [])[index] || null;
  }

  function safeAssetName(value, fallback) {
    return String(value || fallback || 'asset').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || fallback || 'asset';
  }

  function configAssetTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench config asset handoff as task context.',
      '',
      'Operator intent:',
      '- Review this Config Preview report or selected configuration asset and decide the next safe action.',
      '- Use the complete Config Preview report first, then compare any selected asset with Settings, safety, provider permissions, MCP status, and environment checks.',
      '- If the file is missing, stale, invalid, or risky, propose or implement a scoped fix.',
      '- Preserve existing runtime semantics, provider choices, and MCP server behavior unless the task prompt is edited.',
      '',
      'Config asset handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.copyConfigAssets = function() {
    copyText(JSON.stringify(configAssetsReport(), null, 2));
  };

  window.exportConfigAssets = function() {
    downloadTextFile('persona-config-assets-' + Date.now() + '.json', JSON.stringify(configAssetsReport(), null, 2));
    showToast('Config assets report exported', true);
  };

  window.createTaskFromConfigAssetsReport = function() {
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'configAssetsReport',
      report: configAssetsReport(),
      settings: settingsSummaryPayload(),
      safety: safetyReportPayload(),
      providerPermissions: providerPermissionsPayload(),
      environment: envCheckReport(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review Config Preview report',
      prompt: configAssetTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Config Preview report loaded into task form', true);
  };

  window.copyConfigAssetPath = function(index) {
    var file = configAssetAt(index);
    if (!file || !file.path) {
      showToast('Config file path not found', false);
      return;
    }
    copyText(file.path);
  };

  window.copyConfigAssetContent = function(index) {
    var file = configAssetAt(index);
    if (!file || !file.content) {
      showToast('Config file content not available', false);
      return;
    }
    copyText(file.content);
  };

  window.exportConfigAsset = function(index) {
    var file = configAssetAt(index);
    if (!file) {
      showToast('Config file not found', false);
      return;
    }
    var payload = file.content || JSON.stringify(file, null, 2);
    downloadTextFile('persona-config-' + safeAssetName(file.label || file.path, 'config') + '-' + Date.now() + (file.content ? '.txt' : '.json'), payload);
    showToast('Config asset exported', true);
  };

  window.createTaskFromConfigAsset = function(index) {
    var file = configAssetAt(index);
    if (!file) {
      showToast('Config file not found', false);
      return;
    }
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review config asset: ' + (file.label || file.path || 'config'),
      prompt: configAssetTaskPromptPayload({ type: 'configFile', configFile: file, report: configAssetsReport() }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Config asset loaded into task form', true);
  };

  window.copyMcpConfigPath = function(index) {
    var cfg = mcpConfigAt(index);
    if (!cfg || !cfg.path) {
      showToast('MCP config path not found', false);
      return;
    }
    copyText(cfg.path);
  };

  window.copyMcpConfigJson = function(index) {
    var cfg = mcpConfigAt(index);
    if (!cfg) {
      showToast('MCP config not found', false);
      return;
    }
    copyText(JSON.stringify(cfg, null, 2));
  };

  window.exportMcpConfigJson = function(index) {
    var cfg = mcpConfigAt(index);
    if (!cfg) {
      showToast('MCP config not found', false);
      return;
    }
    downloadTextFile('persona-mcp-config-' + safeAssetName(cfg.label || cfg.path, 'mcp') + '-' + Date.now() + '.json', JSON.stringify(cfg, null, 2));
    showToast('MCP config exported', true);
  };

  window.createTaskFromMcpConfig = function(index) {
    var cfg = mcpConfigAt(index);
    if (!cfg) {
      showToast('MCP config not found', false);
      return;
    }
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review MCP config: ' + (cfg.label || cfg.path || 'mcp'),
      prompt: configAssetTaskPromptPayload({ type: 'mcpConfig', mcpConfig: cfg, report: configAssetsReport() }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('MCP config loaded into task form', true);
  };

  function renderSettingsEnvPanel() {
    var checks = debugToolsData.env && debugToolsData.env.checks || [];
    var okCount = checks.filter(function(item) { return item.available; }).length;
    var html = '<div class="workbench-panel wide settings-env-panel"><div class="panel-title"><span>Environment</span><div class="panel-actions">';
    html += '<button class="mini-btn" onclick="runEnvCheck()">' + (debugToolsData.envLoading ? 'Checking...' : 'Run Check') + '</button>';
    if (debugToolsData.env || debugToolsData.envError) {
      html += '<button class="mini-btn" onclick="copyEnvCheckReport()">Copy Report</button>';
      html += '<button class="mini-btn" onclick="exportEnvCheckReport()">Export Report</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromEnvCheckReport()">Create Task</button>';
    }
    html += '</div></div>';
    if (debugToolsData.envError) {
      html += '<div class="td-error compact">' + esc(debugToolsData.envError) + '</div>';
    }
    if (checks.length === 0 && !debugToolsData.envLoading) {
      html += '<div class="empty">No environment check has been run in this browser session.</div>';
    } else if (debugToolsData.envLoading) {
      html += '<div class="td-result-running"><div class="spinner"></div><span>Checking local commands...</span></div>';
    } else {
      html += '<div class="debug-summary"><span class="badge ' + (okCount === checks.length ? 'completed' : 'pending') + '">' + okCount + '/' + checks.length + ' available</span><span class="muted">local runtime commands</span></div>';
      html += '<div class="debug-check-list compact">';
      for (var i = 0; i < checks.length; i++) {
        var check = checks[i];
        html += '<div class="debug-check-row"><span class="badge ' + (check.available ? 'completed' : 'failed') + '">' + (check.available ? 'ok' : 'miss') + '</span>';
        html += '<div class="panel-row-main"><div class="panel-row-title">' + esc(check.name) + '</div><div class="panel-row-sub">' + esc(check.command || '--') + (check.version ? ' · ' + esc(shortText(check.version, 80)) : '') + '</div></div>';
        html += '<div class="panel-actions settings-row-actions">';
        html += '<button class="chat-msg-action" onclick="copyEnvCheckItem(' + i + ')">Copy</button>';
        html += '<button class="chat-msg-action" onclick="exportEnvCheckItem(' + i + ')">Export</button>';
        html += '<button class="chat-msg-action" onclick="createTaskFromEnvCheckItem(' + i + ')">Create Task</button>';
        html += '</div></div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderUiPreferencesPanel() {
    var refresh = Number(uiPreferences.refreshIntervalSec);
    var html = '<div class="workbench-panel wide ui-preferences-panel"><div class="panel-title"><span>UI Preferences</span><div class="panel-actions">';
    html += '<span class="muted">local</span>';
    html += '<button class="mini-btn" onclick="copyUiPreferencesReport()">Copy Report</button>';
    html += '<button class="mini-btn" onclick="exportUiPreferencesReport()">Export Report</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromUiPreferencesReport()">Create Task</button>';
    html += '</div></div>';
    html += '<div class="settings-controls">';
    html += '<label><span>Theme</span><select onchange="setUiPreference(\'theme\', this.value)">';
    html += '<option value="midnight"' + ((uiPreferences.theme || 'midnight') === 'midnight' ? ' selected' : '') + '>Midnight</option>';
    html += '<option value="graphite"' + (uiPreferences.theme === 'graphite' ? ' selected' : '') + '>Graphite</option>';
    html += '<option value="daylight"' + (uiPreferences.theme === 'daylight' ? ' selected' : '') + '>Daylight</option>';
    html += '</select></label>';
    html += '<label><span>Density</span><select onchange="setUiPreference(\'density\', this.value)">';
    html += '<option value="comfortable"' + (uiPreferences.density === 'comfortable' ? ' selected' : '') + '>Comfortable</option>';
    html += '<option value="compact"' + (uiPreferences.density === 'compact' ? ' selected' : '') + '>Compact</option>';
    html += '</select></label>';
    html += '<label><span>Time Format</span><select onchange="setUiPreference(\'timeFormat\', this.value)">';
    html += '<option value="relative"' + (uiPreferences.timeFormat === 'relative' ? ' selected' : '') + '>Relative</option>';
    html += '<option value="absolute"' + (uiPreferences.timeFormat === 'absolute' ? ' selected' : '') + '>Absolute</option>';
    html += '</select></label>';
    html += '<label><span>Auto Refresh</span><select onchange="setUiPreference(\'refreshIntervalSec\', Number(this.value))">';
    var refreshOptions = [[0, 'Paused'], [15, '15s'], [30, '30s'], [60, '60s']];
    for (var i = 0; i < refreshOptions.length; i++) {
      html += '<option value="' + refreshOptions[i][0] + '"' + (refresh === refreshOptions[i][0] ? ' selected' : '') + '>' + refreshOptions[i][1] + '</option>';
    }
    html += '</select></label>';
    html += '</div></div>';
    return html;
  }

  function uiPreferencesPayload() {
    var storageWritable = false;
    try {
      localStorage.setItem('persona-ui-preferences-check', '1');
      localStorage.removeItem('persona-ui-preferences-check');
      storageWritable = true;
    } catch (_) {
      storageWritable = false;
    }
    return {
      exportedAt: new Date().toISOString(),
      preferences: {
        theme: uiPreferences.theme || 'midnight',
        density: uiPreferences.density || 'comfortable',
        timeFormat: uiPreferences.timeFormat || 'relative',
        refreshIntervalSec: Number(uiPreferences.refreshIntervalSec || 0),
      },
      runtime: {
        viewMode: viewMode,
        autoRefreshActive: !!autoRefreshTimer,
        websocketConnected: !!wsConnected,
        bodyClasses: document && document.body ? Array.prototype.slice.call(document.body.classList) : [],
      },
      storage: {
        key: 'persona-ui-preferences',
        writable: storageWritable,
        persisted: storageWritable ? localStorage.getItem('persona-ui-preferences') : null,
      },
    };
  }

  function uiPreferencesTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench UI preferences handoff as task context.',
      '',
      'Operator intent:',
      '- Review current local UI preferences before changing Workbench ergonomics.',
      '- Compare theme, density, time format, auto-refresh cadence, persistence, Settings summary, safety posture, config assets, and environment checks.',
      '- If preferences make operations hard to scan or refresh behavior is risky, propose or implement a scoped UI settings improvement.',
      '- Preserve user preference semantics unless the task prompt is explicitly edited.',
      '',
      'UI preferences handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.copyUiPreferencesReport = function() {
    copyText(JSON.stringify(uiPreferencesPayload(), null, 2));
  };

  window.exportUiPreferencesReport = function() {
    downloadTextFile('persona-ui-preferences-' + Date.now() + '.json', JSON.stringify(uiPreferencesPayload(), null, 2));
    showToast('UI preferences exported', true);
  };

  window.createTaskFromUiPreferencesReport = function() {
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'uiPreferencesReport',
      uiPreferences: uiPreferencesPayload(),
      settings: settingsSummaryPayload(),
      safety: safetyReportPayload(),
      configAssets: configAssetsReport(),
      environment: envCheckReport(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review Workbench UI preferences',
      prompt: uiPreferencesTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('UI preferences loaded into task form', true);
  };

  window.setUiPreference = function(key, value) {
    if (key === 'theme') uiPreferences.theme = ['midnight', 'graphite', 'daylight'].indexOf(value) >= 0 ? value : 'midnight';
    if (key === 'density') uiPreferences.density = value === 'compact' ? 'compact' : 'comfortable';
    if (key === 'timeFormat') uiPreferences.timeFormat = value === 'absolute' ? 'absolute' : 'relative';
    if (key === 'refreshIntervalSec') {
      var n = Number(value);
      uiPreferences.refreshIntervalSec = [0, 15, 30, 60].indexOf(n) >= 0 ? n : 30;
      scheduleAutoRefresh();
    }
    saveUiPreferences();
    applyUiPreferences();
    if (viewMode === 'settings') renderSettingsView();
    else if (viewMode === 'agents') renderRuntimeView();
    else if (viewMode === 'tasks') renderTasksHome();
    else if (viewMode === 'automations') renderAutomationsView();
    else if (viewMode === 'files') renderFilesView();
    else if (viewMode === 'observability') renderObservabilityView();
    showToast('Preference saved', true);
  };

  function settingsKv(label, value) {
    return '<div class="kv-card"><div class="kv-label">' + esc(label) + '</div><div class="kv-value">' + esc(String(value == null ? '--' : value)) + '</div></div>';
  }

  // ── View switching ──
  window.selectSession = function (sessionId) {
    stopLogPolling();
    viewMode = 'session';
    setActiveNav('workbench');
    selectedSessionId = sessionId;
    selectedPoolLabel = null;
    selectedTaskId = null;
    chatReplyDraft = null;
    $('detail-content').classList.remove('task-split-mode');
    $('dh-title').textContent = 'Main (Director)';
    $('dh-sub').textContent = '';
    showChat();
    // Load sub-sessions for tabs
    if (expandedDirector !== 'main') {
      expandedDirector = 'main';
      loadSessions('main');
    } else {
      renderSessionList();
      renderSessionTabs();
    }
    renderTaskList();
    if (sessionId) {
      loadSessionMessages(sessionId);
    } else {
      loadAllMessages();
    }
  };

  window.selectTask = function (taskId) {
    stopLogPolling();
    viewMode = 'task';
    setActiveNav('tasks');
    selectedTaskId = taskId;
    selectedSessionId = null;
    taskDetail = null;
    taskOutput = null;
    taskLogs = [];
    taskLogTotalLines = 0;
    hideChat();
    $('session-dropdown').style.display = 'none';
    renderSessionList();
    renderTaskList();
    $('dh-title').innerHTML = '<span style="cursor:pointer;color:var(--blue);margin-right:8px" onclick="selectNav(\'tasks\')">\u2190</span>Task';
    $('dh-sub').textContent = taskId;
    loadTaskDetail(taskId);
  };

  window.selectDashboard = function () {
    stopLogPolling();
    viewMode = 'dashboard';
    setActiveNav('overview');
    selectedSessionId = null;
    selectedTaskId = null;
    $('detail-content').classList.remove('task-split-mode');
    hideChat();
    $('session-dropdown').style.display = 'none';
    renderSessionList();
    renderTaskList();
    $('dh-title').textContent = 'Overview';
    $('dh-sub').textContent = 'Workbench cockpit';
    renderDashboard();
    loadDashboardSupplementData();
  };

  function loadDashboardSupplementData() {
    if (dashboardSupplementLoading) return;
    dashboardSupplementLoading = true;
    var taskReq = fetch('/api/tasks?limit=200')
      .then(function(r) {
        if (!r.ok) throw new Error('tasks ' + r.status);
        return r.json();
      })
      .then(function(list) {
        var tasks = Array.isArray(list) ? list : [];
        taskCenterData.tasks = tasks;
        cronRunData.tasks = tasks.filter(function(t) { return t.type === 'cron' || (t.extra && t.extra.cronJobId); });
      });
    var cronReq = fetch('/api/cron-jobs')
      .then(function(r) {
        if (!r.ok) throw new Error('cron ' + r.status);
        return r.json();
      })
      .then(function(list) {
        cronJobs = Array.isArray(list) ? list : [];
      });
    var filesReq = fetch('/api/files' + (filesData.scope && filesData.scope !== 'all' ? '?scope=' + encodeURIComponent(filesData.scope) : ''))
      .then(function(r) {
        if (!r.ok) throw new Error('files ' + r.status);
        return r.json();
      })
      .then(function(body) {
        filesData.files = body.files || [];
        filesData.roots = body.roots || {};
        filesData.safety = body.safety || null;
      });
    var personaReq = Promise.all([
      fetch('/api/persona/roles').then(function(r) { return r.json(); }).catch(function() { return { roles: [] }; }),
      fetch('/api/state').then(function(r) { return r.json(); }).catch(function() { return { state: '', todo: '' }; }),
      fetch('/api/persona/docs').then(function(r) { return r.json(); }).catch(function() { return { docs: [], root: '' }; }),
      fetch('/api/persona/session-links').then(function(r) { return r.ok ? r.json() : { links: {} }; }).catch(function() { return { links: {} }; }),
    ]).then(function(parts) {
      personaData.roles = parts[0].roles || personaData.roles || [];
      personaData.state = parts[1].state || '';
      personaData.todo = parts[1].todo || '';
      personaData.docs = parts[2].docs || [];
      personaData.docsRoot = parts[2].root || '';
      personaData.sessionLinks = parts[3].links || {};
      personaData.selectedRole = personaData.selectedRole || (personaData.roles[0] && personaData.roles[0].role) || 'director';
      personaLoaded = true;
    });
    Promise.allSettled([taskReq, cronReq, filesReq, personaReq]).then(function() {
      dashboardSupplementLoading = false;
      renderCronBadge();
      renderCronPanel();
      if (viewMode === 'dashboard') renderDashboard();
    });
  }

  // ── Toast ──
  var toastTimer = null;
  function showToast(message, ok) {
    var el = $('toast');
    el.textContent = message;
    el.className = (ok ? 'ok' : 'err') + ' show';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3000);
  }

  // ── Render: Sidebar ──
  function renderSidebar() {
    if (!data) return;
    var now = Date.now();
    var sys = data.system || {};
    var act = data.activity || {};
    var ctx = data.context || {};
    var queue = data.queue || [];
    var tasks = data.tasks || {};

    // Header bar
    var dot = $('hb-dot');
    var st = $('hb-status');
    dot.className = 'dot';
    if (sys.status === 'healthy') { dot.classList.add('green'); st.textContent = 'Healthy'; st.style.color = 'var(--green)'; }
    else if (sys.status === 'degraded') { dot.classList.add('yellow'); st.textContent = 'Degraded'; st.style.color = 'var(--yellow)'; }
    else { dot.classList.add('red'); st.textContent = 'Error'; st.style.color = 'var(--red)'; }

    var fEl = $('hb-messaging');
    fEl.textContent = sys.messaging === 'connected' ? 'Connected' : (sys.messaging || '--');
    fEl.style.color = sys.messaging === 'connected' ? 'var(--green)' : 'var(--overlay1)';

    var dEl = $('hb-director');
    var poolCount = (data.pool || []).length;
    dEl.textContent = sys.directorAlive ? ('Alive' + (poolCount > 0 ? ' +' + poolCount : '')) : 'Dead';
    dEl.style.color = sys.directorAlive ? 'var(--green)' : 'var(--red)';

    $('hb-uptime').textContent = fmtDur(sys.uptime);

    var qw = $('hb-queue-wrap');
    if (queue.length > 0) { qw.style.display = ''; $('hb-queue').textContent = queue.length + ' queued'; }
    else { qw.style.display = 'none'; }

    // Activity
    var adot = $('act-dot');
    adot.className = 'act-dot ' + (act.state || 'idle');
    var labels = { idle: 'Idle', processing: 'Processing', flushing: 'Flushing', restarting: 'Restarting' };
    var colors = { idle: 'var(--subtext0)', processing: 'var(--green)', flushing: 'var(--yellow)', restarting: 'var(--peach)' };
    var al = $('act-label');
    al.textContent = labels[act.state] || act.state || 'Idle';
    al.style.color = colors[act.state] || 'var(--subtext0)';

    var prev = $('act-preview');
    var elap = $('act-elapsed');
    if (act.currentMessage && act.state === 'processing') {
      prev.textContent = '"' + (act.currentMessage.preview || '') + '"';
      var elapsed = (act.currentMessage.elapsedMs || 0) + (Date.now() - lastRecvAt);
      elap.textContent = fmtDur(elapsed);
    } else {
      prev.textContent = '';
      elap.textContent = '';
    }

    // Context — follows selected session (main or pool Director)
    var ctxData = ctx; // default: main Director
    if (viewMode === 'pool-session' && selectedPoolLabel) {
      var poolData = data.pool || [];
      for (var ci = 0; ci < poolData.length; ci++) {
        if (poolData[ci].label === selectedPoolLabel && poolData[ci].context) {
          var pc = poolData[ci].context;
          var pcLimit = pc.limit || 0;
          ctxData = {
            tokens: pc.tokens,
            limit: pcLimit,
            percent: (pc.live !== false && pcLimit > 0 && pc.tokens != null) ? Math.round((pc.tokens / pcLimit) * 100) : (pc.percent || 0),
            live: pc.live !== false,
            lastFlushAgoMs: pc.lastFlushAgoMs != null ? pc.lastFlushAgoMs : (pc.lastFlushAt ? (now - pc.lastFlushAt) : null),
          };
          break;
        }
      }
    }
    var live = ctxData.live !== false;
    var pct = live ? (ctxData.percent || 0) : 0;
    var bc = pct > 95 ? 'var(--red)' : pct > 80 ? 'var(--yellow)' : 'var(--green)';
    var bar = $('ctx-bar');
    bar.style.width = Math.min(pct, 100) + '%';
    bar.style.background = bc;
    $('ctx-tokens').textContent = fmtTokens(ctxData.tokens) + ' / ' + fmtTokens(ctxData.limit);
    var pe = $('ctx-pct');
    pe.textContent = live ? (pct + '%') : '--';
    pe.style.color = bc;
    $('ctx-flush').textContent = 'Last flush: ' + (ctxData.lastFlushAgoMs != null ? fmtAgoMs(ctxData.lastFlushAgoMs) : '--');

    // Session + Pool list (unified)
    renderSessionList();

    // Task list (from status push)
    renderTaskList();

    // Cron badge (update header badge count)
    renderCronBadge();
  }

  function renderSessionList() {
    var el = $('session-list');
    var countEl = $('session-count');
    var poolData = (data && data.pool) || [];

    // Main Director entry
    var mainActivity = (data && data.activity && data.activity.state) || 'idle';
    var mainAlive = data && data.system && data.system.directorAlive;
    var mainStatus, mainColor;
    if (!mainAlive) { mainStatus = 'dead'; mainColor = 'var(--red)'; }
    else if (mainActivity === 'processing') { mainStatus = 'busy'; mainColor = 'var(--green)'; }
    else if (mainActivity === 'flushing') { mainStatus = 'flush'; mainColor = 'var(--yellow)'; }
    else { mainStatus = 'live'; mainColor = 'var(--green)'; }

    var html = '';
    html += renderSessionGroup('Main', [
      renderSessionDirectorItem({
        active: viewMode === 'session',
        onclick: 'selectSession(null)',
        dotColor: mainColor,
        label: 'Main (Director)',
        meta: mainStatus,
        badgeHtml: '',
        closeHtml: '',
      }),
    ]);

    var webChats = [];
    var feishuGroups = [];
    var closedPool = [];
    for (var i = 0; i < poolData.length; i++) {
      var entry = poolData[i];
      if (entry.closed) {
        closedPool.push(entry);
      } else if (entry.routingKey && entry.routingKey.startsWith('web-')) {
        webChats.push(entry);
      } else {
        feishuGroups.push(entry);
      }
    }

    html += renderSessionGroup('Web Chats', webChats.map(renderPoolSessionItem));
    html += renderSessionGroup('Feishu Groups', feishuGroups.map(renderPoolSessionItem));
    html += renderSessionGroup('Closed', closedPool.map(renderPoolSessionItem));

    // [BUG2 FIX] Explicit string concatenation instead of implicit type coercion
    var activeCount = 1 + webChats.length + feishuGroups.length;
    var totalText = String(activeCount);
    if (closedPool.length > 0) totalText += ' +' + closedPool.length;
    countEl.textContent = '(' + totalText + ')';
    el.innerHTML = html;
  }

  function renderSessionGroup(title, items) {
    var count = items.length;
    var html = '<div class="session-group">';
    html += '<div class="session-group-title"><span>' + esc(title) + '</span><em>' + count + '</em></div>';
    if (count === 0) {
      html += '<div class="session-group-empty">None</div>';
    } else {
      html += items.join('');
    }
    html += '</div>';
    return html;
  }

  function poolDirectorStatus(p) {
    if (p.closed) return { status: p.closedReason || 'closed', dotColor: 'var(--overlay0)' };
    if (!p.alive) return { status: 'dead', dotColor: 'var(--red)' };
    if (p.activity === 'processing') return { status: 'busy', dotColor: 'var(--green)' };
    if (p.activity === 'flushing') return { status: 'flush', dotColor: 'var(--yellow)' };
    return { status: 'live', dotColor: 'var(--green)' };
  }

  function renderPoolSessionItem(p) {
    var state = poolDirectorStatus(p);
    var badgeHtml = '';
    if (p.queueLength > 0) badgeHtml = ' <span class="badge running" style="font-size:8px;padding:0 4px;margin-left:2px">' + p.queueLength + '</span>';
    var shortName = (p.groupName || p.label || 'Director').slice(0, 14);
    var isWebSession = p.routingKey && p.routingKey.startsWith('web-');
    var closeHtml = (isWebSession && !p.closed) ? '<span class="item-close" onclick="event.stopPropagation();doCloseWebChat(\'' + esc(p.routingKey) + '\')" title="Close">&times;</span>' : '';
    return renderSessionDirectorItem({
      active: viewMode === 'pool-session' && selectedPoolLabel === p.label,
      onclick: 'selectPoolDirector(\'' + esc(p.label || '') + '\',\'' + esc(p.groupName || p.label || '') + '\')',
      dotColor: state.dotColor,
      label: shortName + ' (Director)',
      meta: state.status,
      badgeHtml: badgeHtml,
      closeHtml: closeHtml,
    });
  }

  function renderSessionDirectorItem(item) {
    return '<div class="list-item' + (item.active ? ' active' : '') + '" onclick="' + item.onclick + '" style="cursor:pointer">' +
      '<span class="item-icon" style="color:' + item.dotColor + '">&#9679;</span>' +
      '<span class="item-label">' + esc(item.label) + (item.badgeHtml || '') + '</span>' +
      (item.closeHtml || '') +
      '<span class="item-meta">' + esc(item.meta || '--') + '</span></div>';
  }

  /** Render session dropdown in the detail header */
  function renderSessionTabs() {
    var dd = $('session-dropdown');
    if (!dd) return;

    if (viewMode !== 'session' && viewMode !== 'pool-session') {
      dd.style.display = 'none';
      return;
    }

    var directorLabel = viewMode === 'pool-session' ? selectedPoolLabel : 'main';
    if (!sessions.length || expandedDirector !== directorLabel) {
      dd.style.display = 'none';
      return;
    }

    var poolData = (data && data.pool) || [];
    var liveId = null;
    if (directorLabel === 'main' && data && data.system) liveId = data.system.sessionId;
    else {
      var pe = poolData.find(function(p) { return p.label === directorLabel; });
      if (pe) liveId = pe.sessionId;
    }

    var sorted = sessions.slice().sort(function(a, b) {
      if (a.sessionId === liveId) return -1;
      if (b.sessionId === liveId) return 1;
      return (b.lastMessageAt || '').localeCompare(a.lastMessageAt || '');
    });

    var currentId = selectedSessionId || liveId || '';

    // Build menu items
    var menuHtml = '';
    var currentName = '';
    var currentIsLive = false;
    for (var i = 0; i < sorted.length; i++) {
      var s = sorted[i];
      var isLive = s.sessionId === liveId;
      var isSelected = s.sessionId === currentId;
      var sName = getSessionDisplayName(s);
      var dotColor = isLive ? 'var(--green)' : 'var(--overlay0)';

      if (isSelected) { currentName = sName; currentIsLive = isLive; }

      menuHtml += '<button class="sd-item' + (isSelected ? ' active' : '') +
        '" data-director="' + esc(directorLabel) + '" data-sid="' + esc(s.sessionId) +
        '" data-name="' + esc(sName) + '" onclick="pickSession(this)">' +
        '<span class="sd-item-dot" style="background:' + dotColor + '"></span>' +
        esc(sName) +
        '<span class="sd-item-count">' + s.messageCount + '</span></button>';
    }

    // Update trigger label
    $('sd-label').textContent = currentName;
    $('sd-dot').style.background = currentIsLive ? 'var(--green)' : 'var(--overlay0)';
    $('sd-menu').innerHTML = menuHtml;
    dd.style.display = '';
    dd.dataset.director = directorLabel;
  }

  function getSessionDisplayName(s) {
    var sName = s.sessionName;
    if (!sName && s.firstMessageAt) {
      var d = new Date(s.firstMessageAt);
      var ds = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
      var ts = d.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' }).replace(':', '');
      sName = ds + 'T' + ts;
    }
    if (!sName) sName = s.sessionId.slice(0, 12);
    sName = sName.replace(/^director-(main-|[0-9a-f]+-)?/, '');
    if (sName.length > 20) sName = sName.slice(0, 20) + '\u2026';
    return sName;
  }

  window.toggleSessionDropdown = function() {
    var dd = $('session-dropdown');
    dd.classList.toggle('open');
  };

  window.pickSession = function(el) {
    var directorLabel = el.dataset.director;
    var sessionId = el.dataset.sid;
    var sName = el.dataset.name;
    $('session-dropdown').classList.remove('open');
    selectSubSession(directorLabel, sessionId, sName);
  };

  // Close dropdown on outside click
  document.addEventListener('click', function(e) {
    var dd = $('session-dropdown');
    if (dd && !dd.contains(e.target)) {
      dd.classList.remove('open');
    }
    // Close cron panel on outside click
    var cronWrap = $('cron-wrap');
    if (cronPanelOpen && cronWrap && !cronWrap.contains(e.target)) {
      cronPanelOpen = false;
      cronWrap.classList.remove('open');
      expandedCronId = null;
      loadCronJobs();
    }
    // Close state panel on outside click
    var stateWrap = $('state-wrap');
    if (statePanelOpen && stateWrap && !stateWrap.contains(e.target)) {
      statePanelOpen = false;
      stateWrap.classList.remove('open');
    }
  });

  // Close cron panel on ESC key
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && cronPanelOpen) {
      cronPanelOpen = false;
      var cronWrap = $('cron-wrap');
      if (cronWrap) cronWrap.classList.remove('open');
      expandedCronId = null;
      loadCronJobs();
    }
    if (e.key === 'Escape' && statePanelOpen) {
      statePanelOpen = false;
      var stateWrap = $('state-wrap');
      if (stateWrap) stateWrap.classList.remove('open');
    }
  });

  function renderPoolList() {
    // Merged into renderSessionList — no-op for backward compat
  }

  function renderTaskList() {
    if (!data) return;
    var tasks = data.tasks || {};
    var tSum = tasks.summary || {};
    var tList = tasks.recent || [];
    var el = $('task-list');
    var counts = $('task-counts');

    var parts = [];
    if (tSum.running) parts.push(tSum.running + ' run');
    if (tSum.completed) parts.push(tSum.completed + ' done');
    if (tSum.failed) parts.push(tSum.failed + ' fail');
    counts.textContent = parts.length ? '(' + parts.join(', ') + ')' : '';

    if (tList.length === 0) {
      el.innerHTML = '<div class="empty">No tasks</div>';
      return;
    }
    var html = '';
    for (var j = 0; j < tList.length; j++) {
      var t = tList[j];
      var st = t.status || 'pending';
      var isActive = viewMode === 'task' && selectedTaskId === t.id;
      html += '<div class="list-item' + (isActive ? ' active' : '') +
        '" onclick="selectTask(\'' + esc(t.id) + '\')">';
      if (st === 'running' || st === 'dispatched') html += '<div class="running-dot"></div>';
      html += '<span class="badge ' + esc(st) + '">' + esc(st) + '</span>' +
        '<span class="item-label">' + esc(t.description || t.role) + '</span>';
      if (t.durationMs != null) html += '<span class="item-meta">' + fmtDur(t.durationMs) + '</span>';
      html += '</div>';
    }
    el.innerHTML = html;
  }

  // ── Render: Dashboard (default view) ──
  function dashboardTaskSummary() {
    var summary = data && data.tasks && data.tasks.summary || {};
    var recent = data && data.tasks && data.tasks.recent || [];
    var list = taskCenterData.tasks && taskCenterData.tasks.length ? taskCenterData.tasks : recent;
    var counts = {
      running: Number(summary.running || 0),
      dispatched: Number(summary.dispatched || 0),
      completed: Number(summary.completed || 0),
      failed: Number(summary.failed || 0),
      cancelled: Number(summary.cancelled || 0),
      totalVisible: list.length,
    };
    for (var i = 0; i < list.length; i++) {
      var status = taskDisplayStatus(list[i]);
      if (counts[status] == null) counts[status] = 0;
      if (!summary[status]) counts[status] += 1;
    }
    return { counts: counts, recent: list.slice(0, 6) };
  }

  function dashboardAutomationSummary() {
    var jobs = cronJobs || [];
    var enabled = 0;
    var attention = [];
    for (var i = 0; i < jobs.length; i++) {
      if (jobs[i].enabled) enabled++;
      var health = automationHealth(jobs[i]);
      if (health.level === 'failed' || health.level === 'pending') {
        attention.push({ id: jobs[i].id, name: jobs[i].name || jobs[i].id, health: health });
      }
    }
    return {
      total: jobs.length,
      enabled: enabled,
      disabled: Math.max(0, jobs.length - enabled),
      attention: attention,
      recentRuns: (cronRunData.tasks || []).slice(0, 5),
    };
  }

  function dashboardDirectorSummary() {
    var sys = data && data.system || {};
    var pool = data && data.pool || [];
    var busy = 0;
    var dead = sys.directorAlive ? 0 : 1;
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].activity === 'processing') busy++;
      if (!pool[i].closed && !pool[i].alive) dead++;
    }
    return {
      main: {
        alive: !!sys.directorAlive,
        provider: sys.directorAgentName || sys.directorAgentType || '',
        role: sys.personaRole || '',
        sessionId: sys.sessionId || '',
      },
      poolCount: pool.length,
      busyCount: busy + ((data && data.activity && data.activity.state) === 'processing' ? 1 : 0),
      deadCount: dead,
      queueLength: (data && data.queue || []).length,
    };
  }

  function dashboardPersonaSummary() {
    var docs = personaData.docs || [];
    var graph = null;
    try {
      graph = personaContextGraphPayload();
    } catch (_) {
      graph = null;
    }
    return {
      loaded: !!personaLoaded,
      selectedRole: personaData.selectedRole || '',
      roles: (personaData.roles || []).length,
      docs: docs.length,
      memoryDocs: docs.filter(function(doc) { return doc.category === 'memory'; }).length,
      workspaceDocs: docs.filter(function(doc) { return doc.category === 'workspace'; }).length,
      sessionDocs: docs.filter(function(doc) { return doc.category === 'session'; }).length,
      stateChars: String(personaData.state || '').length,
      todoChars: String(personaData.todo || '').length,
      currentLink: graph && graph.currentLink || null,
    };
  }

  function dashboardFilesSummary() {
    var files = filesData.files || [];
    var sent = 0;
    for (var i = 0; i < files.length; i++) {
      if (sentArtifacts[files[i].path]) sent++;
    }
    return {
      loaded: files.length > 0 || !filesData.loading,
      total: files.length,
      scope: filesData.scope || 'all',
      sent: sent,
      selectedPath: filesData.selectedPath || '',
      safetyRoots: filesData.safety && filesData.safety.roots || filesData.roots || null,
    };
  }

  function dashboardAttentionItems(payload) {
    var items = [];
    if (!wsConnected) items.push({ level: 'critical', kind: 'console', label: 'WebSocket disconnected', target: 'Console' });
    if (payload.directors.deadCount > 0) items.push({ level: 'critical', kind: 'directors', label: payload.directors.deadCount + ' Director not alive', target: 'Runtime' });
    if (payload.directors.queueLength > 0) items.push({ level: 'warn', kind: 'queue', label: payload.directors.queueLength + ' queued message(s)', target: 'Runtime queue' });
    if ((payload.tasks.counts.failed || 0) > 0) items.push({ level: 'warn', kind: 'failedTasks', label: payload.tasks.counts.failed + ' failed task(s)', target: 'Tasks' });
    if (payload.automations.attention.length > 0) items.push({ level: 'warn', kind: 'automations', label: payload.automations.attention.length + ' automation(s) need attention', target: 'Automations', cronId: payload.automations.attention[0].id || '' });
    if ((dangerApprovalQueue || []).length > 0) items.push({ level: 'warn', kind: 'approvals', label: dangerApprovalQueue.length + ' pending approval(s)', target: 'Safety queue' });
    if (payload.persona.loaded && !payload.persona.currentLink) items.push({ level: 'info', kind: 'personaLink', label: 'Runtime session has no exact persona link', target: 'Persona' });
    if (!items.length) items.push({ level: 'ok', label: 'No immediate operator attention required', target: 'Workbench', action: '' });
    return items;
  }

  function dashboardPayload() {
    var met = data && data.metrics || {};
    var payload = {
      exportedAt: new Date().toISOString(),
      connection: {
        websocket: wsConnected ? 'connected' : 'disconnected',
        lastReceivedAt: lastRecvAt || null,
      },
      today: met.today || {},
      recentMessages: met.recentMessages || [],
      recentErrors: met.recentErrors || [],
      directors: dashboardDirectorSummary(),
      tasks: dashboardTaskSummary(),
      automations: dashboardAutomationSummary(),
      persona: dashboardPersonaSummary(),
      files: dashboardFilesSummary(),
      approvals: approvalQueuePayload(),
    };
    payload.attention = dashboardAttentionItems(payload);
    return payload;
  }

  function renderDashboardStatCard(label, value, sub, action) {
    return '<button class="dash-card overview-card" ' + (action ? 'onclick="' + action + '"' : '') + '>' +
      '<div class="dash-card-title">' + esc(label) + '</div><div class="stat-big">' + esc(String(value == null ? '--' : value)) + '</div><div class="stat-sub">' + esc(sub || '') + '</div></button>';
  }

  function renderDashboardAttention(items) {
    var html = '<div class="overview-attention-list">';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var action = item.kind ? 'openDashboardAttention(\'' + jsq(item.kind) + '\',\'' + jsq(item.cronId || '') + '\')' : '';
      html += '<button class="overview-attention-row ' + esc(item.level || 'info') + '" ' + (action ? 'onclick="' + action + '"' : '') + '>';
      html += '<span class="badge ' + (item.level === 'critical' ? 'failed' : item.level === 'warn' ? 'pending' : item.level === 'ok' ? 'completed' : 'running') + '">' + esc(item.level || 'info') + '</span>';
      html += '<strong>' + esc(item.label || '--') + '</strong><em>' + esc(item.target || '') + '</em></button>';
    }
    html += '</div>';
    return html;
  }

  function scrollAutomationCronIntoView(cronId) {
    if (!cronId) return;
    setTimeout(function() {
      var row = document.getElementById('automation-row-' + safeAssetName(cronId, 'cron'));
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 220);
  }

  window.openDashboardAttention = function(kind, cronId) {
    if (kind === 'console') {
      selectSession(null);
      return;
    }
    if (kind === 'directors' || kind === 'queue') {
      selectNav('agents');
      return;
    }
    if (kind === 'failedTasks') {
      taskCenterData.filters = { status: 'failed', role: '', source: 'all', provider: '', model: '', cronJobId: '', day: '' };
      taskCenterData.selected = {};
      selectNav('tasks');
      return;
    }
    if (kind === 'automations') {
      automationFilters = { query: '', status: 'enabled', action: 'all', health: 'all', source: 'all' };
      selectedAutomationCronId = cronId || (dashboardAutomationSummary().attention[0] && dashboardAutomationSummary().attention[0].id) || null;
      selectNav('automations');
      scrollAutomationCronIntoView(selectedAutomationCronId);
      return;
    }
    if (kind === 'approvals') {
      selectNav('settings');
      return;
    }
    if (kind === 'personaLink') {
      selectNav('persona');
      setTimeout(function() {
        if (viewMode === 'persona') window.resetPersonaSessionLinkDraft();
      }, 260);
      return;
    }
    selectDashboard();
  };

  function renderDashboardRecentTasks(tasks) {
    var html = '<div class="overview-row-list">';
    if (!tasks.length) return '<div class="empty compact">No recent tasks</div>';
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var status = taskDisplayStatus(t);
      html += '<button class="overview-row" onclick="selectTask(\'' + jsq(t.id || '') + '\')">';
      html += '<span class="badge ' + esc(status) + '">' + esc(status) + '</span>';
      html += '<span>' + esc(shortText(t.description || t.prompt || t.id || 'task', 82)) + '</span>';
      html += '<em>' + esc(t.durationMs != null ? fmtDur(t.durationMs) : (t.createdAt ? fmtAgo(t.createdAt) : '')) + '</em></button>';
    }
    html += '</div>';
    return html;
  }

  window.copyDashboardReport = function() {
    copyText(JSON.stringify(dashboardPayload(), null, 2));
  };

  window.exportDashboardReport = function() {
    downloadTextFile('persona-workbench-overview-' + Date.now() + '.json', JSON.stringify(dashboardPayload(), null, 2));
    showToast('Workbench overview exported', true);
  };

  function dashboardTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench overview handoff as task context.',
      '',
      'Operator intent:',
      '- Review the cross-module Workbench Overview and identify the next safe operator action.',
      '- Start with operator attention, then correlate Director, Tasks, Automations, Persona, Files, approvals, recent messages, and recent errors.',
      '- If remediation is needed, keep it scoped to the implicated module and preserve safety approval behavior.',
      '- Do not run destructive actions, clear queues, delete history, retry tasks, or change provider/persona routing unless the task prompt is explicitly edited.',
      '',
      'Workbench overview handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromDashboardReport = function() {
    var payload = dashboardPayload();
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review Workbench Overview: ' + String((payload.attention || []).length) + ' attention item(s)',
      prompt: dashboardTaskPromptPayload({
        exportedAt: new Date().toISOString(),
        type: 'workbenchOverview',
        overview: payload,
        runtimeSnapshot: runtimeSnapshotPayload(),
        taskTrend: taskTrendReport(filteredTaskCenterTasks()),
        approvalQueue: approvalQueuePayload(),
        approvalHistory: approvalHistoryPayload(),
      }),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Workbench overview loaded into task form', true);
  };

  function renderDashboard() {
    if (!data) return;
    var payload = dashboardPayload();
    var today = payload.today || {};
    var msgs = payload.recentMessages || [];
    var errs = payload.recentErrors || [];
    var queue = data.queue || [];

    var html = '<div class="workbench-overview">';
    html += '<div class="workbench-panel wide overview-hero"><div><div class="panel-title"><span>Workbench Overview</span></div>';
    html += '<h2>' + esc(payload.directors.main.alive ? 'Director ready' : 'Director needs attention') + '</h2>';
    html += '<p>' + esc(payload.directors.main.provider || 'provider unknown') + ' · role ' + esc(payload.directors.main.role || '--') + ' · queue ' + esc(String(payload.directors.queueLength)) + '</p></div>';
    html += '<div class="panel-actions"><button class="mini-btn" onclick="copyDashboardReport()">Copy Report</button><button class="mini-btn" onclick="exportDashboardReport()">Export Report</button><button class="mini-btn primary" onclick="createTaskFromDashboardReport()">Create Task</button><button class="mini-btn" onclick="selectSession(null)">Open Console</button></div></div>';

    html += '<div class="dash-grid">';
    html += renderDashboardStatCard('Messages', today.messagesProcessed || 0, 'processed today', 'selectSession(null)');
    html += renderDashboardStatCard('Avg Response', today.avgResponseSec != null ? today.avgResponseSec.toFixed(1) + 's' : '0s', 'today latency', 'selectNav(\'observability\')');
    html += renderDashboardStatCard('Cost', fmtCost(today.totalCostUsd), 'today spend', 'selectNav(\'observability\')');
    html += renderDashboardStatCard('Active Tasks', (payload.tasks.counts.running || 0) + (payload.tasks.counts.dispatched || 0), (payload.tasks.counts.failed || 0) + ' failed', 'selectNav(\'tasks\')');
    html += renderDashboardStatCard('Automations', payload.automations.enabled + '/' + payload.automations.total, payload.automations.attention.length + ' attention', 'selectNav(\'automations\')');
    html += renderDashboardStatCard('Persona', payload.persona.selectedRole || '--', payload.persona.docs + ' docs · ' + payload.persona.memoryDocs + ' memory', 'selectNav(\'persona\')');
    html += renderDashboardStatCard('Files', payload.files.total, payload.files.sent + ' sent · ' + payload.files.scope, 'selectNav(\'files\')');
    html += renderDashboardStatCard('Approvals', (dangerApprovalQueue || []).length, 'pending local confirmations', 'selectNav(\'settings\')');
    html += '</div>';

    html += '<div class="page-grid">';
    html += '<div class="workbench-panel"><div class="panel-title"><span>Operator Attention</span><span>' + payload.attention.length + '</span></div>';
    html += renderDashboardAttention(payload.attention);
    html += '</div>';

    html += '<div class="workbench-panel"><div class="panel-title"><span>Quick Actions</span></div><div class="overview-action-grid">';
    html += '<button class="mini-btn primary" onclick="selectSession(null)">Chat Main</button>';
    html += '<button class="mini-btn" onclick="doNewWebChat()">New Web Chat</button>';
    html += '<button class="mini-btn" onclick="selectNav(\'tasks\'); if (!createTaskOpen) toggleCreateTaskForm();">Create Task</button>';
    html += '<button class="mini-btn" onclick="createTaskFromPersonaRuntimeHandoff()">Handoff Task</button>';
    html += '<button class="mini-btn" onclick="selectNav(\'automations\')">Automations</button>';
    html += '<button class="mini-btn" onclick="selectNav(\'persona\')">Persona</button>';
    html += '<button class="mini-btn" onclick="selectNav(\'files\')">Files</button>';
    html += '</div></div>';

    html += '<div class="workbench-panel"><div class="panel-title"><span>Recent Tasks</span><button class="mini-btn" onclick="selectNav(\'tasks\')">Open</button></div>';
    html += renderDashboardRecentTasks(payload.tasks.recent);
    html += '</div>';

    html += '<div class="workbench-panel"><div class="panel-title"><span>Runtime Queue</span><button class="mini-btn" onclick="selectNav(\'agents\')">Open</button></div>';
    if (queue.length > 0) {
      for (var q = 0; q < queue.length; q++) {
        var qi = queue[q];
        html += '<div class="queue-item' + (qi.cancelled ? ' cancelled' : '') + '">' +
          '<span class="queue-text">' + esc(qi.preview) + '</span>' +
          '<span class="queue-time">' + fmtAgo(qi.timestamp) + '</span></div>';
      }
    } else {
      html += '<div class="empty compact">No queued runtime messages</div>';
    }
    html += '</div>';

    html += '<div class="workbench-panel wide"><div class="panel-title"><span>Recent Messages</span><button class="mini-btn" onclick="selectSession(null)">Open Console</button></div>';
    if (msgs.length === 0) {
      html += '<div class="empty">No messages yet</div>';
    } else {
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        var isIn = m.direction === 'in';
        var arrow = isIn ? '&#8592;' : '&#8594;';
        var meta = '';
        if (isIn && m.responseSec != null) meta = m.responseSec.toFixed(1) + 's';
        else if (m.timestamp) meta = fmtAgo(m.timestamp);
        html += '<div class="dmsg-row' + (isIn ? ' in' : '') + '">' +
          '<span class="dmsg-dir ' + (isIn ? 'in' : 'out') + '">' + arrow + '</span>' +
          '<span class="dmsg-text">' + esc(m.preview) + '</span>' +
          '<span class="dmsg-meta">' + esc(meta) + '</span></div>';
      }
    }
    html += '</div>';

    if (errs.length > 0) {
      html += '<div class="workbench-panel wide err-section"><div class="panel-title"><span style="color:var(--red)">Errors</span><button class="mini-btn" onclick="selectNav(\'observability\')">Inspect</button></div>';
      for (var k = 0; k < errs.length; k++) {
        var e = errs[k];
        html += '<div class="err-row"><span class="err-icon">&#9888;</span>' +
          '<span class="err-text">' + esc(e.message) + '</span>' +
          '<span class="err-time">' + fmtAgo(e.timestamp) + '</span></div>';
      }
      html += '</div>';
    }
    html += '</div></div>';

    $('detail-content').innerHTML = html;
  }

  // ── Render: Session (chat) View ──
  function getChronologicalSessionMessages() {
    return (sessionMessages || []).slice().reverse().map(function(message, index) {
      return Object.assign({ _chatIndex: index }, message);
    });
  }

  function messageMatchesSearch(message, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    return String(message.content || '').toLowerCase().indexOf(q) >= 0;
  }

  function getVisibleSessionMessages() {
    var msgs = getChronologicalSessionMessages();
    var q = chatSearchQuery.trim();
    if (!q) return msgs;
    return msgs.filter(function(m) { return messageMatchesSearch(m, q); });
  }

  function messageKey(message) {
    return 'm-' + String(message._chatIndex == null ? 0 : message._chatIndex);
  }

  function buildChatTurns(messages) {
    var turns = [];
    var current = null;
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.direction === 'in' || !current) {
        current = { id: 't-' + turns.length, index: turns.length, messages: [] };
        turns.push(current);
      }
      current.messages.push(m);
    }
    return turns;
  }

  function turnMatchesSearch(turn, query) {
    for (var i = 0; i < turn.messages.length; i++) {
      if (messageMatchesSearch(turn.messages[i], query)) return true;
    }
    return false;
  }

  function getVisibleChatTurns() {
    var turns = buildChatTurns(getChronologicalSessionMessages());
    var q = chatSearchQuery.trim();
    if (!q) return turns;
    return turns.filter(function(turn) { return turnMatchesSearch(turn, q); });
  }

  function parseEventTime(value) {
    if (value == null) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    var parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function currentTimelineDirector() {
    if (viewMode === 'pool-session') return selectedPoolLabel || 'main';
    return 'main';
  }

  function currentTimelineSessionId() {
    if (selectedSessionId) return selectedSessionId;
    if (viewMode === 'pool-session' && selectedPoolLabel) {
      var poolData = data && data.pool || [];
      var match = poolData.find(function(p) { return p.label === selectedPoolLabel; });
      return match && match.sessionId || '';
    }
    return data && data.system && data.system.sessionId || '';
  }

  function timelineTasks() {
    var source = currentTimelineDirector();
    var seen = {};
    var list = [];
    var candidates = [];
    if (data && data.tasks && data.tasks.recent) candidates = candidates.concat(data.tasks.recent);
    if (taskCenterData.tasks) candidates = candidates.concat(taskCenterData.tasks);
    for (var i = 0; i < candidates.length; i++) {
      var t = candidates[i];
      if (!t || !t.id || seen[t.id]) continue;
      var director = t.source_director || t.sourceDirector || 'main';
      if (source !== 'main' && director !== source) continue;
      if (source === 'main' && director && director !== 'main') continue;
      seen[t.id] = true;
      list.push(t);
    }
    return list;
  }

  function timelineAttachments() {
    var source = currentTimelineDirector();
    var events = [];
    Object.keys(sentArtifacts || {}).forEach(function(path) {
      var item = sentArtifacts[path] || {};
      if ((item.director || 'main') !== source) return;
      events.push({
        kind: 'attachment',
        status: 'sent',
        time: item.sentAt || 0,
        title: 'Attachment sent',
        detail: path,
        actionPath: path,
        payload: { path: path, sent: item },
      });
    });
    return events;
  }

  function diagnosticErrorMatchesTimeline(err, taskIds, source) {
    var taskId = firstDiagnosticTaskId(err);
    if (taskId && taskIds[taskId]) return true;
    var logLabel = firstDiagnosticLogLabel(err).toLowerCase();
    if (!logLabel) return false;
    var current = String(source || 'main').toLowerCase();
    if (current === 'main') return logLabel.indexOf('main') >= 0 || logLabel.indexOf('director') >= 0 || logLabel.indexOf('runtime') >= 0;
    return logLabel.indexOf(current) >= 0;
  }

  function timelineErrorEvents(tasks) {
    var source = currentTimelineDirector();
    var events = [];
    var taskIds = {};
    for (var i = 0; i < (tasks || []).length; i++) {
      var t = tasks[i];
      if (!t || !t.id) continue;
      taskIds[t.id] = true;
      if (t.status !== 'failed' && !t.error) continue;
      events.push({
        kind: 'error',
        status: t.error === 'cancelled' ? 'cancelled' : 'failed',
        time: parseEventTime(t.completed_at || t.completedAt || t.started_at || t.startedAt || t.created_at || t.createdAt),
        title: 'Task error · ' + (t.role || 'role'),
        detail: t.error || t.description || t.prompt || t.id,
        taskId: t.id,
        meta: [t.id, t.agent || 'default', t.source_director || t.sourceDirector || source].filter(Boolean).join(' · '),
        sessionId: t.parent_session_id || t.parentSessionId || '',
        sourceDirector: t.source_director || t.sourceDirector || source,
        payload: t,
      });
    }
    var errors = diagnosticErrors();
    for (var ei = 0; ei < errors.length; ei++) {
      var err = errors[ei];
      if (!diagnosticErrorMatchesTimeline(err, taskIds, source)) continue;
      var taskId = firstDiagnosticTaskId(err);
      var logLabel = firstDiagnosticLogLabel(err);
      events.push({
        kind: 'error',
        status: 'diagnostic',
        time: Number(err.lastAt || 0),
        title: 'Diagnostic error',
        detail: err.message || '',
        taskId: taskId || null,
        logLabel: logLabel || null,
        diagnosticIndex: ei,
        meta: (err.sources || []).join(', ') || 'diagnostics',
        sourceDirector: source,
        payload: err,
      });
    }
    for (var wi = 0; wi < (wsEventsData.events || []).length; wi++) {
      var wsEvent = wsEventsData.events[wi];
      if (!wsEvent || (wsEvent.type !== 'error' && wsEvent.type !== 'parse-error')) continue;
      var target = wsEventTarget(wsEvent);
      var director = target.director || 'main';
      if (director !== source) continue;
      events.push({
        kind: 'error',
        status: wsEvent.type,
        time: wsEvent.at || 0,
        title: 'WebSocket ' + wsEvent.type,
        detail: wsEvent.summary || (wsEvent.payload && wsEvent.payload.error) || '',
        meta: director,
        sourceDirector: director,
        payload: wsEvent,
      });
    }
    return events;
  }

  function timelineEventKey(event, index) {
    return [
      'tl',
      index,
      event && event.kind || 'event',
      event && event.time || 0,
      event && (event.messageKey || event.taskId || event.toolName || event.actionPath || (event.diagnosticIndex != null ? 'diagnostic-' + event.diagnosticIndex : '') || event.meta || ''),
    ].join('-').replace(/[^a-z0-9._-]+/gi, '-');
  }

  function firstMessageArray(message, keys) {
    var containers = [message || {}, message && message.meta || {}, message && message.metadata || {}, message && message.extra || {}];
    for (var c = 0; c < containers.length; c++) {
      var container = containers[c] || {};
      for (var i = 0; i < keys.length; i++) {
        var value = container[keys[i]];
        if (Array.isArray(value) && value.length) return value;
        if (value && typeof value === 'object' && !Array.isArray(value)) return [value];
      }
    }
    return [];
  }

  function firstMessageObject(message, keys) {
    var containers = [message || {}, message && message.meta || {}, message && message.metadata || {}, message && message.extra || {}];
    for (var c = 0; c < containers.length; c++) {
      var container = containers[c] || {};
      for (var i = 0; i < keys.length; i++) {
        var value = container[keys[i]];
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      }
    }
    return null;
  }

  function timelineToolName(item, fallback) {
    if (!item || typeof item !== 'object') return fallback;
    return item.name || item.toolName || item.tool_name || item.functionName || item.function_name ||
      (item.function && item.function.name) || item.id || fallback;
  }

  function timelineToolDetail(item) {
    if (item == null) return '';
    if (typeof item === 'string') return clipText(item, 420);
    if (typeof item !== 'object') return clipText(String(item), 420);
    var detail = item.input || item.arguments || item.args || item.parameters || item.result || item.output || item.content ||
      (item.function && (item.function.arguments || item.function.input));
    if (detail == null) detail = item;
    try {
      return clipText(typeof detail === 'string' ? detail : JSON.stringify(detail), 420);
    } catch (_) {
      return clipText(String(detail), 420);
    }
  }

  function timelineToolEventsForMessage(message, index, sessionId, source) {
    var events = [];
    var baseTime = parseEventTime(message && message.timestamp);
    var msgKey = messageKey(message);
    var calls = firstMessageArray(message, ['tool_calls', 'toolCalls', 'tool_uses', 'toolUses', 'tools']);
    var functionCall = firstMessageObject(message, ['function_call', 'functionCall']);
    if (functionCall) calls = calls.concat([functionCall]);
    for (var i = 0; i < calls.length; i++) {
      var call = calls[i];
      var name = timelineToolName(call, 'tool');
      events.push({
        kind: 'tool',
        status: 'call',
        time: baseTime ? baseTime + i + 1 : 0,
        title: 'Tool call · ' + name,
        detail: timelineToolDetail(call),
        messageKey: msgKey,
        toolName: name,
        meta: [call && call.id, message && (message.provider || message.agent || message.agentType || message.agent_type)].filter(Boolean).join(' · '),
        sessionId: message && message.sessionId || sessionId || '',
        sourceDirector: source,
        payload: { message: message, tool: call },
      });
    }
    var results = firstMessageArray(message, ['tool_results', 'toolResults', 'tool_result', 'toolResult']);
    for (var r = 0; r < results.length; r++) {
      var result = results[r];
      var resultName = timelineToolName(result, 'tool result');
      var isError = !!(result && (result.is_error || result.isError || result.error));
      events.push({
        kind: 'tool',
        status: isError ? 'error' : 'result',
        time: baseTime ? baseTime + calls.length + r + 1 : 0,
        title: 'Tool result · ' + resultName,
        detail: timelineToolDetail(result),
        messageKey: msgKey,
        toolName: resultName,
        meta: [result && result.id, isError ? 'error' : 'ok'].filter(Boolean).join(' · '),
        sessionId: message && message.sessionId || sessionId || '',
        sourceDirector: source,
        payload: { message: message, toolResult: result },
      });
    }
    return events;
  }

  function buildConversationTimeline(messages) {
    var events = [];
    var sessionId = currentTimelineSessionId();
    var source = currentTimelineDirector();
    var msgs = messages || [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      events.push({
        kind: m.direction === 'in' ? 'user' : 'assistant',
        status: m.direction === 'in' ? 'message' : 'reply',
        time: parseEventTime(m.timestamp),
        title: m.direction === 'in' ? 'User message' : 'Director reply',
        detail: clipText(m.content || '', 360),
        messageKey: messageKey(m),
        sessionId: m.sessionId || sessionId || '',
        sourceDirector: source,
        payload: m,
      });
      events = events.concat(timelineToolEventsForMessage(m, i, sessionId, source));
    }
    var tasks = timelineTasks();
    for (var ti = 0; ti < tasks.length; ti++) {
      var t = tasks[ti];
      events.push({
        kind: 'task',
        status: t.status || 'task',
        time: parseEventTime(t.created_at || t.createdAt || t.started_at || t.completed_at),
        title: 'Task delegation · ' + (t.role || 'role'),
        detail: (t.description || t.prompt || t.id || '').slice(0, 420),
        taskId: t.id,
        meta: [t.id, t.agent || 'default', t.source_director || t.sourceDirector || source].filter(Boolean).join(' · '),
        sessionId: t.parent_session_id || t.parentSessionId || '',
        sourceDirector: t.source_director || t.sourceDirector || source,
        payload: t,
      });
    }
    events = events.concat(timelineAttachments());
    events = events.concat(timelineErrorEvents(tasks));
    var queue = source === 'main' ? (data && data.queue || []) : [];
    for (var qi = 0; qi < queue.length; qi++) {
      var item = queue[qi];
      events.push({
        kind: 'queue',
        status: item.cancelled ? 'cancelled' : 'queued',
        time: parseEventTime(item.timestamp),
        title: item.cancelled ? 'Queued message cancelled' : 'Queued message',
        detail: item.preview || item.text || item.correlationId || '',
        meta: item.correlationId || '',
        sourceDirector: source,
        payload: item,
      });
    }
    if (sessionId) {
      events.push({
        kind: 'session',
        status: 'context',
        time: msgs.length ? parseEventTime(msgs[0].timestamp) : 0,
        title: 'Session context',
        detail: sessionId,
        meta: source,
        sessionId: sessionId,
        sourceDirector: source,
        payload: currentSessionInfo(),
      });
    }
    events.sort(function(a, b) {
      var at = Number(a.time || 0);
      var bt = Number(b.time || 0);
      if (at !== bt) return at - bt;
      return String(a.kind).localeCompare(String(b.kind));
    });
    for (var ei = 0; ei < events.length; ei++) {
      events[ei].timelineKey = timelineEventKey(events[ei], ei);
    }
    return events;
  }

  function timelineMatchesSearch(event, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    return [event.kind, event.status, event.title, event.detail, event.meta, event.taskId, event.toolName, event.actionPath, event.logLabel].join('\n').toLowerCase().indexOf(q) >= 0;
  }

  function getVisibleConversationTimeline(messages) {
    var events = buildConversationTimeline(messages);
    var q = chatSearchQuery.trim();
    if (!q) return events;
    return events.filter(function(event) { return timelineMatchesSearch(event, q); });
  }

  function findTimelineEventByKey(key) {
    var events = buildConversationTimeline(getChronologicalSessionMessages());
    for (var i = 0; i < events.length; i++) {
      if (events[i].timelineKey === key) return events[i];
    }
    return null;
  }

  function timelineEventPayload(event) {
    if (!event) return null;
    return {
      key: event.timelineKey || '',
      kind: event.kind || '',
      status: event.status || '',
      title: event.title || '',
      detail: event.detail || '',
      meta: event.meta || '',
      time: event.time || null,
      timeIso: event.time ? new Date(event.time).toISOString() : null,
      messageKey: event.messageKey || null,
      taskId: event.taskId || null,
      toolName: event.toolName || null,
      actionPath: event.actionPath || null,
      logLabel: event.logLabel || null,
      diagnosticIndex: event.diagnosticIndex != null ? event.diagnosticIndex : null,
      sessionId: event.sessionId || null,
      sourceDirector: event.sourceDirector || currentTimelineDirector(),
      payload: event.payload == null ? null : event.payload,
    };
  }

  function clipText(text, max) {
    var value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length <= max) return value;
    return value.slice(0, Math.max(0, max - 1)) + '\u2026';
  }

  function turnMeta(turn) {
    var first = turn.messages[0] || {};
    var last = turn.messages[turn.messages.length - 1] || {};
    var inCount = turn.messages.filter(function(m) { return m.direction === 'in'; }).length;
    var outCount = turn.messages.length - inCount;
    var providers = [];
    var models = [];
    var tokens = 0;
    var tokenCount = 0;
    var inputTokens = 0;
    var inputTokenCount = 0;
    var outputTokens = 0;
    var outputTokenCount = 0;
    var costUsd = 0;
    var costCount = 0;
    var durationMs = 0;
    var durationCount = 0;
    for (var i = 0; i < turn.messages.length; i++) {
      var m = turn.messages[i];
      var provider = messageMetaValue(m, ['provider', 'agent', 'agentType', 'agent_type']);
      var model = messageMetaValue(m, ['model']);
      if (provider && providers.indexOf(String(provider)) < 0) providers.push(String(provider));
      if (model && models.indexOf(String(model)) < 0) models.push(String(model));
      var t = numericMessageMeta(m, ['tokens', 'totalTokens', 'total_tokens', 'tokenCount', 'token_count']);
      if (t != null) {
        tokens += t;
        tokenCount++;
      }
      var input = numericMessageMeta(m, ['inputTokens', 'input_tokens']);
      if (input != null) {
        inputTokens += input;
        inputTokenCount++;
      }
      var output = numericMessageMeta(m, ['outputTokens', 'output_tokens']);
      if (output != null) {
        outputTokens += output;
        outputTokenCount++;
      }
      var cost = numericMessageMeta(m, ['costUsd', 'cost_usd', 'cost']);
      if (cost != null) {
        costUsd += cost;
        costCount++;
      }
      var duration = numericMessageMeta(m, ['durationMs', 'duration_ms', 'latencyMs', 'latency_ms']);
      if (duration != null) {
        durationMs += duration;
        durationCount++;
      }
    }
    var startedMs = parseEventTime(first.timestamp);
    var endedMs = parseEventTime(last.timestamp);
    var elapsedMs = startedMs && endedMs && endedMs >= startedMs ? endedMs - startedMs : null;
    return {
      startedAt: first.timestamp,
      endedAt: last.timestamp,
      inCount: inCount,
      outCount: outCount,
      chars: turn.messages.reduce(function(sum, m) { return sum + String(m.content || '').length; }, 0),
      sessionId: last.sessionId || first.sessionId || '',
      providers: providers,
      models: models,
      tokens: tokenCount ? tokens : null,
      inputTokens: inputTokenCount ? inputTokens : null,
      outputTokens: outputTokenCount ? outputTokens : null,
      costUsd: costCount ? Number(costUsd.toFixed(6)) : null,
      durationMs: durationCount ? durationMs : null,
      elapsedMs: elapsedMs,
    };
  }

  function turnMetaParts(meta) {
    var parts = [];
    if (meta.providers && meta.providers.length) parts.push(meta.providers.join('/'));
    if (meta.models && meta.models.length) parts.push(meta.models.join('/'));
    if (meta.tokens != null) parts.push(fmtTokens(meta.tokens) + ' tokens');
    if (meta.costUsd != null) parts.push(fmtCost(meta.costUsd));
    if (meta.durationMs != null) parts.push(fmtDur(meta.durationMs));
    else if (meta.elapsedMs != null) parts.push(fmtDur(meta.elapsedMs) + ' elapsed');
    return parts;
  }

  function renderTurnMetaChips(meta) {
    var parts = turnMetaParts(meta);
    if (!parts.length) return '';
    var html = '<span class="chat-turn-metric-chips">';
    for (var i = 0; i < parts.length; i++) html += '<span>' + esc(parts[i]) + '</span>';
    html += '</span>';
    return html;
  }

  function turnPayload(turn) {
    if (!turn) return null;
    return Object.assign({}, turn, { meta: turnMeta(turn) });
  }

  function highlightPlainText(text, query) {
    var q = String(query || '').trim();
    var safe = esc(text || '');
    if (!q) return safe;
    var pattern = new RegExp(escapeRegExp(esc(q)), 'ig');
    return safe.replace(pattern, '<mark>$&</mark>');
  }

  function renderChatToolbar(total, visible) {
    var input = $('chat-search-input');
    var count = $('chat-search-count');
    var prevBtn = $('chat-search-prev');
    var nextBtn = $('chat-search-next');
    var msgBtn = $('chat-view-messages');
    var turnBtn = $('chat-view-turns');
    var timelineBtn = $('chat-view-timeline');
    var hasQuery = !!chatSearchQuery.trim();
    var canNavigate = hasQuery && visible > 0;
    if (!canNavigate) chatSearchMatchIndex = -1;
    else if (chatSearchMatchIndex < 0 || chatSearchMatchIndex >= visible) chatSearchMatchIndex = 0;
    if (input && input.value !== chatSearchQuery) input.value = chatSearchQuery;
    if (count) {
      count.textContent = canNavigate ? ((chatSearchMatchIndex + 1) + ' / ' + visible + ' matches') : (visible + ' / ' + total);
    }
    if (prevBtn) prevBtn.disabled = !canNavigate;
    if (nextBtn) nextBtn.disabled = !canNavigate;
    if (msgBtn) msgBtn.classList.toggle('active', chatViewMode === 'messages');
    if (turnBtn) turnBtn.classList.toggle('active', chatViewMode === 'turns');
    if (timelineBtn) timelineBtn.classList.toggle('active', chatViewMode === 'timeline');
    updateChatStopButton();
  }

  function scrollActiveChatSearchMatch() {
    if (!chatSearchScrollPending) return;
    chatSearchScrollPending = false;
    if (!chatSearchQuery.trim() || chatSearchMatchIndex < 0) return;
    setTimeout(function() {
      var hits = document.querySelectorAll('#chat-messages [data-search-hit="true"]');
      var target = hits[chatSearchMatchIndex];
      if (!target) return;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 0);
  }

  function activeChatDirectorState() {
    var label = viewMode === 'pool-session' ? (selectedPoolLabel || '') : 'main';
    if (viewMode === 'pool-session' && selectedPoolLabel) {
      var poolData = data && data.pool || [];
      for (var i = 0; i < poolData.length; i++) {
        var p = poolData[i];
        if (p.label !== selectedPoolLabel) continue;
        var poolLive = !selectedSessionId || selectedSessionId === p.sessionId;
        return {
          label: p.label,
          name: p.groupName || p.label,
          live: poolLive,
          processing: poolLive && (p.activity === 'processing' || !!streamingChunks[p.label]),
        };
      }
      return { label: selectedPoolLabel, name: selectedPoolLabel, live: false, processing: false };
    }
    var sys = data && data.system || {};
    var mainLive = viewMode === 'session' && (!selectedSessionId || selectedSessionId === sys.sessionId);
    return {
      label: 'main',
      name: 'Main Director',
      live: mainLive,
      processing: mainLive && ((data && data.activity && data.activity.state === 'processing') || !!streamingChunks.main),
    };
  }

  function updateChatStopButton() {
    var button = $('chat-stop-btn');
    if (!button) return;
    var inChat = viewMode === 'session' || viewMode === 'pool-session';
    var state = activeChatDirectorState();
    button.style.display = inChat ? '' : 'none';
    button.disabled = !inChat || !state.live || !state.processing;
    button.title = state.live
      ? (state.processing ? 'Stop current response for ' + state.name : 'No active response')
      : 'Open the live session to stop a response';
  }

  function formatMessageTime(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false });
    } catch {
      return '';
    }
  }

  function messageMetaValue(message, keys) {
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var value = message && message[key];
      if (value != null && value !== '') return value;
    }
    return null;
  }

  function numericMessageMeta(message, keys) {
    var value = messageMetaValue(message, keys);
    if (value == null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function messageMetaParts(message) {
    var parts = [];
    var provider = messageMetaValue(message, ['provider', 'agent', 'agentType', 'agent_type']);
    var model = messageMetaValue(message, ['model']);
    var tokens = numericMessageMeta(message, ['tokens', 'totalTokens', 'total_tokens', 'tokenCount', 'token_count']);
    var cost = numericMessageMeta(message, ['costUsd', 'cost_usd', 'cost']);
    var duration = numericMessageMeta(message, ['durationMs', 'duration_ms', 'latencyMs', 'latency_ms']);
    if (provider) parts.push(String(provider));
    if (model) parts.push(String(model));
    if (tokens != null) parts.push(fmtTokens(tokens) + ' tokens');
    if (cost != null) parts.push(fmtCost(cost));
    if (duration != null) parts.push(fmtDur(duration));
    return parts;
  }

  function renderMessageMetaChips(message) {
    var parts = messageMetaParts(message);
    if (parts.length === 0) return '';
    var html = '<span class="chat-msg-meta">';
    for (var i = 0; i < parts.length; i++) {
      html += '<span>' + esc(parts[i]) + '</span>';
    }
    html += '</span>';
    return html;
  }

  function renderMessageMetaGrid(message) {
    var provider = messageMetaValue(message, ['provider', 'agent', 'agentType', 'agent_type']) || '--';
    var model = messageMetaValue(message, ['model']) || '--';
    var tokens = numericMessageMeta(message, ['tokens', 'totalTokens', 'total_tokens', 'tokenCount', 'token_count']);
    var inputTokens = numericMessageMeta(message, ['inputTokens', 'input_tokens']);
    var outputTokens = numericMessageMeta(message, ['outputTokens', 'output_tokens']);
    var cost = numericMessageMeta(message, ['costUsd', 'cost_usd', 'cost']);
    var duration = numericMessageMeta(message, ['durationMs', 'duration_ms', 'latencyMs', 'latency_ms']);
    var turns = numericMessageMeta(message, ['numTurns', 'num_turns']);
    var html = '';
    html += '<div class="kv-card"><div class="kv-label">Provider</div><div class="kv-value">' + esc(provider) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Model</div><div class="kv-value">' + esc(model) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Tokens</div><div class="kv-value">' + esc(tokens == null ? '--' : fmtTokens(tokens)) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Input / Output</div><div class="kv-value">' + esc((inputTokens == null ? '--' : fmtTokens(inputTokens)) + ' / ' + (outputTokens == null ? '--' : fmtTokens(outputTokens))) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Cost</div><div class="kv-value">' + esc(cost == null ? '--' : fmtCost(cost)) + '</div></div>';
    html += '<div class="kv-card"><div class="kv-label">Duration</div><div class="kv-value">' + esc(duration == null ? '--' : fmtDur(duration)) + '</div></div>';
    if (turns != null) html += '<div class="kv-card"><div class="kv-label">Turns</div><div class="kv-value">' + esc(String(turns)) + '</div></div>';
    return html;
  }

  function currentTranscriptTitle() {
    if (viewMode === 'pool-session') return selectedPoolLabel || 'pool-director';
    return selectedSessionId || 'main-director';
  }

  function currentChatDirectorLabel() {
    return viewMode === 'pool-session' ? (selectedPoolLabel || 'main') : 'main';
  }

  function currentChatDirectorName() {
    if (viewMode === 'pool-session' && selectedPoolLabel) {
      var poolData = data && data.pool || [];
      var match = poolData.find(function(p) { return p.label === selectedPoolLabel; });
      return match && (match.groupName || match.label) || selectedPoolLabel;
    }
    return 'Main Director';
  }

  function currentLiveSessionId() {
    if (viewMode === 'pool-session' && selectedPoolLabel) {
      var poolData = data && data.pool || [];
      var match = poolData.find(function(p) { return p.label === selectedPoolLabel; });
      return match && match.sessionId || '';
    }
    return data && data.system && data.system.sessionId || '';
  }

  function currentSessionInfo() {
    var liveId = currentLiveSessionId();
    var sessionId = selectedSessionId || liveId || '';
    var match = sessions.find(function(s) { return s.sessionId === sessionId; }) || null;
    return {
      director: currentChatDirectorLabel(),
      directorName: currentChatDirectorName(),
      sessionId: sessionId,
      sessionName: match && match.sessionName || '',
      displayName: match ? getSessionDisplayName(match) : (sessionId ? sessionId.slice(0, 12) : 'live session'),
      messageCount: match && match.messageCount,
      firstMessageAt: match && match.firstMessageAt,
      lastMessageAt: match && match.lastMessageAt,
      live: !!sessionId && sessionId === liveId,
      liveId: liveId,
    };
  }

  function sessionRenameMatches(info) {
    return sessionRenameDraft &&
      sessionRenameDraft.sessionId === info.sessionId &&
      sessionRenameDraft.director === info.director;
  }

  function sessionRenamePayload(info, nextName) {
    return {
      director: info.director,
      session_id: info.sessionId,
      session_name: nextName || null,
    };
  }

  function renderSessionInspector(messages, turns, timeline) {
    var info = currentSessionInfo();
    var charCount = (messages || []).reduce(function(sum, msg) { return sum + String(msg.content || '').length; }, 0);
    var renaming = sessionRenameMatches(info);
    var html = '<div class="session-inspector">';
    html += '<div class="session-inspector-head"><div><span class="badge ' + (info.live ? 'running' : 'pending') + '">' + (info.live ? 'live' : 'history') + '</span>';
    html += '<strong>' + esc(info.displayName || info.sessionName || info.sessionId || 'Session') + '</strong></div>';
    html += '<div class="panel-actions">';
    if (info.sessionId) html += '<button class="mini-btn" onclick="copyText(\'' + jsq(info.sessionId) + '\')">Copy ID</button>';
    html += '<button class="mini-btn" ' + (info.sessionId ? '' : 'disabled ') + 'onclick="startSessionRename()">' + (renaming ? 'Editing' : 'Rename') + '</button>';
    if (!info.live && info.liveId) html += '<button class="mini-btn" onclick="openLiveSession()">Open Live</button>';
    html += '<button class="mini-btn" onclick="copySessionBundleJson()">Copy JSON</button>';
    html += '<button class="mini-btn" onclick="exportSessionBundleJson()">Export JSON</button>';
    html += '<button class="mini-btn" onclick="copySessionViewReport()">Copy View</button>';
    html += '<button class="mini-btn" onclick="exportSessionViewReport()">Export View</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromSessionView()">Create Task</button>';
    html += '<button class="mini-btn" onclick="copyTranscriptMarkdown()">Copy MD</button>';
    html += '<button class="mini-btn" onclick="exportTranscript()">Export MD</button>';
    html += '</div></div>';
    if (renaming) {
      var draftName = sessionRenameDraft.name != null ? sessionRenameDraft.name : (info.sessionName || info.displayName || '');
      html += '<form class="session-rename-form" onsubmit="saveSessionRename(event)">';
      html += '<label><span>Session name</span><input id="session-rename-input" value="' + esc(draftName) + '" maxlength="120" oninput="updateSessionRenameDraft(this.value)" placeholder="leave empty to clear"></label>';
      html += '<div class="panel-actions">';
      html += '<button class="mini-btn" type="button" onclick="cancelSessionRename()" ' + (sessionRenameDraft.saving ? 'disabled' : '') + '>Cancel</button>';
      html += '<button class="mini-btn primary" type="submit" ' + (sessionRenameDraft.saving ? 'disabled' : '') + '>' + (sessionRenameDraft.saving ? 'Saving...' : 'Save') + '</button>';
      html += '</div>';
      if (sessionRenameDraft.error) html += '<div class="td-error compact">' + esc(sessionRenameDraft.error) + '</div>';
      html += '</form>';
    }
    html += '<div class="session-inspector-grid">';
    html += '<div><span>Director</span><strong>' + esc(info.directorName || info.director) + '</strong></div>';
    html += '<div><span>Messages</span><strong>' + esc(String((messages || []).length)) + '</strong></div>';
    html += '<div><span>Turns</span><strong>' + esc(String((turns || []).length)) + '</strong></div>';
    html += '<div><span>Timeline</span><strong>' + esc(String((timeline || []).length)) + '</strong></div>';
    html += '<div><span>Chars</span><strong>' + esc(fmtTokens(charCount)) + '</strong></div>';
    html += '<div><span>Last Active</span><strong>' + esc(info.lastMessageAt ? formatMessageTime(info.lastMessageAt) : '--') + '</strong></div>';
    html += '</div>';
    html += '<div class="session-inspector-id mono">' + esc(info.sessionId || 'No session id yet') + '</div>';
    html += '</div>';
    return html;
  }

  window.openLiveSession = function() {
    if (viewMode === 'pool-session' && selectedPoolLabel) {
      var name = currentChatDirectorName();
      selectPoolDirector(selectedPoolLabel, name);
    } else {
      selectSession(null);
    }
  };

  window.renameCurrentSession = async function() {
    startSessionRename();
  };

  window.startSessionRename = function() {
    var info = currentSessionInfo();
    if (!info.sessionId) {
      showToast('No session to rename', false);
      return;
    }
    sessionRenameDraft = {
      director: info.director,
      sessionId: info.sessionId,
      originalName: info.sessionName || '',
      name: info.sessionName || info.displayName || '',
      saving: false,
      error: '',
    };
    renderSessionView();
    setTimeout(function() {
      var input = $('session-rename-input');
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  };

  window.updateSessionRenameDraft = function(value) {
    if (!sessionRenameDraft) return;
    sessionRenameDraft.name = value;
  };

  window.cancelSessionRename = function() {
    sessionRenameDraft = null;
    renderSessionView();
  };

  window.saveSessionRename = async function(event) {
    if (event) event.preventDefault();
    var info = currentSessionInfo();
    if (!sessionRenameMatches(info)) {
      showToast('Rename target changed', false);
      sessionRenameDraft = null;
      renderSessionView();
      return;
    }
    var nextName = String(sessionRenameDraft.name || '').trim();
    sessionRenameDraft.saving = true;
    sessionRenameDraft.error = '';
    renderSessionView();
    try {
      var res = await fetch('/api/sessions/name', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionRenamePayload(info, nextName)),
      });
      var body = await res.json().catch(function() { return {}; });
      if (!res.ok || body.error) throw new Error(body.error || 'rename failed');
      sessions = (sessions || []).map(function(session) {
        if (session.sessionId !== info.sessionId) return session;
        return Object.assign({}, session, { sessionName: nextName || null });
      });
      sessionRenameDraft = null;
      showToast(nextName ? 'Session renamed' : 'Session name cleared', true);
      loadSessions(info.director);
      renderSessionView();
    } catch (err) {
      if (sessionRenameDraft) {
        sessionRenameDraft.saving = false;
        sessionRenameDraft.error = 'Rename failed: ' + err.message;
      }
      showToast('Rename failed: ' + err.message, false);
      renderSessionView();
    }
  };

  window.setChatSearch = function(value) {
    var next = String(value || '');
    if (next !== chatSearchQuery) {
      chatSearchMatchIndex = next.trim() ? 0 : -1;
      chatSearchScrollPending = !!next.trim();
    }
    chatSearchQuery = next;
    renderSessionView();
  };

  window.setChatViewMode = function(mode) {
    chatViewMode = mode === 'turns' || mode === 'timeline' ? mode : 'messages';
    chatDetailSelection = null;
    chatSearchMatchIndex = chatSearchQuery.trim() ? 0 : -1;
    chatSearchScrollPending = !!chatSearchQuery.trim();
    renderSessionView();
  };

  window.goChatSearchMatch = function(delta) {
    var q = chatSearchQuery.trim();
    if (!q) return;
    var count = document.querySelectorAll('#chat-messages [data-search-hit="true"]').length;
    if (!count) {
      showToast('No search matches', false);
      return;
    }
    var next = chatSearchMatchIndex;
    if (next < 0 || next >= count) next = 0;
    else next = (next + Number(delta || 1) + count) % count;
    chatSearchMatchIndex = next;
    chatSearchScrollPending = true;
    renderSessionView();
  };

  window.showChatDetail = function(kind, id) {
    chatDetailSelection = { kind: kind, id: id };
    renderSessionView();
  };

  window.closeChatDetail = function() {
    chatDetailSelection = null;
    renderSessionView();
  };

  function renderChatReplyPreview() {
    var el = $('chat-reply-preview');
    if (!el) return;
    if (!chatReplyDraft) {
      el.classList.remove('visible');
      el.innerHTML = '';
      return;
    }
    var role = chatReplyDraft.direction === 'in' ? 'User' : 'Director';
    var time = chatReplyDraft.timestamp ? formatMessageTime(chatReplyDraft.timestamp) : '';
    el.classList.add('visible');
    el.innerHTML = '<div class="chat-reply-main">' +
      '<div class="chat-reply-title"><span>Replying to ' + esc(role) + '</span>' + (time ? '<span class="muted">' + esc(time) + '</span>' : '') + '</div>' +
      '<div class="chat-reply-text">' + esc(shortText(chatReplyDraft.text || '', 220)) + '</div>' +
      '</div><button class="chat-reply-clear" title="Clear reply" onclick="clearChatReplyDraft()">&times;</button>';
  }

  window.clearChatReplyDraft = function() {
    chatReplyDraft = null;
    renderChatReplyPreview();
    var input = $('chat-input');
    if (input) input.focus();
  };

  window.quoteMessage = function(index) {
    var messages = getChronologicalSessionMessages();
    var message = messages.find(function(m) { return String(m._chatIndex) === String(index); });
    if (!message) return;
    var input = $('chat-input');
    if (!input) return;
    chatReplyDraft = {
      key: messageKey(message),
      direction: message.direction || '',
      timestamp: message.timestamp || null,
      text: String(message.content || ''),
    };
    renderChatReplyPreview();
    input.focus();
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  };

  window.resendMessage = function(index) {
    var messages = getChronologicalSessionMessages();
    var message = messages.find(function(m) { return String(m._chatIndex) === String(index); });
    if (!message || message.direction !== 'in') return;
    var input = $('chat-input');
    if (!input) return;
    input.value = String(message.content || '');
    input.focus();
  };

  window.copyMarkdownMessage = function(index) {
    var messages = getChronologicalSessionMessages();
    var message = messages.find(function(m) { return String(m._chatIndex) === String(index); });
    if (!message) return;
    window.copyText(String(message.content || ''));
  };

  window.copyMessageJson = function(index) {
    var messages = getChronologicalSessionMessages();
    var message = messages.find(function(m) { return String(m._chatIndex) === String(index); });
    if (!message) {
      showToast('Message not found', false);
      return;
    }
    window.copyText(JSON.stringify(message, null, 2));
  };

  window.exportMessageJson = function(index) {
    var messages = getChronologicalSessionMessages();
    var message = messages.find(function(m) { return String(m._chatIndex) === String(index); });
    if (!message) {
      showToast('Message not found', false);
      return;
    }
    var safe = String(message.direction === 'in' ? 'user-message' : 'director-reply').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-message-' + safe + '-' + Date.now() + '.json', JSON.stringify(message, null, 2));
    showToast('Message JSON exported', true);
  };

  window.copyTurnMarkdown = function(turnId) {
    var turns = buildChatTurns(getChronologicalSessionMessages());
    var turn = turns.find(function(t) { return t.id === turnId; });
    if (!turn) return;
    var lines = [];
    for (var i = 0; i < turn.messages.length; i++) {
      var m = turn.messages[i];
      lines.push('## ' + (m.direction === 'in' ? 'User' : 'Director'));
      lines.push('');
      lines.push(String(m.content || '').trim());
      lines.push('');
    }
    window.copyText(lines.join('\n'));
  };

  window.copyTurnJson = function(turnId) {
    var turns = buildChatTurns(getChronologicalSessionMessages());
    var turn = turns.find(function(t) { return t.id === turnId; });
    if (!turn) {
      showToast('Turn not found', false);
      return;
    }
    window.copyText(JSON.stringify(turnPayload(turn), null, 2));
  };

  window.exportTurnJson = function(turnId) {
    var turns = buildChatTurns(getChronologicalSessionMessages());
    var turn = turns.find(function(t) { return t.id === turnId; });
    if (!turn) {
      showToast('Turn not found', false);
      return;
    }
    downloadTextFile('persona-turn-' + String(turn.index + 1) + '-' + Date.now() + '.json', JSON.stringify(turnPayload(turn), null, 2));
    showToast('Turn JSON exported', true);
  };

  window.copyTimelineEventJson = function(key) {
    var event = findTimelineEventByKey(key);
    if (!event) {
      showToast('Timeline event not found', false);
      return;
    }
    window.copyText(JSON.stringify(timelineEventPayload(event), null, 2));
  };

  window.exportTimelineEventJson = function(key) {
    var event = findTimelineEventByKey(key);
    if (!event) {
      showToast('Timeline event not found', false);
      return;
    }
    var safe = String(event.kind || 'timeline').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-timeline-' + safe + '-' + Date.now() + '.json', JSON.stringify(timelineEventPayload(event), null, 2));
    showToast('Timeline event exported', true);
  };

  function timelineToolPayloadByKey(key) {
    var event = findTimelineEventByKey(key);
    if (!event || event.kind !== 'tool') return null;
    var payload = event.payload || {};
    return {
      exportedAt: new Date().toISOString(),
      key: event.timelineKey || key,
      status: event.status || '',
      toolName: event.toolName || '',
      messageKey: event.messageKey || null,
      sessionId: event.sessionId || null,
      sourceDirector: event.sourceDirector || currentTimelineDirector(),
      tool: payload.tool || null,
      toolResult: payload.toolResult || null,
      message: payload.message || null,
    };
  }

  window.copyTimelineToolPayload = function(key) {
    var payload = timelineToolPayloadByKey(key);
    if (!payload) {
      showToast('Timeline tool payload not found', false);
      return;
    }
    window.copyText(JSON.stringify(payload, null, 2));
  };

  window.exportTimelineToolPayload = function(key) {
    var payload = timelineToolPayloadByKey(key);
    if (!payload) {
      showToast('Timeline tool payload not found', false);
      return;
    }
    var safe = String(payload.toolName || 'tool').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-timeline-tool-' + safe + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Timeline tool payload exported', true);
  };

  window.openChatDetailSession = function(sessionId) {
    sessionId = String(sessionId || '').trim();
    if (!sessionId) {
      showToast('No session id on this detail', false);
      return;
    }
    var director = currentChatDirectorLabel();
    if (director && director !== 'main') {
      selectSubSession(director, sessionId, sessionId.slice(0, 16));
    } else {
      selectSession(sessionId);
    }
  };

  window.toggleChatTurn = function(turnId) {
    expandedChatTurns[turnId] = !expandedChatTurns[turnId];
    renderSessionView();
  };

  window.clearChatSearch = function() {
    chatSearchQuery = '';
    chatSearchMatchIndex = -1;
    chatSearchScrollPending = false;
    renderSessionView();
  };

  window.stopActiveResponse = async function() {
    var state = activeChatDirectorState();
    if (!state.live) {
      showToast('Open the live session before stopping a response', false);
      return;
    }
    if (!state.processing) {
      showToast('No active response to stop', false);
      return;
    }
    try {
      var res;
      if (state.label === 'main') {
        res = await fetch('/api/esc', { method: 'POST' });
      } else {
        res = await fetch('/api/directors/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ director_label: state.label, command: 'esc' }),
        });
      }
      var body = await res.json().catch(function() { return {}; });
      if (!res.ok || body.error) throw new Error(body.error || body.message || 'stop failed');
      delete streamingChunks[state.label];
      showToast(body.message || 'Stop requested', body.ok !== false);
      renderSessionView();
      updateChatStopButton();
    } catch (err) {
      showToast('Stop failed: ' + err.message, false);
    }
  };

  window.reloadCurrentChat = function() {
    if (viewMode === 'pool-session' && selectedPoolLabel) {
      loadPoolDirectorMessages(selectedPoolLabel, selectedSessionId);
    } else if (viewMode === 'session' && selectedSessionId) {
      loadSessionMessages(selectedSessionId);
    } else if (viewMode === 'session') {
      loadAllMessages();
    }
  };

  function transcriptMarkdown(messages) {
    var msgs = messages || [];
    var title = currentTranscriptTitle();
    var info = currentSessionInfo();
    var lines = ['# Transcript - ' + title, '', '- exported_at: ' + new Date().toISOString(), '- director: ' + (info.director || 'main'), '- session_id: ' + (info.sessionId || ''), '- messages: ' + msgs.length, ''];
    if (chatSearchQuery.trim()) lines.push('- search: ' + chatSearchQuery.trim(), '');
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var role = m.direction === 'in' ? 'User' : 'Director';
      var time = formatMessageTime(m.timestamp);
      lines.push('## ' + role + (time ? ' · ' + time : ''));
      lines.push('');
      lines.push(String(m.content || '').trim());
      lines.push('');
    }
    return lines.join('\n');
  }

  function transcriptSafeTitle() {
    var title = currentTranscriptTitle();
    return title.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'transcript';
  }

  function sessionBundlePayload() {
    var allMsgs = getChronologicalSessionMessages();
    var visibleMsgs = getVisibleSessionMessages();
    var allTurns = buildChatTurns(allMsgs);
    var visibleTurns = getVisibleChatTurns();
    var allTimeline = buildConversationTimeline(allMsgs).map(timelineEventPayload);
    var visibleTimeline = getVisibleConversationTimeline(allMsgs).map(timelineEventPayload);
    return {
      exportedAt: new Date().toISOString(),
      session: currentSessionInfo(),
      view: {
        mode: chatViewMode,
        searchQuery: chatSearchQuery.trim(),
        selectedDetail: chatDetailSelection || null,
      },
      counts: {
        messages: allMsgs.length,
        visibleMessages: visibleMsgs.length,
        turns: allTurns.length,
        visibleTurns: visibleTurns.length,
        timelineEvents: allTimeline.length,
        visibleTimelineEvents: visibleTimeline.length,
      },
      transcriptMarkdown: transcriptMarkdown(visibleMsgs),
      messages: allMsgs,
      visibleMessages: visibleMsgs,
      turns: allTurns.map(turnPayload),
      visibleTurns: visibleTurns.map(turnPayload),
      timeline: allTimeline,
      visibleTimeline: visibleTimeline,
    };
  }

  function sessionViewReportPayload() {
    var bundle = sessionBundlePayload();
    var visibleItems;
    if (chatViewMode === 'turns') visibleItems = bundle.visibleTurns;
    else if (chatViewMode === 'timeline') visibleItems = bundle.visibleTimeline;
    else visibleItems = bundle.visibleMessages;
    return {
      exportedAt: new Date().toISOString(),
      session: bundle.session,
      view: {
        mode: bundle.view.mode,
        searchQuery: bundle.view.searchQuery,
        selectedDetail: bundle.view.selectedDetail,
        activeSearchMatchIndex: chatSearchMatchIndex,
      },
      counts: bundle.counts,
      visibleCount: Array.isArray(visibleItems) ? visibleItems.length : 0,
      visibleItems: visibleItems,
    };
  }

  function sessionTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench session handoff as task context.',
      '',
      'Operator intent:',
      '- Continue from this conversation or extract a concrete background task from it.',
      '- Respect the current view mode and search filter; visibleItems are the operator-focused subset.',
      '- Use transcriptMarkdown for narrative context and timeline/details for evidence.',
      '',
      'Session handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function sessionEvidenceTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench session evidence as task context.',
      '',
      'Operator intent:',
      '- Review the selected conversation evidence first, then use the surrounding session view for context.',
      '- Turn this message, turn, or timeline event into a concrete follow-up task only if action is needed.',
      '- If the evidence points to a tool, task, file, diagnostic, or runtime issue, inspect the linked target before changing state.',
      '- Preserve the original conversation intent and avoid broad changes unless the task prompt is edited.',
      '',
      'Session evidence handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromSessionView = function() {
    var payload = sessionViewReportPayload();
    if (!payload.counts.messages) {
      showToast('No session view to turn into a task', false);
      return;
    }
    var info = payload.session || {};
    var label = info.displayName || info.sessionName || info.sessionId || info.directorName || 'session';
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: info.director || currentChatDirectorLabel() || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Continue from session: ' + label,
      prompt: sessionTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Session view loaded into task form', true);
  };

  window.createTaskFromSessionMessage = function(index) {
    var messages = getChronologicalSessionMessages();
    var message = messages.find(function(m) { return String(m._chatIndex) === String(index); });
    if (!message) {
      showToast('Message not found', false);
      return;
    }
    var info = currentSessionInfo();
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'sessionMessage',
      sessionView: sessionViewReportPayload(),
      message: message,
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: info.director || currentChatDirectorLabel() || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Follow up session message: ' + shortText(message.content || info.displayName || 'message', 80),
      prompt: sessionEvidenceTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Session message loaded into task form', true);
  };

  window.createTaskFromSessionTurn = function(turnId) {
    var turns = buildChatTurns(getChronologicalSessionMessages());
    var turn = turns.find(function(t) { return t.id === turnId; });
    if (!turn) {
      showToast('Turn not found', false);
      return;
    }
    var info = currentSessionInfo();
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'sessionTurn',
      sessionView: sessionViewReportPayload(),
      turn: turnPayload(turn),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: info.director || currentChatDirectorLabel() || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Follow up session turn: ' + (turn.index + 1),
      prompt: sessionEvidenceTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Session turn loaded into task form', true);
  };

  window.createTaskFromTimelineEvent = function(key) {
    var event = findTimelineEventByKey(key);
    if (!event) {
      showToast('Timeline event not found', false);
      return;
    }
    var info = currentSessionInfo();
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'timelineEvent',
      sessionView: sessionViewReportPayload(),
      event: timelineEventPayload(event),
      toolPayload: event.kind === 'tool' ? timelineToolPayloadByKey(key) : null,
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: event.sourceDirector || info.director || currentChatDirectorLabel() || 'main',
      project_dir: '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Follow up timeline event: ' + shortText((event.title || event.kind || 'event') + (event.detail ? ' - ' + event.detail : ''), 80),
      prompt: sessionEvidenceTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Timeline event loaded into task form', true);
  };

  window.copySessionBundleJson = function() {
    var payload = sessionBundlePayload();
    if (!payload.counts.messages) {
      showToast('No session messages to copy', false);
      return;
    }
    window.copyText(JSON.stringify(payload, null, 2));
  };

  window.exportSessionBundleJson = function() {
    var payload = sessionBundlePayload();
    if (!payload.counts.messages) {
      showToast('No session messages to export', false);
      return;
    }
    downloadTextFile('persona-session-' + transcriptSafeTitle() + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Session JSON exported', true);
  };

  window.copySessionViewReport = function() {
    var payload = sessionViewReportPayload();
    if (!payload.counts.messages) {
      showToast('No session view to copy', false);
      return;
    }
    window.copyText(JSON.stringify(payload, null, 2));
  };

  window.exportSessionViewReport = function() {
    var payload = sessionViewReportPayload();
    if (!payload.counts.messages) {
      showToast('No session view to export', false);
      return;
    }
    downloadTextFile('persona-session-view-' + transcriptSafeTitle() + '-' + Date.now() + '.json', JSON.stringify(payload, null, 2));
    showToast('Session view report exported', true);
  };

  window.copyTranscriptMarkdown = function() {
    var msgs = getVisibleSessionMessages();
    if (msgs.length === 0) {
      showToast('No messages to copy', false);
      return;
    }
    window.copyText(transcriptMarkdown(msgs));
  };

  window.exportTranscript = function() {
    var msgs = getVisibleSessionMessages();
    if (msgs.length === 0) {
      showToast('No messages to export', false);
      return;
    }
    downloadTextFile('persona-' + transcriptSafeTitle() + '-' + Date.now() + '.md', transcriptMarkdown(msgs));
    showToast('Transcript exported', true);
  };

  function renderChatMessage(message, activeSearchHit) {
    var isIn = message.direction === 'in';
    var isMatch = chatSearchQuery.trim() && messageMatchesSearch(message, chatSearchQuery);
    var key = messageKey(message);
    var html = '<div class="chat-msg ' + (isIn ? 'in' : 'out') + (isMatch ? ' match' : '') + (activeSearchHit ? ' active-search-hit' : '') + '" data-chat-key="' + esc(key) + '"' + (isMatch ? ' data-search-hit="true"' : '') + '>';
    html += '<div class="chat-msg-header">';
    html += '<span class="chat-msg-role ' + (isIn ? 'user' : 'bot') + '">' + (isIn ? 'User' : 'Director') + '</span>';
    if (message.timestamp) html += '<span class="chat-msg-time">' + esc(formatMessageTime(message.timestamp)) + '</span>';
    html += renderMessageMetaChips(message);
    html += '<button class="chat-msg-action" onclick="copyText(\'' + jsq(message.content || '') + '\')">Copy</button>';
    if (!isIn) html += '<button class="chat-msg-action" onclick="copyMarkdownMessage(\'' + jsq(String(message._chatIndex)) + '\')">Copy MD</button>';
    html += '<button class="chat-msg-action" onclick="quoteMessage(\'' + jsq(String(message._chatIndex)) + '\')">Quote</button>';
    if (isIn) html += '<button class="chat-msg-action" onclick="resendMessage(\'' + jsq(String(message._chatIndex)) + '\')">Resend</button>';
    html += '<button class="chat-msg-action" onclick="showChatDetail(\'message\',\'' + jsq(key) + '\')">Details</button>';
    html += '</div>';
    html += '<div class="chat-msg-body">';
    if (isIn) {
      html += highlightPlainText(message.content, chatSearchQuery);
    } else {
      html += '<div class="md-content">' + renderMd(message.content) + '</div>';
    }
    html += '</div></div>';
    return html;
  }

  function renderChatTurn(turn, activeSearchHit) {
    var meta = turnMeta(turn);
    var user = turn.messages.find(function(m) { return m.direction === 'in'; });
    var assistants = turn.messages.filter(function(m) { return m.direction === 'out'; });
    var lastAssistant = assistants[assistants.length - 1] || null;
    var expanded = !!expandedChatTurns[turn.id];
    var isMatch = chatSearchQuery.trim() && turnMatchesSearch(turn, chatSearchQuery);
    var html = '<div class="chat-turn' + (expanded ? ' expanded' : '') + (activeSearchHit ? ' active-search-hit' : '') + '"' + (isMatch ? ' data-search-hit="true"' : '') + '>';
    html += '<div class="chat-turn-header">';
    html += '<div><div class="chat-turn-title">Turn ' + (turn.index + 1) + '</div>';
    html += '<div class="chat-turn-meta">' + esc(formatMessageTime(meta.startedAt) || '--') + ' · ' + turn.messages.length + ' messages · ' + meta.chars + ' chars</div>';
    html += renderTurnMetaChips(meta) + '</div>';
    html += '<div class="panel-actions">';
    html += '<button class="chat-msg-action" onclick="toggleChatTurn(\'' + jsq(turn.id) + '\')">' + (expanded ? 'Collapse' : 'Expand') + '</button>';
    html += '<button class="chat-msg-action" onclick="copyTurnMarkdown(\'' + jsq(turn.id) + '\')">Copy MD</button>';
    html += '<button class="chat-msg-action" onclick="showChatDetail(\'turn\',\'' + jsq(turn.id) + '\')">Details</button>';
    if (user) html += '<button class="chat-msg-action" onclick="resendMessage(\'' + jsq(String(user._chatIndex)) + '\')">Resend</button>';
    html += '</div></div>';
    if (expanded) {
      html += '<div class="chat-turn-expanded">';
      for (var i = 0; i < turn.messages.length; i++) {
        html += renderChatTurnMessage(turn.messages[i]);
      }
      html += '</div>';
    } else {
      html += '<div class="chat-turn-body">';
      html += '<div class="chat-turn-snippet user"><span>User</span><p>' + esc(clipText(user && user.content || '(no user message)', 260)) + '</p></div>';
      html += '<div class="chat-turn-snippet assistant"><span>Director</span><p>' + esc(clipText(lastAssistant && lastAssistant.content || '(no response yet)', 320)) + '</p></div>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderChatTurnMessage(message) {
    var isIn = message.direction === 'in';
    var html = '<div class="chat-turn-message ' + (isIn ? 'user' : 'assistant') + '">';
    html += '<div class="chat-turn-message-head">';
    html += '<span class="chat-msg-role ' + (isIn ? 'user' : 'bot') + '">' + (isIn ? 'User' : 'Director') + '</span>';
    if (message.timestamp) html += '<span class="chat-msg-time">' + esc(formatMessageTime(message.timestamp)) + '</span>';
    html += renderMessageMetaChips(message);
    html += '<button class="chat-msg-action" onclick="copyMarkdownMessage(\'' + jsq(String(message._chatIndex)) + '\')">Copy MD</button>';
    html += '<button class="chat-msg-action" onclick="quoteMessage(\'' + jsq(String(message._chatIndex)) + '\')">Quote</button>';
    if (isIn) html += '<button class="chat-msg-action" onclick="resendMessage(\'' + jsq(String(message._chatIndex)) + '\')">Resend</button>';
    html += '</div>';
    html += '<div class="chat-turn-message-body">';
    if (isIn) {
      html += highlightPlainText(message.content, chatSearchQuery);
    } else {
      html += '<div class="md-content">' + renderMd(message.content) + '</div>';
    }
    html += '</div></div>';
    return html;
  }

  function timelineBadgeClass(event) {
    if (event.kind === 'error') return event.status === 'cancelled' ? 'cancelled' : 'failed';
    if (event.kind === 'assistant') return 'completed';
    if (event.kind === 'task') {
      if (event.status === 'completed') return 'completed';
      if (event.status === 'failed') return 'failed';
      if (event.status === 'running') return 'running';
      return 'pending';
    }
    if (event.kind === 'attachment') return 'ok';
    if (event.kind === 'tool') return event.status === 'error' ? 'failed' : (event.status === 'result' ? 'completed' : 'running');
    if (event.kind === 'queue' && event.status === 'cancelled') return 'cancelled';
    if (event.kind === 'session') return 'pending';
    return 'pending';
  }

  function renderTimelineEvent(event, index, activeSearchHit) {
    var isMatch = chatSearchQuery.trim() && timelineMatchesSearch(event, chatSearchQuery);
    var key = event.timelineKey || timelineEventKey(event, index);
    var html = '<div class="timeline-event ' + esc(event.kind || 'event') + (activeSearchHit ? ' active-search-hit' : '') + '"' + (isMatch ? ' data-search-hit="true"' : '') + '>';
    html += '<div class="timeline-rail"><span></span></div>';
    html += '<div class="timeline-card">';
    html += '<div class="timeline-card-head">';
    html += '<div><span class="badge ' + timelineBadgeClass(event) + '">' + esc(event.kind || 'event') + '</span> <strong>' + esc(event.title || 'Event') + '</strong></div>';
    html += '<span class="timeline-time">' + esc(formatMessageTime(event.time) || (event.time ? fmtAgo(event.time) : '--')) + '</span>';
    html += '</div>';
    if (event.detail) html += '<div class="timeline-detail">' + highlightPlainText(event.detail, chatSearchQuery) + '</div>';
    if (event.meta) html += '<div class="panel-row-sub">' + esc(event.meta) + '</div>';
    html += '<div class="panel-actions timeline-actions">';
    if (event.messageKey) html += '<button class="chat-msg-action" onclick="showChatDetail(\'message\',\'' + jsq(event.messageKey) + '\')">Message Details</button>';
    if (event.kind === 'tool') html += '<button class="chat-msg-action" onclick="copyTimelineToolPayload(\'' + jsq(key) + '\')">Copy Tool</button>';
    if (event.taskId) html += '<button class="chat-msg-action" onclick="selectTask(\'' + jsq(event.taskId) + '\')">Open Task</button>';
    if (event.actionPath) html += '<button class="chat-msg-action" onclick="openWorkbenchFile(\'' + jsq(event.actionPath) + '\')">Open File</button>';
    if (event.diagnosticIndex != null && event.logLabel) {
      html += '<button class="chat-msg-action" onclick="openDiagnosticErrorLog(' + Number(event.diagnosticIndex) + ')">Open Log</button>';
      html += '<button class="chat-msg-action" onclick="searchDiagnosticError(' + Number(event.diagnosticIndex) + ')">Search</button>';
    } else if (event.diagnosticIndex != null) {
      html += '<button class="chat-msg-action" onclick="searchDiagnosticError(' + Number(event.diagnosticIndex) + ')">Search</button>';
    }
    html += '<button class="chat-msg-action" onclick="showChatDetail(\'timeline\',\'' + jsq(key) + '\')">Details</button>';
    html += '<button class="chat-msg-action" onclick="copyText(\'' + jsq([event.title, event.detail, event.meta].filter(Boolean).join('\\n')) + '\')">Copy</button>';
    html += '</div></div></div>';
    return html;
  }

  function renderConversationTimeline(events) {
    if (!events || events.length === 0) {
      return '<div class="empty" style="padding:40px">No timeline events match this search</div>';
    }
    var html = '<div class="conversation-timeline">';
    for (var i = 0; i < events.length; i++) {
      html += renderTimelineEvent(events[i], i, chatSearchQuery.trim() && i === chatSearchMatchIndex);
    }
    html += '</div>';
    return html;
  }

  function renderChatDetailPanel(allMessages, turns) {
    if (!chatDetailSelection) return '';
    var selection = chatDetailSelection;
    var html = '<div class="chat-detail-panel">';
    html += '<div class="panel-title"><span>Details</span><button class="mini-btn" onclick="closeChatDetail()">Close</button></div>';
    if (selection.kind === 'message') {
      var message = allMessages.find(function(m) { return messageKey(m) === selection.id; });
      if (!message) return '';
      html += '<div class="kv-grid">';
      html += '<div class="kv-card"><div class="kv-label">Type</div><div class="kv-value">' + esc(message.direction === 'in' ? 'User Message' : 'Director Reply') + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Time</div><div class="kv-value">' + esc(formatMessageTime(message.timestamp) || '--') + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Session</div><div class="kv-value">' + esc(message.sessionId || '--') + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Characters</div><div class="kv-value">' + String(String(message.content || '').length) + '</div></div>';
      html += renderMessageMetaGrid(message);
      html += '</div>';
      html += '<div class="panel-actions chat-detail-actions">';
      html += '<button class="mini-btn" onclick="copyMarkdownMessage(\'' + jsq(String(message._chatIndex)) + '\')">Copy Markdown</button>';
      html += '<button class="mini-btn" onclick="copyMessageJson(\'' + jsq(String(message._chatIndex)) + '\')">Copy JSON</button>';
      html += '<button class="mini-btn" onclick="exportMessageJson(\'' + jsq(String(message._chatIndex)) + '\')">Export JSON</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromSessionMessage(\'' + jsq(String(message._chatIndex)) + '\')">Create Task</button>';
      if (message.sessionId) html += '<button class="mini-btn" onclick="openChatDetailSession(\'' + jsq(message.sessionId) + '\')">Open Session</button>';
      html += '<button class="mini-btn" onclick="quoteMessage(\'' + jsq(String(message._chatIndex)) + '\')">Quote</button>';
      html += '</div>';
      html += '<pre class="chat-detail-raw">' + esc(message.content || '') + '</pre>';
    } else if (selection.kind === 'turn') {
      var turn = turns.find(function(t) { return t.id === selection.id; });
      if (!turn) return '';
      var meta = turnMeta(turn);
      html += '<div class="kv-grid">';
      html += '<div class="kv-card"><div class="kv-label">Turn</div><div class="kv-value">' + (turn.index + 1) + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Messages</div><div class="kv-value">' + turn.messages.length + ' (' + meta.inCount + ' in / ' + meta.outCount + ' out)</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Session</div><div class="kv-value">' + esc(meta.sessionId || '--') + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Characters</div><div class="kv-value">' + meta.chars + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Provider</div><div class="kv-value">' + esc(meta.providers.length ? meta.providers.join(' / ') : '--') + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Model</div><div class="kv-value">' + esc(meta.models.length ? meta.models.join(' / ') : '--') + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Tokens</div><div class="kv-value">' + esc(meta.tokens == null ? '--' : fmtTokens(meta.tokens)) + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Input / Output</div><div class="kv-value">' + esc((meta.inputTokens == null ? '--' : fmtTokens(meta.inputTokens)) + ' / ' + (meta.outputTokens == null ? '--' : fmtTokens(meta.outputTokens))) + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Cost</div><div class="kv-value">' + esc(meta.costUsd == null ? '--' : fmtCost(meta.costUsd)) + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Duration</div><div class="kv-value">' + esc(meta.durationMs == null ? (meta.elapsedMs == null ? '--' : fmtDur(meta.elapsedMs) + ' elapsed') : fmtDur(meta.durationMs)) + '</div></div>';
      html += '</div>';
      html += '<div class="panel-actions chat-detail-actions">';
      html += '<button class="mini-btn" onclick="copyTurnMarkdown(\'' + jsq(turn.id) + '\')">Copy Turn Markdown</button>';
      html += '<button class="mini-btn" onclick="copyTurnJson(\'' + jsq(turn.id) + '\')">Copy JSON</button>';
      html += '<button class="mini-btn" onclick="exportTurnJson(\'' + jsq(turn.id) + '\')">Export JSON</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromSessionTurn(\'' + jsq(turn.id) + '\')">Create Task</button>';
      if (meta.sessionId) html += '<button class="mini-btn" onclick="openChatDetailSession(\'' + jsq(meta.sessionId) + '\')">Open Session</button>';
      html += '</div>';
      html += '<div class="chat-detail-timeline">';
      for (var i = 0; i < turn.messages.length; i++) {
        var m = turn.messages[i];
        html += '<div class="chat-detail-event"><span class="chat-msg-role ' + (m.direction === 'in' ? 'user' : 'bot') + '">' + (m.direction === 'in' ? 'User' : 'Director') + '</span>';
        html += '<span class="chat-msg-time">' + esc(formatMessageTime(m.timestamp) || '--') + '</span>';
        html += '<p>' + esc(clipText(m.content, 420)) + '</p></div>';
      }
      html += '</div>';
    } else if (selection.kind === 'timeline') {
      var event = findTimelineEventByKey(selection.id);
      if (!event) return '';
      var payload = timelineEventPayload(event);
      html += '<div class="kv-grid">';
      html += '<div class="kv-card"><div class="kv-label">Kind</div><div class="kv-value">' + esc(event.kind || '--') + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Status</div><div class="kv-value">' + esc(event.status || '--') + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Time</div><div class="kv-value">' + esc(formatMessageTime(event.time) || '--') + '</div></div>';
      html += '<div class="kv-card"><div class="kv-label">Director</div><div class="kv-value">' + esc(event.sourceDirector || currentTimelineDirector()) + '</div></div>';
      if (event.sessionId) html += '<div class="kv-card"><div class="kv-label">Session</div><div class="kv-value">' + esc(event.sessionId) + '</div></div>';
      if (event.taskId) html += '<div class="kv-card"><div class="kv-label">Task</div><div class="kv-value">' + esc(event.taskId) + '</div></div>';
      if (event.toolName) html += '<div class="kv-card"><div class="kv-label">Tool</div><div class="kv-value">' + esc(event.toolName) + '</div></div>';
      if (event.actionPath) html += '<div class="kv-card"><div class="kv-label">File</div><div class="kv-value">' + esc(event.actionPath) + '</div></div>';
      if (event.logLabel) html += '<div class="kv-card"><div class="kv-label">Log</div><div class="kv-value">' + esc(event.logLabel) + '</div></div>';
      if (event.diagnosticIndex != null) html += '<div class="kv-card"><div class="kv-label">Diagnostic</div><div class="kv-value">#' + esc(String(Number(event.diagnosticIndex) + 1)) + '</div></div>';
      html += '</div>';
      html += '<div class="panel-actions chat-detail-actions">';
      html += '<button class="mini-btn" onclick="copyTimelineEventJson(\'' + jsq(event.timelineKey) + '\')">Copy JSON</button>';
      html += '<button class="mini-btn" onclick="exportTimelineEventJson(\'' + jsq(event.timelineKey) + '\')">Export JSON</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromTimelineEvent(\'' + jsq(event.timelineKey) + '\')">Create Task</button>';
      if (event.kind === 'tool') {
        html += '<button class="mini-btn" onclick="copyTimelineToolPayload(\'' + jsq(event.timelineKey) + '\')">Copy Tool Payload</button>';
        html += '<button class="mini-btn" onclick="exportTimelineToolPayload(\'' + jsq(event.timelineKey) + '\')">Export Tool Payload</button>';
      }
      if (event.messageKey) html += '<button class="mini-btn" onclick="showChatDetail(\'message\',\'' + jsq(event.messageKey) + '\')">Open Message</button>';
      if (event.taskId) html += '<button class="mini-btn" onclick="selectTask(\'' + jsq(event.taskId) + '\')">Open Task</button>';
      if (event.actionPath) html += '<button class="mini-btn" onclick="openWorkbenchFile(\'' + jsq(event.actionPath) + '\')">Open File</button>';
      if (event.diagnosticIndex != null && event.logLabel) {
        html += '<button class="mini-btn" onclick="openDiagnosticErrorLog(' + Number(event.diagnosticIndex) + ')">Open Log</button>';
        html += '<button class="mini-btn" onclick="searchDiagnosticError(' + Number(event.diagnosticIndex) + ')">Search</button>';
      } else if (event.diagnosticIndex != null) {
        html += '<button class="mini-btn" onclick="searchDiagnosticError(' + Number(event.diagnosticIndex) + ')">Search</button>';
      }
      if (event.sessionId) html += '<button class="mini-btn" onclick="openChatDetailSession(\'' + jsq(event.sessionId) + '\')">Open Session</button>';
      html += '</div>';
      if (event.detail) html += '<div class="timeline-detail">' + esc(event.detail) + '</div>';
      if (event.meta) html += '<div class="panel-row-sub">' + esc(event.meta) + '</div>';
      html += '<pre class="chat-detail-raw">' + esc(JSON.stringify(payload, null, 2)) + '</pre>';
    }
    html += '</div>';
    return html;
  }

  function renderSessionView() {
    var el = $('chat-messages');
    if (!el) return;

    if (!sessionMessages || sessionMessages.length === 0) {
      renderChatToolbar(0, 0);
      el.innerHTML = renderSessionInspector([], [], []) + '<div class="empty" style="padding:40px">No messages found</div>';
      if (viewMode === 'session' || viewMode === 'pool-session') {
        $('chat-input-bar').classList.add('visible');
      } else {
        $('chat-input-bar').classList.remove('visible');
      }
      return;
    }

    // Messages come most-recent-first from API, reverse for chronological display
    var allMsgs = getChronologicalSessionMessages();
    var allTurns = buildChatTurns(allMsgs);
    var msgs = getVisibleSessionMessages();
    var visibleTurns = getVisibleChatTurns();
    var allTimeline = buildConversationTimeline(allMsgs);
    var visibleTimeline = getVisibleConversationTimeline(allMsgs);
    var totalCount = chatViewMode === 'turns' ? allTurns.length : (chatViewMode === 'timeline' ? allTimeline.length : allMsgs.length);
    var visibleCount = chatViewMode === 'turns' ? visibleTurns.length : (chatViewMode === 'timeline' ? visibleTimeline.length : msgs.length);
    renderChatToolbar(totalCount, visibleCount);
    var html = renderSessionInspector(allMsgs, allTurns, allTimeline);

    if (chatViewMode === 'messages' && msgs.length === 0) {
      html += '<div class="empty" style="padding:40px">No messages match this search</div>';
    }
    if (chatViewMode === 'turns' && visibleTurns.length === 0) {
      html += '<div class="empty" style="padding:40px">No turns match this search</div>';
    }

    if (chatViewMode === 'timeline') {
      html += renderConversationTimeline(visibleTimeline);
    } else if (chatViewMode === 'turns') {
      for (var ti = 0; ti < visibleTurns.length; ti++) {
        html += renderChatTurn(visibleTurns[ti], chatSearchQuery.trim() && ti === chatSearchMatchIndex);
      }
    } else {
      for (var i = 0; i < msgs.length; i++) {
        html += renderChatMessage(msgs[i], chatSearchQuery.trim() && i === chatSearchMatchIndex);
      }
    }
    html += renderChatDetailPanel(allMsgs, allTurns);

    // [BUG4 FIX] Show processing indicator for both main and pool directors
    var isLiveSession = false;
    var isProcessing = false;
    if (viewMode === 'session') {
      isLiveSession = data && data.system &&
        (selectedSessionId === data.system.sessionId || !selectedSessionId);
      isProcessing = isLiveSession && data && data.activity && data.activity.state === 'processing';
    } else if (viewMode === 'pool-session' && selectedPoolLabel) {
      var poolData = (data && data.pool) || [];
      for (var pi = 0; pi < poolData.length; pi++) {
        var pe = poolData[pi];
        if (pe.label === selectedPoolLabel) {
          isLiveSession = !selectedSessionId || selectedSessionId === pe.sessionId;
          isProcessing = isLiveSession && pe.activity === 'processing';
          break;
        }
      }
    }
    var streamLabel = viewMode === 'pool-session' ? selectedPoolLabel : 'main';
    var hasStreamingChunks = streamLabel && streamingChunks[streamLabel];
    if (hasStreamingChunks) {
      html += '<div class="chat-msg out streaming" id="streaming-bubble-' + streamLabel + '">' +
        '<div class="chat-msg-header">' +
        '<span class="chat-msg-role bot">Director</span>' +
        '<div class="running-dot" style="margin-left:4px"></div>' +
        '</div>' +
        '<div class="chat-msg-body"><div class="md-content" id="streaming-content-' + streamLabel + '">' +
        renderMd(streamingChunks[streamLabel] + ' \u258d') +
        '</div></div></div>';
    }
    if (isProcessing && !hasStreamingChunks) {
      html += '<div class="chat-processing"><div class="running-dot"></div><span>Processing...</span></div>';
    }

    el.innerHTML = html;
    scrollActiveChatSearchMatch();

    // Scroll to bottom
    var scroll = $('chat-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;

    // Show/hide input bar based on live session
    var inputBar = $('chat-input-bar');
    if (isLiveSession || viewMode === 'pool-session') {
      inputBar.classList.add('visible');
      renderChatReplyPreview();
      setTimeout(function() { $('chat-input').focus(); }, 0);
    } else {
      inputBar.classList.remove('visible');
      renderChatReplyPreview();
    }
  }

  // ── Render: Task Detail View (Split: Logs + Result) ──
  function renderTaskView() {
    var container = $('detail-content');
    container.classList.add('task-split-mode');

    if (!taskDetail) {
      container.innerHTML = '<div class="empty" style="padding:40px">Loading task...</div>';
      return;
    }

    var t = taskDetail;
    var html = '<div class="task-detail-split">';

    // Left panel — logs
    html += '<div class="td-log-panel">';
    html += '<div class="td-panel-header">';
    html += '<div class="td-section-title" style="margin:0">Logs</div>';
    html += '<div style="display:flex;align-items:center;gap:8px">';
    if (t.status === 'running' || t.status === 'dispatched') {
      html += '<div class="running-dot"></div><span style="font-size:11px;color:var(--green)">Live</span>';
    }
    html += '<span style="font-size:11px;color:var(--overlay0);font-family:var(--font-mono)">' + esc(t.role) + '</span>';
    html += '</div></div>';
    html += '<div id="td-log-toolbar"></div>';
    html += '<div class="td-log-scroll" id="td-log-scroll"><div id="td-log-entries"></div></div>';
    html += '<div id="td-log-detail"></div>';
    html += '</div>';

    // Resize handle between log and result panels
    html += '<div class="resize-handle" id="task-split-resize"></div>';

    // Right panel — result + meta
    html += '<div class="td-result-panel">';
    html += '<div class="td-panel-header">';
    html += '<div class="td-section-title" style="margin:0">Result</div>';
    html += '<span class="badge ' + esc(t.status) + '">' + esc(t.status) + '</span>';
    html += '</div>';
    html += '<div class="td-result-scroll" id="td-result-content"></div>';
    html += '</div>';

    html += '</div>';
    container.innerHTML = html;

    renderTaskResultPanel();
    renderTaskLogToolbar();
    renderTaskLogDetailPanel();

    taskLogs = [];
    taskLogTotalLines = 0;
    loadTaskLogs(t.id, 0);

    if (t.status === 'running' || t.status === 'dispatched') {
      startLogPolling(t.id);
    }
  }

	  function renderTaskResultPanel() {
	    var el = $('td-result-content');
	    if (!el || !taskDetail) return;

    var t = taskDetail;
    var html = '';

    html += '<div class="task-actions">';
    html += '<button class="mini-btn" onclick="copyText(\'' + jsq(t.id) + '\')">Copy ID</button>';
    html += '<button class="mini-btn" onclick="copyTaskHandoffBundle(\'' + jsq(t.id) + '\')">Copy Handoff</button>';
    html += '<button class="mini-btn" onclick="exportTaskHandoffBundle(\'' + jsq(t.id) + '\')">Export Handoff</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromTaskHandoff(\'' + jsq(t.id) + '\')">Handoff Task</button>';
    html += '<button class="mini-btn" onclick="copyTaskAsNew(\'' + jsq(t.id) + '\')">Copy as New</button>';
    html += '<button class="mini-btn" onclick="retryTask(\'' + jsq(t.id) + '\')">Retry</button>';
    if (t.status === 'running' || t.status === 'dispatched') {
      html += '<button class="mini-btn danger" onclick="cancelTask(\'' + jsq(t.id) + '\')">Cancel</button>';
    }
    if (t.result_file) {
      html += '<button class="mini-btn" onclick="sendWorkbenchFile(\'' + jsq(t.result_file) + '\')">Send Result</button>';
    }
    html += '</div>';

    html += '<div class="td-meta" style="margin-bottom:12px">';
    html += '<div class="td-field"><div class="td-field-label">Task ID</div><div class="td-field-value">' + esc(t.id) + '</div></div>';
    html += '<div class="td-field"><div class="td-field-label">Role</div><div class="td-field-value">' + esc(t.role || '--') + '</div></div>';
    html += '<div class="td-field"><div class="td-field-label">Provider</div><div class="td-field-value">' + esc(t.agent || 'default') + '</div></div>';
    html += '<div class="td-field"><div class="td-field-label">Model</div><div class="td-field-value">' + esc(taskExtraValue(t, 'model') || 'default') + '</div></div>';
    html += '<div class="td-field"><div class="td-field-label">Source</div><div class="td-field-value">' + esc(t.source_director || 'none') + '</div></div>';
    html += '<div class="td-field"><div class="td-field-label">Created</div><div class="td-field-value">' + esc(t.created_at || '--') + '</div></div>';
    if (t.timeout_ms != null) {
      html += '<div class="td-field"><div class="td-field-label">Timeout</div><div class="td-field-value">' + esc(String(t.timeout_ms)) + 'ms</div></div>';
    }
    html += '<div class="td-field"><div class="td-field-label">Retry</div><div class="td-field-value">' + esc(String(t.retry_count || 0)) + ' / ' + esc(String(t.max_retry == null ? 3 : t.max_retry)) + '</div></div>';
    if (t.duration_ms != null) {
      html += '<div class="td-field"><div class="td-field-label">Duration</div><div class="td-field-value">' + fmtDur(t.duration_ms) + '</div></div>';
    }
    if (t.cost_usd != null) {
      html += '<div class="td-field"><div class="td-field-label">Cost</div><div class="td-field-value">' + fmtCost(t.cost_usd) + '</div></div>';
    }
    html += '</div>';

    html += renderTaskRunMetadata(t);
    html += renderTaskEvidencePanel(t);

    if (t.description) {
      html += '<div style="font-size:13px;color:var(--subtext1);margin-bottom:12px">' + esc(t.description) + '</div>';
    }

    // Prompt section
    if (t.prompt) {
      html += '<div class="td-section">';
      html += '<div class="td-section-title">Prompt</div>';
      html += '<div class="td-prompt">' + esc(t.prompt) + '</div>';
      html += '</div>';
    }

    if (t.status === 'running' || t.status === 'dispatched') {
      html += '<div class="td-result-running"><div class="spinner"></div><span>Running...</span></div>';
    }

    if (t.error) {
      html += '<div class="td-error" style="margin-bottom:12px">' + esc(t.error) + '</div>';
    }

    if (taskOutput) {
      html += '<div class="td-output"><div class="md-content">' + renderMd(taskOutput) + '</div></div>';
    } else if (t.result_file && t.status === 'completed') {
      html += '<div class="empty">Loading output...</div>';
    }

    el.innerHTML = html;
  }

  function taskDisplayStatus(t) {
    if (t && t.status === 'failed' && t.error === 'cancelled') return 'cancelled';
    return t && t.status || 'pending';
  }

  function taskParentDirector(t) {
    return taskExtraValue(t, 'parent_director_label') || (t && (t.source_director || t.sourceDirector)) || 'main';
  }

  function taskParentSessionId(t) {
    return taskExtraValue(t, 'parent_session_id') || taskExtraValue(t, 'parent_codex_thread_id');
  }

  function taskParentSessionName(t) {
    return taskExtraValue(t, 'parent_session_name') || taskParentSessionId(t);
  }

  function taskParentGroupName(t) {
    return taskExtraValue(t, 'parent_group_name') || taskParentDirector(t);
  }

  function taskRunMetadataPayload(t) {
    if (!t) return null;
    var extra = t.extra || {};
    var spawnArgs = Array.isArray(extra.spawnArgs) ? extra.spawnArgs.map(function(item) { return String(item); }) : [];
    return {
      exportedAt: new Date().toISOString(),
      taskId: t.id || '',
      status: taskDisplayStatus(t),
      spawnArgs: spawnArgs,
      pid: taskExtraValue(t, 'pid'),
      codexThreadId: taskExtraValue(t, 'codex_thread_id'),
      parent: {
        director: taskParentDirector(t),
        sessionId: taskParentSessionId(t),
        sessionName: taskParentSessionName(t),
        threadId: taskExtraValue(t, 'parent_codex_thread_id') || taskParentSessionId(t),
        groupName: taskParentGroupName(t),
        agent: taskExtraValue(t, 'parent_agent') || taskExtraValue(t, 'parent_agent_type'),
        role: taskExtraValue(t, 'parent_persona_role'),
        pid: taskExtraValue(t, 'parent_pid'),
      },
      projectDir: taskExtraValue(t, 'project_dir'),
      cronJobId: taskExtraValue(t, 'cronJobId'),
      retriedFrom: taskExtraValue(t, 'retried_from'),
      task: {
        id: t.id || '',
        role: t.role || '',
        agent: t.agent || '',
        model: taskExtraValue(t, 'model'),
        sourceDirector: t.source_director || t.sourceDirector || '',
        createdAt: t.created_at || t.createdAt || '',
        startedAt: t.started_at || t.startedAt || '',
        completedAt: t.completed_at || t.completedAt || '',
        durationMs: t.duration_ms != null ? t.duration_ms : t.durationMs,
        costUsd: t.cost_usd != null ? t.cost_usd : t.costUsd,
        timeoutMs: t.timeout_ms != null ? t.timeout_ms : t.timeoutMs,
        retryCount: t.retry_count != null ? t.retry_count : t.retryCount,
        maxRetry: t.max_retry != null ? t.max_retry : t.maxRetry,
        resultFile: t.result_file || t.resultFile || '',
        error: t.error || '',
      },
      extra: extra,
      rawTask: t,
    };
  }

  function renderTaskRunMetadata(t) {
    var extra = t.extra || {};
    var spawnArgs = Array.isArray(extra.spawnArgs) ? extra.spawnArgs.map(function(item) { return String(item); }) : [];
    var pid = extra.pid != null ? String(extra.pid) : '';
    var codexThreadId = taskExtraValue(t, 'codex_thread_id');
    var parentThreadId = taskExtraValue(t, 'parent_codex_thread_id') || taskParentSessionId(t);
    var parentSessionId = taskParentSessionId(t);
    var parentSessionName = taskParentSessionName(t);
    var parentLabel = taskParentDirector(t);
    var parentGroup = taskExtraValue(t, 'parent_group_name');
    var parentAgent = taskExtraValue(t, 'parent_agent') || taskExtraValue(t, 'parent_agent_type');
    var parentRole = taskExtraValue(t, 'parent_persona_role');
    var parentPid = taskExtraValue(t, 'parent_pid');
    var projectDir = taskExtraValue(t, 'project_dir');
    var retriedFrom = taskExtraValue(t, 'retried_from');
    var cronJobId = taskExtraValue(t, 'cronJobId');
    var status = taskDisplayStatus(t);
    var hasMetadata = pid || codexThreadId || parentThreadId || parentAgent || projectDir || retriedFrom || cronJobId || spawnArgs.length;
    var html = '<div class="run-metadata">';
    html += '<div class="panel-title"><span>Run Metadata</span><span class="badge ' + esc(status) + '">' + esc(status) + '</span></div>';
    html += '<div class="panel-actions run-meta-actions">';
    if (parentSessionId) html += '<button class="mini-btn" onclick="openTaskParentContext(\'' + jsq(t.id) + '\',\'session\')">Open Parent Session</button>';
    if (parentLabel) html += '<button class="mini-btn" onclick="openTaskParentContext(\'' + jsq(t.id) + '\',\'director\')">Open Parent Director</button>';
    html += '<button class="mini-btn" onclick="copyTaskRunMetadata(\'' + jsq(t.id) + '\')">Copy Metadata</button>';
    html += '<button class="mini-btn" onclick="exportTaskRunMetadata(\'' + jsq(t.id) + '\')">Export Metadata</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromTaskRunMetadata(\'' + jsq(t.id) + '\')">Create Task</button>';
    html += '</div>';
    html += '<div class="run-meta-grid">';
    html += runMetaField('PID', pid || '--', pid ? 'pid' : '');
    html += runMetaField('Codex Thread', codexThreadId || '--', codexThreadId);
    html += runMetaField('Parent Director', parentLabel || '--', parentLabel);
    html += runMetaField(parentSessionName && parentSessionName !== parentThreadId ? 'Parent Session' : 'Parent Thread', parentSessionName || parentThreadId || '--', parentThreadId || parentSessionName);
    html += runMetaField('Parent Agent', parentAgent || '--', parentAgent);
    html += runMetaField('Parent Role', parentRole || '--', parentRole);
    if (parentGroup) html += runMetaField('Parent Group', parentGroup, parentGroup);
    if (parentPid) html += runMetaField('Parent PID', parentPid, parentPid);
    if (projectDir) html += runMetaField('Project Dir', projectDir, projectDir);
    if (cronJobId) html += runMetaField('Cron Job', cronJobId, cronJobId);
    if (retriedFrom) html += runMetaField('Retried From', retriedFrom, retriedFrom);
    html += '</div>';
    if (!hasMetadata) {
      html += '<div class="empty compact">No runtime metadata has been recorded yet.</div>';
    }
    if (spawnArgs.length > 0) {
      var argsText = spawnArgs.join(' \\\n  ');
      html += '<div class="td-section run-spawn-section">';
      html += '<div class="td-section-title">Spawn Args (' + spawnArgs.length + ')</div>';
      html += '<div class="panel-actions" style="margin-bottom:8px">';
      html += '<button class="mini-btn" onclick="copyText(\'' + jsq(argsText) + '\')">Copy Args</button>';
      html += '</div>';
      html += '<div class="td-prompt run-spawn-args">' + esc(argsText) + '</div>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  window.openTaskParentContext = function(taskId, mode) {
    var task = taskDetail && taskDetail.id === taskId ? taskDetail : null;
    if (!task) task = (taskCenterData.tasks || []).find(function(item) { return item.id === taskId; }) || null;
    if (!task) {
      showToast('Task metadata is not loaded', false);
      return;
    }
    var director = taskParentDirector(task) || 'main';
    var sessionId = taskParentSessionId(task);
    var sessionName = taskParentSessionName(task);
    var groupName = taskParentGroupName(task);
    if (mode === 'session' && sessionId) {
      if (director && director !== 'main') {
        selectSubSession(director, sessionId, sessionName || sessionId.slice(0, 16));
      } else {
        selectSession(sessionId);
      }
      return;
    }
    if (director && director !== 'main') {
      selectPoolDirector(director, groupName || director);
    } else {
      selectSession(null);
    }
  };

  window.copyTaskRunMetadata = function(taskId) {
    var task = taskDetail && taskDetail.id === taskId ? taskDetail : null;
    if (!task) task = (taskCenterData.tasks || []).find(function(item) { return item.id === taskId; }) || null;
    if (!task) {
      showToast('Task run metadata is not loaded', false);
      return;
    }
    copyText(JSON.stringify(taskRunMetadataPayload(task), null, 2));
  };

  window.exportTaskRunMetadata = function(taskId) {
    var task = taskDetail && taskDetail.id === taskId ? taskDetail : null;
    if (!task) task = (taskCenterData.tasks || []).find(function(item) { return item.id === taskId; }) || null;
    if (!task) {
      showToast('Task run metadata is not loaded', false);
      return;
    }
    var safe = String(taskId || 'task').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-task-run-metadata-' + safe + '-' + Date.now() + '.json', JSON.stringify(taskRunMetadataPayload(task), null, 2));
    showToast('Task run metadata exported', true);
  };

  function taskRunMetadataTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench task run metadata as task context.',
      '',
      'Operator intent:',
      '- Investigate the task runtime lineage before changing task/session/runtime state.',
      '- Use spawn args, PID, Codex thread, parent Director/session, project directory, cron/retry metadata, task handoff, runtime snapshot, and approval context before acting.',
      '- If metadata shows a bad source Director, missing parent context, failed retry chain, cron linkage, wrong project dir, or suspicious spawn args, identify the likely cause and propose or implement a scoped fix.',
      '- Do not retry tasks, kill processes, change cron jobs, or alter session state unless the task prompt is explicitly edited.',
      '',
      'Task run metadata handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromTaskRunMetadata = function(taskId) {
    var task = taskDetail && taskDetail.id === taskId ? taskDetail : null;
    if (!task) task = (taskCenterData.tasks || []).find(function(item) { return item.id === taskId; }) || null;
    if (!task) {
      showToast('Task run metadata is not loaded', false);
      return;
    }
    var metadata = taskRunMetadataPayload(task);
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'taskRunMetadata',
      metadata: metadata,
      taskHandoff: taskDetail && taskDetail.id === task.id ? taskHandoffPayload(task) : null,
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: metadata.parent.director || metadata.task.sourceDirector || 'main',
      project_dir: metadata.projectDir || '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review task run metadata: ' + (metadata.taskId || 'task'),
      prompt: taskRunMetadataTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Task run metadata loaded into task form', true);
  };

  function runMetaField(label, value, copyValue) {
    var html = '<div class="run-meta-field"><div class="td-field-label">' + esc(label) + '</div>';
    html += '<div class="run-meta-value">' + esc(value || '--') + '</div>';
    if (copyValue && copyValue !== '--') {
      html += '<button class="chat-msg-action" onclick="copyText(\'' + jsq(copyValue) + '\')">Copy</button>';
    }
    html += '</div>';
    return html;
  }

  function taskEvidenceSummary(t) {
    if (taskOutput) {
      var lines = String(taskOutput).split('\n').map(function(line) { return line.trim(); }).filter(Boolean);
      var useful = lines.filter(function(line) { return !/^#/.test(line) && !/^[-*]\s*$/.test(line); });
      return clipText((useful[0] || lines[0] || '').replace(/^[-*]\s+/, ''), 260);
    }
    if (t.error) return clipText(t.error, 260);
    if (t.status === 'completed') return t.result_file ? 'Result artifact is ready. Output preview is still loading.' : 'Completed without a result artifact.';
    if (t.status === 'failed') return 'Task failed before producing a readable result.';
    if (t.status === 'running' || t.status === 'dispatched') return 'Task is still running. Evidence will update when logs and output arrive.';
    return 'No completion evidence yet.';
  }

  function taskEvidencePayload(t) {
    if (!t) return null;
    var sent = t.result_file ? sentArtifacts[t.result_file] : null;
    var artifactState = t.result_file ? 'ready' : 'none';
    var outputState = taskOutput ? 'loaded' : (t.result_file ? 'pending' : 'none');
    return {
      exportedAt: new Date().toISOString(),
      taskId: t.id || '',
      status: taskDisplayStatus(t),
      summary: taskEvidenceSummary(t),
      followUp: t.status === 'failed' ? 'retry' : (t.status === 'completed' ? 'review' : 'wait'),
      artifact: {
        state: artifactState,
        path: t.result_file || '',
      },
      output: {
        state: outputState,
        loaded: !!taskOutput,
        preview: taskOutput ? shortText(taskOutput, 1200) : '',
        length: taskOutput ? String(taskOutput).length : 0,
      },
      sent: sent ? Object.assign({}, sent, { state: 'sent' }) : { state: 'not_sent' },
      parent: {
        director: taskParentDirector(t),
        sessionId: taskParentSessionId(t),
        sessionName: taskParentSessionName(t),
        groupName: taskParentGroupName(t),
      },
      runtime: {
        pid: taskExtraValue(t, 'pid'),
        codexThreadId: taskExtraValue(t, 'codex_thread_id'),
        projectDir: taskExtraValue(t, 'project_dir'),
        cronJobId: taskExtraValue(t, 'cronJobId'),
      },
      task: t,
    };
  }

  function renderTaskEvidencePanel(t) {
    var sent = t.result_file ? sentArtifacts[t.result_file] : null;
    var artifactState = t.result_file ? 'ready' : 'none';
    var outputState = taskOutput ? 'loaded' : (t.result_file ? 'pending' : 'none');
    var sentState = sent ? ('sent ' + fmtAgo(sent.sentAt)) : 'not sent';
    var html = '<div class="completion-evidence">';
    html += '<div class="panel-title"><span>Completion Evidence</span><span class="badge ' + esc(t.status || 'pending') + '">' + esc(t.status || 'pending') + '</span></div>';
    html += '<div class="evidence-grid">';
    html += '<div><span>Artifact</span><strong>' + esc(artifactState) + '</strong></div>';
    html += '<div><span>Output</span><strong>' + esc(outputState) + '</strong></div>';
    html += '<div><span>Sent</span><strong>' + esc(sentState) + '</strong></div>';
    html += '<div><span>Follow-up</span><strong>' + (t.status === 'failed' ? 'retry' : (t.status === 'completed' ? 'review' : 'wait')) + '</strong></div>';
    html += '</div>';
    html += '<div class="evidence-summary">' + esc(taskEvidenceSummary(t)) + '</div>';
    if (t.result_file) {
      html += '<div class="file-path mono">' + esc(t.result_file) + '</div>';
    }
    html += '<div class="panel-actions evidence-actions">';
    if (t.result_file) {
      html += '<button class="mini-btn" onclick="copyText(\'' + jsq(t.result_file) + '\')">Copy Path</button>';
      html += '<button class="mini-btn" onclick="revealLocalPath(\'' + jsq(t.result_file) + '\')">Reveal</button>';
      html += '<button class="mini-btn" onclick="openWorkbenchFile(\'' + jsq(t.result_file) + '\')">Open Artifact</button>';
      html += '<button class="mini-btn" onclick="sendWorkbenchFile(\'' + jsq(t.result_file) + '\')">Send Result</button>';
    }
    html += '<button class="mini-btn" onclick="copyTaskEvidenceBundle(\'' + jsq(t.id) + '\')">Copy Evidence</button>';
    html += '<button class="mini-btn" onclick="exportTaskEvidenceBundle(\'' + jsq(t.id) + '\')">Export Evidence</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromTaskEvidence(\'' + jsq(t.id) + '\')">Create Task</button>';
    if (taskOutput) {
      html += '<button class="mini-btn" onclick="copyTaskResult(\'' + jsq(t.id) + '\')">Copy Result</button>';
      html += '<button class="mini-btn" onclick="exportTaskResult(\'' + jsq(t.id) + '\')">Export Result</button>';
      html += '<button class="mini-btn primary" onclick="createTaskFromTaskResult(\'' + jsq(t.id) + '\')">Result Task</button>';
    }
    if (t.status === 'failed') {
      html += '<button class="mini-btn primary" onclick="retryTask(\'' + jsq(t.id) + '\')">Retry</button>';
    } else {
      html += '<button class="mini-btn" onclick="copyTaskAsNew(\'' + jsq(t.id) + '\')">Copy as New</button>';
    }
    html += '</div></div>';
    return html;
  }

  window.copyTaskEvidenceBundle = function(taskId) {
    var task = taskDetail && taskDetail.id === taskId ? taskDetail : null;
    if (!task) {
      showToast('Task evidence is not loaded', false);
      return;
    }
    copyText(JSON.stringify(taskEvidencePayload(task), null, 2));
  };

  window.exportTaskEvidenceBundle = function(taskId) {
    var task = taskDetail && taskDetail.id === taskId ? taskDetail : null;
    if (!task) {
      showToast('Task evidence is not loaded', false);
      return;
    }
    var safe = String(taskId || 'task').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-task-evidence-' + safe + '-' + Date.now() + '.json', JSON.stringify(taskEvidencePayload(task), null, 2));
    showToast('Task evidence exported', true);
  };

  function taskEvidenceTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench task completion evidence as task context.',
      '',
      'Operator intent:',
      '- Review this task completion state before retrying, copying, sending artifacts, or changing related runtime/session state.',
      '- Use completion evidence, task handoff, run metadata, visible logs, result preview, runtime snapshot, and approval context before acting.',
      '- If the task failed, identify the likely cause and propose or implement a scoped fix.',
      '- If the task completed, verify whether the result artifact/output is ready, useful, sent, or needs follow-up.',
      '- Do not retry tasks, send artifacts, or alter task/session state unless the task prompt is explicitly edited.',
      '',
      'Task completion evidence handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromTaskEvidence = function(taskId) {
    var task = taskDetail && taskDetail.id === taskId ? taskDetail : null;
    if (!task) {
      showToast('Task evidence is not loaded', false);
      return;
    }
    var evidence = taskEvidencePayload(task);
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'taskCompletionEvidence',
      evidence: evidence,
      taskHandoff: taskHandoffPayload(task),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: taskParentDirector(task) || task.source_director || 'main',
      project_dir: taskExtraValue(task, 'project_dir') || '',
      timeout_ms: '',
      max_retry: 3,
      description: (task.status === 'failed' ? 'Investigate failed task evidence: ' : 'Review task completion evidence: ') + (task.id || 'task'),
      prompt: taskEvidenceTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Task evidence loaded into task form', true);
  };

  window.exportTaskResult = function(taskId) {
    if (!taskOutput) {
      showToast('No result output loaded', false);
      return;
    }
    var safe = String(taskId || 'task-result').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-' + safe + '-result-' + Date.now() + '.md', taskOutput);
    showToast('Task result exported', true);
  };

  window.copyTaskResult = function(taskId) {
    if (!taskOutput) {
      showToast('No result output loaded', false);
      return;
    }
    copyText(taskOutput);
    showToast('Task result copied', true);
  };

  function taskResultTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench task result handoff as task context.',
      '',
      'Operator intent:',
      '- Review the task result output itself before deciding whether to deliver, summarize, document, revise, or follow up.',
      '- Compare the result with the original prompt, completion evidence, handoff, visible logs, artifact path, runtime snapshot, and approval context.',
      '- If the output is incomplete, weak, stale, unsent, or inconsistent with the task prompt, propose or implement a scoped follow-up.',
      '- Do not retry tasks, send artifacts, or alter task/session state unless the task prompt is explicitly edited.',
      '',
      'Task result handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromTaskResult = function(taskId) {
    var task = taskDetail && taskDetail.id === taskId ? taskDetail : null;
    if (!task || !taskOutput) {
      showToast('Task result output is not loaded', false);
      return;
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'taskResultOutput',
      taskId: task.id || taskId,
      result: {
        file: task.result_file || task.resultFile || '',
        length: String(taskOutput || '').length,
        preview: shortText(taskOutput || '', 5000),
        content: taskOutput || '',
      },
      taskHandoff: taskHandoffPayload(task),
      completionEvidence: taskEvidencePayload(task),
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: taskParentDirector(task) || task.source_director || 'main',
      project_dir: taskExtraValue(task, 'project_dir') || '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Review task result output: ' + (task.id || 'task'),
      prompt: taskResultTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Task result loaded into task form', true);
  };

  window.openWorkbenchFile = function(path) {
    filesData.selectedPath = path;
    selectNav('files');
  };

  function loadTaskLogs(taskId, after) {
    var url = '/api/tasks/' + taskId + '/logs';
    if (after > 0) url += '?after=' + after;
    fetch(url).then(function(r) { return r.json(); }).then(function(d) {
      if (!d) return;
      if (d.entries && d.entries.length > 0) {
        taskLogs = taskLogs.concat(d.entries);
        taskLogTotalLines = d.totalLines;
        renderTaskLogToolbar();
        renderTaskLogEntries(after > 0);
      } else if (d.totalLines != null) {
        taskLogTotalLines = d.totalLines;
        renderTaskLogToolbar();
      }
    }).catch(function() {});
  }

  function taskLogType(e) {
    if (e && e.type === 'tool_result' && e.meta && e.meta.is_error) return 'error';
    return e && e.type || 'text';
  }

  function taskLogMatchesFilter(e) {
    var type = taskLogFilters.type || 'all';
    var actual = taskLogType(e);
    if (type !== 'all') {
      if (type === 'tool') {
        if (actual !== 'tool_use' && actual !== 'tool_result' && actual !== 'error') return false;
      } else if (actual !== type) {
        return false;
      }
    }
    var query = (taskLogFilters.query || '').trim().toLowerCase();
    if (!query) return true;
    var haystack = [
      e && e.type,
      actual,
      e && e.content,
      e && e.meta ? JSON.stringify(e.meta) : '',
    ].join('\n').toLowerCase();
    return haystack.indexOf(query) >= 0;
  }

  function visibleTaskLogs() {
    return taskLogs.filter(taskLogMatchesFilter);
  }

  function taskLogEntryKey(e, fallbackIndex) {
    if (e && e.line != null) return 'line-' + String(e.line);
    return 'idx-' + String(fallbackIndex == null ? taskLogs.indexOf(e) : fallbackIndex);
  }

  function findTaskLogEntry(key) {
    for (var i = 0; i < taskLogs.length; i++) {
      if (taskLogEntryKey(taskLogs[i], i) === key) return taskLogs[i];
    }
    return null;
  }

  function taskLogEntryJson(e) {
    return {
      task_id: selectedTaskId || (taskDetail && taskDetail.id) || null,
      line: e && e.line,
      type: taskLogType(e),
      raw_type: e && e.type,
      content: e && e.content || '',
      meta: e && e.meta || null,
    };
  }

  function taskLogsPayload(entries) {
    var source = entries || [];
    return source.map(function(e) { return taskLogEntryJson(e); });
  }

  function taskHandoffPayload(t) {
    if (!t) return null;
    var visibleLogs = visibleTaskLogs();
    return {
      exportedAt: new Date().toISOString(),
      taskId: t.id || '',
      status: taskDisplayStatus(t),
      summary: taskEvidenceSummary(t),
      description: t.description || '',
      prompt: t.prompt || '',
      runMetadata: taskRunMetadataPayload(t),
      completionEvidence: taskEvidencePayload(t),
      result: {
        file: t.result_file || t.resultFile || '',
        loaded: !!taskOutput,
        length: taskOutput ? String(taskOutput).length : 0,
        preview: taskOutput ? shortText(taskOutput, 2400) : '',
      },
      logs: {
        filters: {
          type: taskLogFilters.type || 'all',
          query: taskLogFilters.query || '',
        },
        totalLoaded: taskLogs.length,
        visibleCount: visibleLogs.length,
        visible: taskLogsPayload(visibleLogs),
        loaded: taskLogsPayload(taskLogs),
      },
      parent: {
        director: taskParentDirector(t),
        sessionId: taskParentSessionId(t),
        sessionName: taskParentSessionName(t),
        groupName: taskParentGroupName(t),
      },
    };
  }

  function taskLogEntryTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench task log handoff as task context.',
      '',
      'Operator intent:',
      '- Investigate or continue from this specific task log entry.',
      '- Use entry first, then compare it with taskHandoff, runMetadata, completionEvidence, logs, and result preview.',
      '- If the entry is an error, identify the likely root cause and propose or implement a concrete fix.',
      '- Keep follow-up changes scoped to the evidence in this handoff unless the task prompt is edited.',
      '',
      'Task log handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.copyTaskHandoffBundle = function(taskId) {
    var task = taskDetail && taskDetail.id === taskId ? taskDetail : null;
    if (!task) {
      showToast('Task handoff is not loaded', false);
      return;
    }
    copyText(JSON.stringify(taskHandoffPayload(task), null, 2));
  };

  window.exportTaskHandoffBundle = function(taskId) {
    var task = taskDetail && taskDetail.id === taskId ? taskDetail : null;
    if (!task) {
      showToast('Task handoff is not loaded', false);
      return;
    }
    var safe = String(taskId || 'task').replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-task-handoff-' + safe + '-' + Date.now() + '.json', JSON.stringify(taskHandoffPayload(task), null, 2));
    showToast('Task handoff exported', true);
  };

  function taskHandoffTaskPromptPayload(payload) {
    return [
      'Use the following Persona Workbench task handoff as task context.',
      '',
      'Operator intent:',
      '- Continue, review, or repair this task using the complete handoff before changing task/session/runtime state.',
      '- Use run metadata, completion evidence, visible logs, result preview, parent session/Director, runtime snapshot, and approval context before acting.',
      '- If the task failed or produced weak evidence, identify the likely cause and propose or implement a scoped follow-up.',
      '- If the task completed, verify the result and decide whether a follow-up, artifact delivery, documentation update, or no-op is appropriate.',
      '- Do not retry tasks, send artifacts, or alter task/session state unless the task prompt is explicitly edited.',
      '',
      'Task handoff JSON:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  window.createTaskFromTaskHandoff = function(taskId) {
    var task = taskDetail && taskDetail.id === taskId ? taskDetail : null;
    if (!task) {
      showToast('Task handoff is not loaded', false);
      return;
    }
    var handoff = taskHandoffPayload(task);
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'taskHandoff',
      handoff: handoff,
      runtimeSnapshot: runtimeSnapshotPayload(),
      approvalQueue: approvalQueuePayload(),
      approvalHistory: approvalHistoryPayload(),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: taskParentDirector(task) || task.source_director || 'main',
      project_dir: taskExtraValue(task, 'project_dir') || '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Continue from task handoff: ' + (task.id || 'task'),
      prompt: taskHandoffTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Task handoff loaded into task form', true);
  };

  function renderTaskLogEntryActions(key) {
    return '<div class="log-entry-actions">' +
      '<button class="chat-msg-action" onclick="event.stopPropagation();showTaskLogEntryDetail(\'' + jsq(key) + '\')">Details</button>' +
      '<button class="chat-msg-action" onclick="event.stopPropagation();copyTaskLogEntryJson(\'' + jsq(key) + '\')">Copy JSON</button>' +
      '<button class="chat-msg-action" onclick="event.stopPropagation();copyTaskLogEntryText(\'' + jsq(key) + '\')">Copy Text</button>' +
      '<button class="chat-msg-action" onclick="event.stopPropagation();createTaskFromTaskLogEntry(\'' + jsq(key) + '\')">Create Task</button>' +
      '</div>';
  }

  function taskLogCounts() {
    var counts = { all: taskLogs.length, system: 0, text: 0, thinking: 0, tool_use: 0, tool_result: 0, error: 0, result: 0, tool: 0 };
    for (var i = 0; i < taskLogs.length; i++) {
      var type = taskLogType(taskLogs[i]);
      counts[type] = (counts[type] || 0) + 1;
      if (type === 'tool_use' || type === 'tool_result' || type === 'error') counts.tool += 1;
    }
    return counts;
  }

  function renderTaskLogToolbar() {
    var el = $('td-log-toolbar');
    if (!el) return;
    var counts = taskLogCounts();
    var visible = visibleTaskLogs().length;
    var types = [
      ['all', 'All'],
      ['thinking', 'Thinking'],
      ['tool', 'Tools'],
      ['tool_result', 'Results'],
      ['error', 'Errors'],
      ['text', 'Text'],
      ['system', 'System'],
    ];
    var html = '<div class="task-log-toolbar">';
    html += '<div class="task-log-chips">';
    for (var i = 0; i < types.length; i++) {
      var key = types[i][0];
      var label = types[i][1];
      html += '<button class="log-chip ' + (taskLogFilters.type === key ? 'active' : '') + '" onclick="setTaskLogType(\'' + key + '\')">' + esc(label) + ' <span>' + (counts[key] || 0) + '</span></button>';
    }
    html += '</div>';
    html += '<div class="task-log-tools">';
    html += '<input class="task-log-search" value="' + esc(taskLogFilters.query || '') + '" placeholder="Search logs" oninput="setTaskLogQuery(this.value)">';
    html += '<button class="mini-btn" onclick="exportVisibleTaskLogs()">Export</button>';
    html += '<span class="muted mono" id="task-log-visible-count">' + visible + '/' + counts.all + '</span>';
    html += '</div></div>';
    el.innerHTML = html;
  }

  function renderTaskLogEntries(append, preserveScroll) {
    var el = $('td-log-entries');
    if (!el) return;
    var scroll = $('td-log-scroll');
    var previousScrollTop = scroll ? scroll.scrollTop : 0;
    var nearBottom = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100 : true;
    var entries = visibleTaskLogs();
    el.innerHTML = '';
    if (entries.length === 0) {
      el.innerHTML = '<div class="empty compact">No log events match the current filter.</div>';
      return;
    }

    var frag = document.createDocumentFragment();
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var key = taskLogEntryKey(e, taskLogs.indexOf(e));
      var div = document.createElement('div');
      div.className = 'log-entry';
      div.dataset.logKey = key;
      if (selectedTaskLogKey === key) div.className += ' selected';

      switch (e.type) {
        case 'system':
          div.className += ' log-system';
          div.innerHTML = '<div class="log-entry-content">\u25cf ' + esc(e.content) + '</div>' + renderTaskLogEntryActions(key);
          break;
        case 'text':
          div.className += ' log-text';
          div.innerHTML = '<div class="log-entry-content">' + renderMd(e.content) + '</div>' + renderTaskLogEntryActions(key);
          break;
        case 'thinking':
          div.className += ' log-thinking';
          div.innerHTML = '<div class="log-entry-content"><span class="think-label">\u25b8 Thinking</span>' +
            '<div class="think-content">' + esc(e.content) + '</div></div>' + renderTaskLogEntryActions(key);
          div.onclick = function(event) {
            if (event && event.target && event.target.closest('button')) return;
            this.classList.toggle('expanded');
            var lbl = this.querySelector('.think-label');
            lbl.textContent = this.classList.contains('expanded') ? '\u25be Thinking' : '\u25b8 Thinking';
          };
          break;
        case 'tool_use':
          div.className += ' log-tool';
          var detail = e.meta && e.meta.input ? JSON.stringify(e.meta.input, null, 2) : '';
          div.innerHTML = '<div class="log-entry-content"><div class="tool-header">\u25b6 ' + esc(e.content) + '</div>' +
            (detail ? '<div class="tool-detail">' + esc(detail) + '</div>' : '') + '</div>' + renderTaskLogEntryActions(key);
          div.onclick = function(event) {
            if (event && event.target && event.target.closest('button')) return;
            this.classList.toggle('expanded');
          };
          break;
        case 'tool_result':
          div.className += ' log-tool-result' + (e.meta && e.meta.is_error ? ' error' : '');
          div.innerHTML = '<div class="log-entry-content">' + esc((e.meta && e.meta.is_error ? '\u2717 ' : '\u2713 ') + e.content) + '</div>' + renderTaskLogEntryActions(key);
          div.onclick = function(event) {
            if (event && event.target && event.target.closest('button')) return;
            this.classList.toggle('expanded');
          };
          break;
        case 'result':
          div.className += ' log-result';
          var parts = [e.content];
          if (e.meta) {
            if (e.meta.duration_ms) parts.push(fmtDur(e.meta.duration_ms));
            if (e.meta.cost_usd) parts.push(fmtCost(e.meta.cost_usd));
            if (e.meta.num_turns) parts.push(e.meta.num_turns + ' turns');
          }
          div.innerHTML = '<div class="log-entry-content">' + esc(parts.join(' \u00b7 ')) + '</div>' + renderTaskLogEntryActions(key);
          break;
        default:
          div.className += ' log-text';
          div.innerHTML = '<div class="log-entry-content">' + esc(e.content || '') + '</div>' + renderTaskLogEntryActions(key);
          break;
      }

      frag.appendChild(div);
    }
    el.appendChild(frag);

    // Auto-scroll to bottom if near bottom
    if (scroll) {
      if (preserveScroll) {
        scroll.scrollTop = previousScrollTop;
      } else if (nearBottom || !append) {
        scroll.scrollTop = scroll.scrollHeight;
      }
    }
    renderTaskLogDetailPanel();
  }

  window.setTaskLogType = function(type) {
    taskLogFilters.type = type || 'all';
    renderTaskLogToolbar();
    renderTaskLogEntries(false);
  };

  window.setTaskLogQuery = function(query) {
    taskLogFilters.query = query || '';
    renderTaskLogEntries(false);
    var count = $('task-log-visible-count');
    if (count) count.textContent = visibleTaskLogs().length + '/' + taskLogs.length;
  };

  window.showTaskLogEntryDetail = function(key) {
    selectedTaskLogKey = key || '';
    renderTaskLogEntries(false, true);
    renderTaskLogDetailPanel();
  };

  window.closeTaskLogEntryDetail = function() {
    selectedTaskLogKey = '';
    renderTaskLogEntries(false, true);
    renderTaskLogDetailPanel();
  };

  window.copyTaskLogEntryJson = function(key) {
    var entry = findTaskLogEntry(key);
    if (!entry) {
      showToast('Task log entry not found', false);
      return;
    }
    copyText(JSON.stringify(taskLogEntryJson(entry), null, 2));
  };

  window.copyTaskLogEntryText = function(key) {
    var entry = findTaskLogEntry(key);
    if (!entry) {
      showToast('Task log entry not found', false);
      return;
    }
    copyText(entry.content || '');
  };

  function renderTaskLogDetailPanel() {
    var el = $('td-log-detail');
    if (!el) return;
    if (!selectedTaskLogKey) {
      el.innerHTML = '';
      return;
    }
    var entry = findTaskLogEntry(selectedTaskLogKey);
    if (!entry) {
      el.innerHTML = '<div class="task-log-detail empty compact">Selected log entry is no longer available.</div>';
      return;
    }
    var entryJson = taskLogEntryJson(entry);
    var metaText = entry.meta ? JSON.stringify(entry.meta, null, 2) : '';
    var html = '<div class="task-log-detail">';
    html += '<div class="panel-title"><span>Log Entry Details</span><button class="mini-btn" onclick="closeTaskLogEntryDetail()">Close</button></div>';
    html += '<div class="task-log-detail-grid">';
    html += '<div><span>Line</span><strong>' + esc(entry.line == null ? '--' : String(entry.line)) + '</strong></div>';
    html += '<div><span>Type</span><strong>' + esc(taskLogType(entry)) + '</strong></div>';
    html += '<div><span>Raw</span><strong>' + esc(entry.type || '--') + '</strong></div>';
    html += '</div>';
    html += '<div class="panel-actions task-log-detail-actions">';
    html += '<button class="mini-btn" onclick="copyTaskLogEntryJson(\'' + jsq(selectedTaskLogKey) + '\')">Copy JSON</button>';
    html += '<button class="mini-btn" onclick="copyTaskLogEntryText(\'' + jsq(selectedTaskLogKey) + '\')">Copy Text</button>';
    html += '<button class="mini-btn" onclick="exportTaskLogEntry(\'' + jsq(selectedTaskLogKey) + '\')">Export Entry</button>';
    html += '<button class="mini-btn primary" onclick="createTaskFromTaskLogEntry(\'' + jsq(selectedTaskLogKey) + '\')">Create Task</button>';
    html += '</div>';
    html += '<div class="td-section-title">Content</div>';
    html += '<pre class="task-log-detail-content">' + esc(entry.content || '') + '</pre>';
    if (metaText) {
      html += '<div class="td-section-title">Metadata</div>';
      html += '<pre class="task-log-detail-content">' + esc(metaText) + '</pre>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  window.exportTaskLogEntry = function(key) {
    var entry = findTaskLogEntry(key);
    if (!entry) {
      showToast('Task log entry not found', false);
      return;
    }
    var safeTask = selectedTaskId ? String(selectedTaskId).replace(/[^a-z0-9._-]+/gi, '-') : 'task';
    var safeLine = entry.line == null ? 'entry' : 'line-' + String(entry.line).replace(/[^a-z0-9._-]+/gi, '-');
    downloadTextFile('persona-' + safeTask + '-' + safeLine + '-' + Date.now() + '.json', JSON.stringify(taskLogEntryJson(entry), null, 2));
    showToast('Task log entry exported', true);
  };

  window.createTaskFromTaskLogEntry = function(key) {
    var entry = findTaskLogEntry(key);
    var task = taskDetail || null;
    if (!entry || !task) {
      showToast('Task log entry is not loaded', false);
      return;
    }
    var payload = {
      exportedAt: new Date().toISOString(),
      type: 'taskLogEntry',
      entry: taskLogEntryJson(entry),
      taskHandoff: taskHandoffPayload(task),
    };
    taskDraft = {
      role: 'executor',
      agent: '',
      model: '',
      source_director: taskParentDirector(task) || task.source_director || 'main',
      project_dir: taskExtraValue(task, 'project_dir') || '',
      timeout_ms: '',
      max_retry: 3,
      description: 'Investigate task log: ' + shortText(entry.content || task.description || task.id || 'log entry', 80),
      prompt: taskLogEntryTaskPromptPayload(payload),
    };
    createTaskOpen = true;
    selectNav('tasks');
    showToast('Task log handoff loaded into create form', true);
  };

  window.exportVisibleTaskLogs = function() {
    var rows = visibleTaskLogs().map(function(e) {
      return JSON.stringify({
        line: e.line,
        type: taskLogType(e),
        raw_type: e.type,
        content: e.content,
        meta: e.meta || null,
      });
    });
    if (rows.length === 0) {
      showToast('No visible logs to export', false);
      return;
    }
    var safe = selectedTaskId ? String(selectedTaskId).replace(/[^a-z0-9._-]+/gi, '-') : 'task';
    downloadTextFile('persona-' + safe + '-logs-' + Date.now() + '.ndjson', rows.join('\n') + '\n');
    showToast('Visible task logs exported', true);
  };

  function startLogPolling(taskId) {
    stopLogPolling();
    taskLogPollTimer = setInterval(function() {
      if (viewMode !== 'task' || selectedTaskId !== taskId) {
        stopLogPolling();
        return;
      }
      loadTaskLogs(taskId, taskLogTotalLines);
      fetch('/api/tasks/' + taskId).then(function(r) { return r.json(); }).then(function(d) {
        if (!d || !taskDetail) return;
        var statusChanged = d.status !== taskDetail.status;
        taskDetail = d;
        if (statusChanged) {
          renderTaskResultPanel();
          if (d.status === 'completed' || d.status === 'failed') {
            stopLogPolling();
            if (d.result_file) {
              fetch('/api/tasks/' + taskId + '/output').then(function(r) {
                if (r.ok) return r.json();
                return null;
              }).then(function(o) {
                if (o && o.content) {
                  taskOutput = o.content;
                  renderTaskResultPanel();
                }
              }).catch(function() {});
            }
          }
        }
      }).catch(function() {});
    }, 2000);
  }

  function stopLogPolling() {
    if (taskLogPollTimer) {
      clearInterval(taskLogPollTimer);
      taskLogPollTimer = null;
    }
  }

  // ── Cron Jobs ──
  function loadCronJobs() {
    fetch('/api/cron-jobs').then(function(r) { return r.json(); }).then(function(d) {
      cronJobs = d || [];
      renderCronBadge();
      renderCronPanel();
      if (viewMode === 'automations') renderAutomationsView();
    }).catch(function() {});
  }

  window.refreshCronJobs = function() {
    loadCronJobs();
  };

  function renderCronBadge() {
    var badgeEl = $('cron-badge');
    if (!badgeEl) return;
    var enabled = 0;
    for (var i = 0; i < cronJobs.length; i++) {
      if (cronJobs[i].enabled) enabled++;
    }
    if (enabled > 0) {
      badgeEl.textContent = enabled;
      badgeEl.style.display = '';
    } else {
      badgeEl.style.display = 'none';
    }
  }

  function renderCronPanel() {
    var bodyEl = $('cron-panel-body');
    var countEl = $('cron-panel-count');
    if (!bodyEl) return;

    var enabled = 0;
    for (var i = 0; i < cronJobs.length; i++) {
      if (cronJobs[i].enabled) enabled++;
    }
    countEl.textContent = cronJobs.length > 0 ? enabled + '/' + cronJobs.length + ' active' : '';

    if (cronJobs.length === 0) {
      bodyEl.innerHTML = '<div class="empty">No cron jobs</div>';
      return;
    }

    var html = '';
    for (var j = 0; j < cronJobs.length; j++) {
      var c = cronJobs[j];
      var dotColor = c.enabled ? 'var(--green)' : 'var(--overlay0)';
      var isExpanded = expandedCronId === c.id;

      html += '<div class="cron-item" onclick="expandCronItem(\'' + esc(c.id) + '\')">';
      html += '<span class="cron-item-dot" style="background:' + dotColor + '"></span>';
      html += '<span class="cron-item-name">' + esc(c.name) + '</span>';
      html += '<span class="cron-item-schedule">' + esc(c.schedule) + '</span>';
      html += '<label class="cron-toggle" onclick="event.stopPropagation()">';
      html += '<input type="checkbox"' + (c.enabled ? ' checked' : '') + ' onchange="toggleCron(\'' + esc(c.id) + '\')">';
      html += '<span class="cron-toggle-track"></span>';
      html += '<span class="cron-toggle-thumb"></span>';
      html += '</label>';
      html += '</div>';

      if (isExpanded) {
        var lastRun = c.last_run_at ? fmtAgo(new Date(c.last_run_at).getTime()) : '--';
        var created = c.created_at || '--';
        html += '<div class="cron-item-detail">';
        html += '<div class="cron-detail-grid">';
        html += '<div><span class="cron-detail-label">Action</span><div class="cron-detail-value">' + esc(c.action_type || '--') + '</div></div>';
        html += '<div><span class="cron-detail-label">Role</span><div class="cron-detail-value">' + esc(c.role || '--') + '</div></div>';
        html += '<div><span class="cron-detail-label">Last Run</span><div class="cron-detail-value">' + esc(lastRun) + '</div></div>';
        html += '<div><span class="cron-detail-label">Created</span><div class="cron-detail-value">' + esc(created) + '</div></div>';
        html += '</div>';
        if (c.prompt) {
          html += '<div class="cron-detail-content">' + esc(c.prompt) + '</div>';
        }
        if (c.message) {
          html += '<div class="cron-detail-content">' + esc(c.message) + '</div>';
        }
        if (c.action_name) {
          html += renderShellActionRisk(c.action_name, true);
        }
        html += '<button class="cron-run-btn" onclick="event.stopPropagation();runCronNow(\'' + jsq(c.id) + '\',\'' + jsq(c.action_type || 'spawn_role') + '\',\'' + jsq(c.name || c.id) + '\')">Run Now</button>';
        html += '<button class="cron-delete-btn" onclick="event.stopPropagation();deleteCron(\'' + esc(c.id) + '\')">Delete</button>';
        html += '</div>';
      }
    }
    bodyEl.innerHTML = html;
  }

  window.toggleCronPanel = function() {
    var wrap = $('cron-wrap');
    cronPanelOpen = !cronPanelOpen;
    if (cronPanelOpen) {
      wrap.classList.add('open');
      // Close session dropdown if open
      var dd = $('session-dropdown');
      if (dd) dd.classList.remove('open');
    } else {
      wrap.classList.remove('open');
      expandedCronId = null;
      // Refresh data on close
      loadCronJobs();
    }
  };

  window.expandCronItem = function(cronId) {
    expandedCronId = expandedCronId === cronId ? null : cronId;
    renderCronPanel();
  };

  window.toggleCron = function(cronId) {
    var job = cronJobById(cronId);
    if (!job) {
      showToast('Cron job not found', false);
      loadCronJobs();
      return;
    }
    var nextState = job.enabled ? 'disable' : 'enable';
    var isShell = (job.action_type || 'spawn_role') === 'shell_action';
    queueDangerApproval({
      title: (job.enabled ? 'Disable' : 'Enable') + ' cron job',
      target: job.name || cronId,
      detail: nextState + ' ' + (job.action_type || 'spawn_role') + ' automation on schedule ' + (job.schedule || '--') + '.',
      severity: !job.enabled && isShell ? 'critical' : 'medium',
      payload: { cronId: cronId, nextState: nextState, job: job },
    }, async function() {
      try {
        var res = await fetch('/api/cron-jobs/' + encodeURIComponent(cronId) + '/toggle', { method: 'POST' });
        var body = await readJsonResponse(res);
        showToast(body.enabled ? 'Cron job enabled' : 'Cron job disabled', true);
        loadCronJobs();
        loadAuditLog();
      } catch (err) {
        showToast('Toggle failed: ' + err.message, false);
        throw err;
      }
    });
  };

  window.deleteCron = function(cronId) {
    var job = cronJobById(cronId);
    queueDangerApproval({
      title: 'Delete cron job',
      target: job && job.name || cronId,
      detail: 'The automation will be removed from the scheduler. Job id: ' + cronId,
      severity: 'critical',
      payload: { cronId: cronId, job: job || null },
    }, async function() {
      try {
        var r = await fetch('/api/cron-jobs/' + encodeURIComponent(cronId), { method: 'DELETE' });
        var d = await readJsonResponse(r);
        if (d.ok === false) throw new Error(d.error || 'Delete failed');
        showToast('Cron job deleted', true);
        expandedCronId = null;
        loadCronJobs();
        loadAuditLog();
      } catch (err) {
        showToast('Delete failed: ' + err.message, false);
        throw err;
      }
    });
  };

  // ── Elapsed timer ──
  setInterval(function () {
    if (!data || !data.activity) return;
    var act = data.activity;
    if (act.state === 'processing' && act.currentMessage) {
      var elapsed = (act.currentMessage.elapsedMs || 0) + (Date.now() - lastRecvAt);
      var el = $('act-elapsed');
      if (el) el.textContent = fmtDur(elapsed);
    }
  }, 1000);

  function runAutoRefreshTick() {
    if (wsConnected && expandedDirector) loadSessions(expandedDirector);
    // Skip cron refresh while panel is open to avoid content flicker
    if (wsConnected && !cronPanelOpen) loadCronJobs();
  }

  function scheduleAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    var seconds = Number(uiPreferences.refreshIntervalSec || 0);
    if (seconds > 0) {
      autoRefreshTimer = setInterval(runAutoRefreshTick, seconds * 1000);
    }
  }

  scheduleAutoRefresh();

  // ── Chat textarea auto-grow ──
  (function initChatAutoGrow() {
    var chatInput = $('chat-input');
    if (chatInput) {
      chatInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 130) + 'px';
      });
    }
  })();

  // ── Resize handles (drag to resize panels) ──
  (function initResizeHandles() {
    var activeHandle = null;
    var startX = 0;
    var startW = 0;
    var targetEl = null;
    var onDrag = null;

    // Sidebar resize
    var sidebarHandle = $('sidebar-resize');
    sidebarHandle.addEventListener('mousedown', function(e) {
      e.preventDefault();
      var sidebar = $('sidebar');
      startX = e.clientX;
      startW = sidebar.offsetWidth;
      targetEl = sidebar;
      activeHandle = sidebarHandle;
      activeHandle.classList.add('dragging');
      onDrag = function(dx) {
        var w = Math.max(180, Math.min(500, startW + dx));
        targetEl.style.width = w + 'px';
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    // Task split resize — delegated (element is dynamically created)
    document.addEventListener('mousedown', function(e) {
      if (e.target.id !== 'task-split-resize') return;
      e.preventDefault();
      var logPanel = e.target.previousElementSibling;
      var resultPanel = e.target.nextElementSibling;
      if (!logPanel || !resultPanel) return;
      var container = e.target.parentNode;
      var containerW = container.offsetWidth;
      startX = e.clientX;
      startW = logPanel.offsetWidth;
      activeHandle = e.target;
      activeHandle.classList.add('dragging');
      onDrag = function(dx) {
        var newLogW = Math.max(200, Math.min(containerW - 205, startW + dx));
        logPanel.style.flex = 'none';
        logPanel.style.width = newLogW + 'px';
        resultPanel.style.flex = '1';
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', function(e) {
      if (!activeHandle) return;
      onDrag(e.clientX - startX);
    });

    document.addEventListener('mouseup', function() {
      if (!activeHandle) return;
      activeHandle.classList.remove('dragging');
      activeHandle = null;
      onDrag = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  })();

  // ── Boot ──
  connect();
  // Workbench is chat-first.
  selectSession(null);

})();

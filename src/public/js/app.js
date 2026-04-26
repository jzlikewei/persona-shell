(function () {
  'use strict';

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
    var d = Date.now() - ts;
    if (d < 0) d = 0;
    if (d < 5000) return 'just now';
    if (d < 60000) return Math.floor(d / 1000) + 's ago';
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    return Math.floor(d / 86400000) + 'd ago';
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
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderMd(text) {
    var html;
    if (typeof marked !== 'undefined' && marked.parse) {
      try { html = marked.parse(text); } catch(e) { /* fallback */ }
    }
    if (!html) html = '<pre>' + esc(text) + '</pre>';
    // Sanitize to prevent XSS from untrusted message content
    if (typeof DOMPurify !== 'undefined') {
      return DOMPurify.sanitize(html);
    }
    return html;
  }

  // ── State ──
  var data = null;
  var lastRecvAt = 0;
  var wsConnected = false;
  var ws = null;

  // ── State/TODO panel ──
  var statePanelOpen = false;
  var stateData = { state: '', todo: '' };
  var stateActiveTab = 'state';

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
        renderStatePanel();
      })
      .catch(function() {
        body.innerHTML = '<div class="empty">Failed to load</div>';
      });
  };

  function renderStatePanel() {
    var body = document.getElementById('state-panel-body');
    var raw = stateActiveTab === 'state' ? stateData.state : stateData.todo;
    if (!raw) {
      body.innerHTML = '<div class="empty">Empty</div>';
      return;
    }
    body.innerHTML = md(raw);
  }

  // View state
  var viewMode = 'dashboard'; // 'dashboard' | 'session' | 'task' | 'pool-session'
  var selectedSessionId = null;
  var selectedTaskId = null;
  var selectedPoolLabel = null; // for pool-session view
  var sessionMessages = null; // cached messages for selected session
  var sessions = []; // cached session list for current expanded director
  var expandedDirector = null; // 'main' or pool label — which director's sub-sessions are shown
  var taskDetail = null; // cached task detail
  var taskOutput = null; // cached task output
  var taskLogs = [];
  var taskLogTotalLines = 0;
  var taskLogPollTimer = null;

  // Cron state
  var cronJobs = [];
  var cronPanelOpen = false;
  var expandedCronId = null;

  // Streaming state
  var streamingChunks = {}; // director label → accumulated text
  var prevActivityState = 'idle'; // for detecting processing→idle transition
  var prevPoolActivityStates = {}; // label → previous activity state
  var streamRenderTimer = null; // debounce markdown rendering

  var $ = function (id) { return document.getElementById(id); };

  // ── Chat management ──

  /** Send message from the chat input bar */
  window.doChatSend = function() {
    var input = $('chat-input');
    var text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';

    if (!ws || !wsConnected) {
      showToast('Not connected', false);
      return;
    }

    // Send via WebSocket chat message (goes through MessagingRouter)
    var messageId = 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    ws.send(JSON.stringify({ type: 'chat', text: text, messageId: messageId, director: selectedPoolLabel || null }));

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

  /** Create a new web chat session */
  window.doNewWebChat = function() {
    fetch('/api/web-sessions', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ok) {
          showToast('New chat created', true);
          selectPoolDirector(d.label, 'Web Chat');
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
    if (!confirm('Close this web chat session?')) return;
    fetch('/api/web-sessions/' + encodeURIComponent(routingKey), { method: 'DELETE' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ok) {
          showToast('Chat closed', true);
          if (viewMode === 'pool-session') {
            selectDashboard();
          }
        } else {
          showToast(d.error || 'Failed to close', false);
        }
      })
      .catch(function(err) {
        showToast('Failed: ' + err.message, false);
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

  function connect() {
    ws = new WebSocket(getWsUrl());
    ws.onopen = function () {
      wsConnected = true;
      $('overlay').classList.add('hidden');
      // Load sessions on connect
      loadSessions(expandedDirector);
      loadCronJobs();
    };
    ws.onclose = function () {
      wsConnected = false;
      $('overlay').classList.remove('hidden');
      setTimeout(connect, 2000);
    };
    ws.onerror = function () {};
    ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
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
          if (viewMode === 'dashboard') renderDashboard();
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
        }
      } catch (e) { /* ignore */ }
    };
  }

  // ── Data loading ──
  function loadSessions(directorLabel) {
    var url = '/api/sessions';
    if (directorLabel && directorLabel !== 'main') url += '?director=' + encodeURIComponent(directorLabel);
    fetch(url).then(function(r) { return r.json(); }).then(function(d) {
      sessions = d || [];
      renderSessionList();
      renderSessionTabs();
    }).catch(function() {});
  }

  function loadSessionMessages(sessionId) {
    var url = '/api/messages?limit=200';
    if (sessionId) url += '&sessionId=' + encodeURIComponent(sessionId);
    fetch(url).then(function(r) { return r.json(); }).then(function(d) {
      sessionMessages = d || [];
      renderSessionView();
    }).catch(function() {
      sessionMessages = [];
      renderSessionView();
    });
  }

  function loadAllMessages() {
    fetch('/api/messages?limit=200').then(function(r) { return r.json(); }).then(function(d) {
      sessionMessages = d || [];
      renderSessionView();
    }).catch(function() {
      sessionMessages = [];
      renderSessionView();
    });
  }

  // ── Pool session loading ──
  function loadPoolMessages(label) {
    fetch('/api/messages?limit=200&director=' + encodeURIComponent(label))
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
    selectedPoolLabel = label;
    selectedSessionId = null;
    var shortName = (groupName || label).slice(0, 8);
    $('dh-title').textContent = shortName + ' (Director)';
    $('dh-sub').textContent = '';
    $('detail-content').classList.remove('task-split-mode');
    showChat();
    // Load sub-sessions for tabs
    if (expandedDirector !== label) {
      expandedDirector = label;
      loadSessions(label);
    } else {
      renderSessionList();
      renderSessionTabs();
    }
    loadPoolMessages(label);
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
      fetch('/api/messages?limit=200&director=' + encodeURIComponent(directorLabel) + (sessionId ? '&sessionId=' + encodeURIComponent(sessionId) : ''))
        .then(function(r) { return r.json(); })
        .then(function(d) { sessionMessages = d || []; renderSessionView(); })
        .catch(function() { sessionMessages = []; renderSessionView(); });
    }
  };

  // ── Streaming helpers ──
  function clearStreaming(label) {
    delete streamingChunks[label];
    var bubble = document.getElementById('streaming-bubble-' + label);
    if (bubble) bubble.remove();
    // Reload messages to get the final response
    if (viewMode === 'session' || viewMode === 'pool-session') {
      if (viewMode === 'pool-session' && selectedPoolLabel === label) {
        loadPoolMessages(label);
      } else if (viewMode === 'session') {
        if (selectedSessionId) loadSessionMessages(selectedSessionId);
        else loadAllMessages();
      }
    }
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
    if (msgs[cmd] && !confirm(msgs[cmd])) return;
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

  // ── View switching ──
  window.selectSession = function (sessionId) {
    stopLogPolling();
    viewMode = 'session';
    selectedSessionId = sessionId;
    selectedPoolLabel = null;
    selectedTaskId = null;
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
    $('dh-title').innerHTML = '<span style="cursor:pointer;color:var(--blue);margin-right:8px" onclick="selectDashboard()">\u2190</span>Task';
    $('dh-sub').textContent = taskId;
    loadTaskDetail(taskId);
  };

  window.selectDashboard = function () {
    stopLogPolling();
    viewMode = 'dashboard';
    selectedSessionId = null;
    selectedTaskId = null;
    $('detail-content').classList.remove('task-split-mode');
    hideChat();
    $('session-dropdown').style.display = 'none';
    renderSessionList();
    renderTaskList();
    $('dh-title').textContent = 'Dashboard';
    $('dh-sub').textContent = '';
    renderDashboard();
  };

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
            percent: (pc.live !== false && pcLimit > 0 && pc.tokens != null) ? Math.round((pc.tokens / pcLimit) * 100) : 0,
            live: pc.live !== false,
            lastFlushAgoMs: pc.lastFlushAt ? (now - pc.lastFlushAt) : null,
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

    var mainIsActive = viewMode === 'session';
    var html = '<div class="list-item' + (mainIsActive ? ' active' : '') + '" onclick="selectSession(null)" style="cursor:pointer">' +
      '<span class="item-icon" style="color:' + mainColor + '">&#9679;</span>' +
      '<span class="item-label">Main (Director)</span>' +
      '<span class="item-meta">' + mainStatus + '</span></div>';

    // Pool Director entries (active first, then closed)
    var activePool = [];
    var closedPool = [];
    for (var i = 0; i < poolData.length; i++) {
      if (poolData[i].closed) closedPool.push(poolData[i]);
      else activePool.push(poolData[i]);
    }
    var sortedPool = activePool.concat(closedPool);

    for (var i = 0; i < sortedPool.length; i++) {
      var p = sortedPool[i];
      var isActive = viewMode === 'pool-session' && selectedPoolLabel === p.label;
      var status, dotColor, badgeHtml = '';
      if (p.closed) { status = 'sleep'; dotColor = 'var(--overlay0)'; }
      else if (!p.alive) { status = 'dead'; dotColor = 'var(--red)'; }
      else if (p.activity === 'processing') { status = 'busy'; dotColor = 'var(--green)'; }
      else if (p.activity === 'flushing') { status = 'flush'; dotColor = 'var(--yellow)'; }
      else { status = 'live'; dotColor = 'var(--green)'; }
      if (p.queueLength > 0) badgeHtml = ' <span class="badge running" style="font-size:8px;padding:0 4px;margin-left:2px">' + p.queueLength + '</span>';
      var shortName = (p.groupName || p.label).slice(0, 8);
      var isWebSession = p.routingKey && p.routingKey.startsWith('web-');
      var closeBtn = (isWebSession && !p.closed) ? '<span class="item-close" onclick="event.stopPropagation();doCloseWebChat(\'' + esc(p.routingKey) + '\')" title="Close">&times;</span>' : '';
      html += '<div class="list-item' + (isActive ? ' active' : '') + '" onclick="selectPoolDirector(\'' + esc(p.label) + '\',\'' + esc(p.groupName) + '\')" style="cursor:pointer">' +
        '<span class="item-icon" style="color:' + dotColor + '">&#9679;</span>' +
        '<span class="item-label">' + esc(shortName) + ' (Director)' + badgeHtml + '</span>' +
        closeBtn +
        '<span class="item-meta">' + status + '</span></div>';
    }

    // [BUG2 FIX] Explicit string concatenation instead of implicit type coercion
    var activeCount = 1 + activePool.length;
    var totalText = String(activeCount);
    if (closedPool.length > 0) totalText += ' +' + closedPool.length;
    countEl.textContent = '(' + totalText + ')';
    el.innerHTML = html;
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
  function renderDashboard() {
    if (!data) return;
    var met = data.metrics || {};
    var today = met.today || {};
    var msgs = met.recentMessages || [];
    var errs = met.recentErrors || [];
    var queue = data.queue || [];

    var html = '';

    // Stats cards
    html += '<div class="dash-grid">';
    html += '<div class="dash-card"><div class="dash-card-title">Messages Processed</div><div class="stat-big">' +
      (today.messagesProcessed || 0) + '</div><div class="stat-sub">today</div></div>';
    html += '<div class="dash-card"><div class="dash-card-title">Avg Response</div><div class="stat-big">' +
      (today.avgResponseSec != null ? today.avgResponseSec.toFixed(1) + 's' : '0s') + '</div><div class="stat-sub">today</div></div>';
    html += '<div class="dash-card"><div class="dash-card-title">Cost</div><div class="stat-big">' +
      fmtCost(today.totalCostUsd) + '</div><div class="stat-sub">today</div></div>';
    html += '</div>';

    // Queue
    if (queue.length > 0) {
      html += '<div style="margin-bottom:16px"><div class="dash-card-title">Queue (' + queue.length + ')</div>';
      for (var q = 0; q < queue.length; q++) {
        var qi = queue[q];
        html += '<div class="queue-item' + (qi.cancelled ? ' cancelled' : '') + '">' +
          '<span class="queue-text">' + esc(qi.preview) + '</span>' +
          '<span class="queue-time">' + fmtAgo(qi.timestamp) + '</span></div>';
      }
      html += '</div>';
    }

    // Recent messages
    html += '<div style="margin-bottom:16px"><div class="dash-card-title">Recent Messages</div>';
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

    // Errors
    if (errs.length > 0) {
      html += '<div class="err-section"><div class="dash-card-title" style="color:var(--red)">Errors</div>';
      for (var k = 0; k < errs.length; k++) {
        var e = errs[k];
        html += '<div class="err-row"><span class="err-icon">&#9888;</span>' +
          '<span class="err-text">' + esc(e.message) + '</span>' +
          '<span class="err-time">' + fmtAgo(e.timestamp) + '</span></div>';
      }
      html += '</div>';
    }

    $('detail-content').innerHTML = html;
  }

  // ── Render: Session (chat) View ──
  function renderSessionView() {
    var el = $('chat-messages');
    if (!el) return;

    if (!sessionMessages || sessionMessages.length === 0) {
      el.innerHTML = '<div class="empty" style="padding:40px">No messages found</div>';
      $('chat-input-bar').classList.remove('visible');
      return;
    }

    // Messages come most-recent-first from API, reverse for chronological display
    var msgs = sessionMessages.slice().reverse();
    var html = '';

    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var isIn = m.direction === 'in';
      html += '<div class="chat-msg ' + (isIn ? 'in' : 'out') + '">';
      html += '<div class="chat-msg-header">';
      html += '<span class="chat-msg-role ' + (isIn ? 'user' : 'bot') + '">' + (isIn ? 'User' : 'Director') + '</span>';
      html += '</div>';
      html += '<div class="chat-msg-body">';
      if (isIn) {
        html += esc(m.content);
      } else {
        html += '<div class="md-content">' + renderMd(m.content) + '</div>';
      }
      html += '</div></div>';
    }

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
    if (isProcessing && !hasStreamingChunks) {
      html += '<div class="chat-processing"><div class="running-dot"></div><span>Processing...</span></div>';
    }

    el.innerHTML = html;

    // Scroll to bottom
    var scroll = $('chat-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;

    // Show/hide input bar based on live session
    var inputBar = $('chat-input-bar');
    if (isLiveSession || viewMode === 'pool-session') {
      inputBar.classList.add('visible');
      setTimeout(function() { $('chat-input').focus(); }, 0);
    } else {
      inputBar.classList.remove('visible');
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
    html += '<div class="td-log-scroll" id="td-log-scroll"><div id="td-log-entries"></div></div>';
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

    html += '<div class="td-meta" style="margin-bottom:12px">';
    html += '<div class="td-field"><div class="td-field-label">Task ID</div><div class="td-field-value">' + esc(t.id) + '</div></div>';
    html += '<div class="td-field"><div class="td-field-label">Role</div><div class="td-field-value">' + esc(t.role || '--') + '</div></div>';
    html += '<div class="td-field"><div class="td-field-label">Created</div><div class="td-field-value">' + esc(t.created_at || '--') + '</div></div>';
    if (t.duration_ms != null) {
      html += '<div class="td-field"><div class="td-field-label">Duration</div><div class="td-field-value">' + fmtDur(t.duration_ms) + '</div></div>';
    }
    if (t.cost_usd != null) {
      html += '<div class="td-field"><div class="td-field-label">Cost</div><div class="td-field-value">' + fmtCost(t.cost_usd) + '</div></div>';
    }
    html += '</div>';

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

    // Spawn args section (collapsible)
    var spawnArgs = t.extra && t.extra.spawnArgs;
    if (spawnArgs && spawnArgs.length > 0) {
      html += '<div class="td-section">';
      html += '<div class="td-section-title" style="cursor:pointer" onclick="var s=this.parentNode;s.classList.toggle(\'expanded\');this.textContent=s.classList.contains(\'expanded\')?\'\u25be Spawn Args (' + spawnArgs.length + ')\':\'\u25b8 Spawn Args (' + spawnArgs.length + ')\'">' +
        '\u25b8 Spawn Args (' + spawnArgs.length + ')</div>';
      html += '<div class="td-prompt" style="display:none;font-size:11px">' + esc(spawnArgs.join(' \\\n  ')) + '</div>';
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

  function loadTaskLogs(taskId, after) {
    var url = '/api/tasks/' + taskId + '/logs';
    if (after > 0) url += '?after=' + after;
    fetch(url).then(function(r) { return r.json(); }).then(function(d) {
      if (!d) return;
      if (d.entries && d.entries.length > 0) {
        taskLogs = taskLogs.concat(d.entries);
        taskLogTotalLines = d.totalLines;
        renderLogEntries(d.entries, after > 0);
      } else if (d.totalLines != null) {
        taskLogTotalLines = d.totalLines;
      }
    }).catch(function() {});
  }

  function renderLogEntries(entries, append) {
    var el = $('td-log-entries');
    if (!el) return;

    if (!append) el.innerHTML = '';

    var frag = document.createDocumentFragment();
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var div = document.createElement('div');
      div.className = 'log-entry';

      switch (e.type) {
        case 'system':
          div.className += ' log-system';
          div.textContent = '\u25cf ' + e.content;
          break;
        case 'text':
          div.className += ' log-text';
          div.innerHTML = renderMd(e.content);
          break;
        case 'thinking':
          div.className += ' log-thinking';
          div.innerHTML = '<span class="think-label">\u25b8 Thinking</span>' +
            '<div class="think-content">' + esc(e.content) + '</div>';
          div.onclick = function() {
            this.classList.toggle('expanded');
            var lbl = this.querySelector('.think-label');
            lbl.textContent = this.classList.contains('expanded') ? '\u25be Thinking' : '\u25b8 Thinking';
          };
          break;
        case 'tool_use':
          div.className += ' log-tool';
          var detail = e.meta && e.meta.input ? JSON.stringify(e.meta.input, null, 2) : '';
          div.innerHTML = '<div class="tool-header">\u25b6 ' + esc(e.content) + '</div>' +
            (detail ? '<div class="tool-detail">' + esc(detail) + '</div>' : '');
          div.onclick = function() { this.classList.toggle('expanded'); };
          break;
        case 'tool_result':
          div.className += ' log-tool-result' + (e.meta && e.meta.is_error ? ' error' : '');
          div.textContent = (e.meta && e.meta.is_error ? '\u2717 ' : '\u2713 ') + e.content;
          div.onclick = function() { this.classList.toggle('expanded'); };
          break;
        case 'result':
          div.className += ' log-result';
          var parts = [e.content];
          if (e.meta) {
            if (e.meta.duration_ms) parts.push(fmtDur(e.meta.duration_ms));
            if (e.meta.cost_usd) parts.push(fmtCost(e.meta.cost_usd));
            if (e.meta.num_turns) parts.push(e.meta.num_turns + ' turns');
          }
          div.textContent = parts.join(' \u00b7 ');
          break;
      }

      frag.appendChild(div);
    }
    el.appendChild(frag);

    // Auto-scroll to bottom if near bottom
    var scroll = $('td-log-scroll');
    if (scroll) {
      var nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
      if (nearBottom || !append) {
        scroll.scrollTop = scroll.scrollHeight;
      }
    }
  }

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
    }).catch(function() {});
  }

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
          html += '<div class="cron-detail-content">' + esc(c.action_name) + '</div>';
        }
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
    fetch('/api/cron-jobs/' + cronId + '/toggle', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        showToast(d.enabled ? 'Cron job enabled' : 'Cron job disabled', true);
        loadCronJobs();
      })
      .catch(function(err) {
        showToast('Toggle failed: ' + err.message, false);
      });
  };

  window.deleteCron = function(cronId) {
    if (!confirm('Delete this cron job?')) return;
    fetch('/api/cron-jobs/' + cronId, { method: 'DELETE' })
      .then(function(r) {
        if (r.ok) {
          showToast('Cron job deleted', true);
          expandedCronId = null;
          loadCronJobs();
        } else {
          return r.json().then(function(d) { throw new Error(d.error || 'Delete failed'); });
        }
      })
      .catch(function(err) {
        showToast('Delete failed: ' + err.message, false);
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

  // [BUG1 FIX] Refresh sessions for the currently expanded director, not always main
  setInterval(function () {
    if (wsConnected && expandedDirector) loadSessions(expandedDirector);
    // Skip cron refresh while panel is open to avoid content flicker
    if (wsConnected && !cronPanelOpen) loadCronJobs();
  }, 30000);

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
  // Show dashboard on load
  selectDashboard();

})();

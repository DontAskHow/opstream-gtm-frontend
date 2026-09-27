// Opstream GTM agent — AI assistant panel with agentic workspace actions.
// Inlined by build.cjs after demo-mode.js. Browser only.
(function () {
  'use strict';

  // Capture the live Component instance so actions can use the app's own
  // methods (_newWorkspaceDraft, _saveWorkspaceDraft, go, _verifiedAccount).
  // Chains after the other adapters (showcase, collaboration, demo).
  var prevMount = Component.prototype.componentDidMount;
  Component.prototype.componentDidMount = function () {
    try { window.__gtmAgentHost = this; } catch (e) {}
    return prevMount.apply(this, arguments);
  };

  var SUGGESTIONS = [
    'What should Hollie do first today?',
    'What changed since the last brief?',
    'Draft a follow-up email for my stalest deal',
    'Prep me for my next meeting'
  ];

  var CSS = [
    '#gtm-agent-fab{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:8px;',
    'font:600 14px var(--font-body,system-ui,sans-serif);color:#fff;background:var(--color-accent,#0f766e);',
    'border:0;border-radius:999px;padding:12px 18px;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.22)}',
    '#gtm-agent-fab:hover{filter:brightness(1.08)}',
    '#gtm-agent-panel{position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);z-index:2147483001;display:none;',
    'flex-direction:column;background:var(--color-bg,#fff);color:var(--color-text,#111);',
    'border-left:1px solid var(--color-divider,#e5e5e5);box-shadow:-12px 0 40px rgba(0,0,0,.14);',
    'font:400 14px/1.55 var(--font-body,system-ui,sans-serif)}',
    '#gtm-agent-panel.open{display:flex}',
    '#gtm-agent-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:2px solid var(--color-divider,#e5e5e5)}',
    '#gtm-agent-head h2{font:800 16px var(--font-heading,var(--font-body,system-ui));margin:0;flex:1}',
    '#gtm-agent-head p{margin:2px 0 0;font-size:12px;color:var(--color-neutral-700,#555)}',
    '#gtm-agent-close{background:none;border:0;font-size:20px;cursor:pointer;color:inherit;padding:4px 8px}',
    '#gtm-agent-msgs{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px}',
    '.gtm-msg{max-width:100%;padding:10px 14px;border-radius:10px;overflow-wrap:anywhere}',
    '.gtm-msg.user{align-self:flex-end;background:var(--color-accent-100,#e6f4f1);color:var(--color-accent-900,#0b3b36)}',
    '.gtm-msg.ai{align-self:flex-start;background:var(--color-surface,#f4f4f2);width:100%;box-sizing:border-box}',
    '.gtm-msg.ai p{margin:0 0 8px}.gtm-msg.ai p:last-child{margin-bottom:0}',
    '.gtm-msg.ai ul{margin:4px 0 8px;padding-left:20px}.gtm-msg.ai li{margin-bottom:4px}',
    '.gtm-msg.ai ol{margin:4px 0 8px;padding-left:20px}.gtm-msg.ai ol li{margin-bottom:4px}',
    '.gtm-msg.ai code{font-family:ui-monospace,monospace;font-size:12.5px;background:rgba(0,0,0,.06);padding:1px 5px;border-radius:4px}',
    '.gtm-msg.note{align-self:center;font-size:12px;color:var(--color-neutral-700,#555);background:none;padding:4px}',
    '.gtm-typing{color:var(--color-neutral-700,#555);font-style:italic}',
    '#gtm-agent-sugg{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 8px}',
    '#gtm-agent-sugg button{font:inherit;font-size:12px;background:var(--color-surface,#f4f4f2);border:1px solid var(--color-divider,#e5e5e5);',
    'border-radius:999px;padding:6px 12px;cursor:pointer;color:inherit}',
    '#gtm-agent-sugg button:hover{border-color:var(--color-accent,#0f766e)}',
    '#gtm-agent-form{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--color-divider,#e5e5e5)}',
    '#gtm-agent-input{flex:1;font:inherit;font-size:14px;padding:10px 12px;border:1px solid var(--color-divider,#e5e5e5);border-radius:8px;background:var(--color-bg,#fff);color:inherit}',
    '#gtm-agent-send{font:600 14px inherit;background:var(--color-accent,#0f766e);color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer}',
    '#gtm-agent-send:disabled{opacity:.55;cursor:default}',
    '@media(max-width:480px){#gtm-agent-fab{right:12px;bottom:88px}}'
  ].join('\n');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Fallback markdown renderer. The server is supposed to return an HTML
  // fragment, but if raw markdown ever reaches the client (older server,
  // model ignoring instructions), render it instead of showing asterisks.
  function mdInline(s) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1<em>$2</em>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  }
  function mdToHtml(src) {
    var lines = esc(src).split('\n');
    var out = [], list = null, para = [];
    function closeList() { if (list) { out.push('</' + list + '>'); list = null; } }
    function flushPara() { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } }
    lines.forEach(function (line) {
      var t = line.replace(/^\s+|\s+$/g, ''), m;
      if (!t) { closeList(); flushPara(); return; }
      if ((m = t.match(/^[-*\u2022]\s+(.*)$/))) { flushPara(); if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + mdInline(m[1]) + '</li>'); return; }
      if ((m = t.match(/^\d+[.)]\s+(.*)$/))) { flushPara(); if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + mdInline(m[1]) + '</li>'); return; }
      if ((m = t.match(/^#{1,6}\s+(.*)$/))) { closeList(); flushPara(); out.push('<p><strong>' + mdInline(m[1]) + '</strong></p>'); return; }
      para.push(mdInline(t));
    });
    closeList(); flushPara();
    return out.join('\n') || '<p></p>';
  }
  function renderAnswer(raw) {
    var s = String(raw == null ? '' : raw);
    if (!s) return '<p>I could not produce an answer.</p>';
    if (/<\s*(p|ul|ol|li|strong|em|br|code|table|h[1-6])(\s|>|\/)/i.test(s)) return s;
    return mdToHtml(s);
  }

  var host = null, panel = null, msgsEl = null, suggEl = null, form = null, input = null, sendBtn = null, fab = null;
  var history = [];
  var busy = false;

  function ensureUI() {
    if (panel) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    fab = document.createElement('button');
    fab.id = 'gtm-agent-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Ask the GTM AI assistant');
    fab.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m9.6 9.6 2.1 2.1m0-13.8-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg><span>Ask AI</span>';
    fab.addEventListener('click', toggle);
    document.body.appendChild(fab);

    panel = document.createElement('aside');
    panel.id = 'gtm-agent-panel';
    panel.setAttribute('aria-label', 'GTM AI assistant');
    panel.innerHTML =
      '<div id="gtm-agent-head"><div style="flex:1"><h2>GTM Assistant</h2>' +
      '<p>Grounded in live workspace data. Drafts follow-ups, preps meetings, proposes CRM updates — never sends, never changes your CRM.</p></div>' +
      '<button id="gtm-agent-close" aria-label="Close assistant">&times;</button></div>' +
      '<div id="gtm-agent-msgs" role="log" aria-live="polite"></div>' +
      '<div id="gtm-agent-sugg"></div>' +
      '<form id="gtm-agent-form"><input id="gtm-agent-input" type="text" autocomplete="off" ' +
      'placeholder="Ask about accounts, pipeline, meetings&hellip;" aria-label="Ask the assistant">' +
      '<button id="gtm-agent-send" type="submit">Send</button></form>';
    document.body.appendChild(panel);

    msgsEl = panel.querySelector('#gtm-agent-msgs');
    suggEl = panel.querySelector('#gtm-agent-sugg');
    form = panel.querySelector('#gtm-agent-form');
    input = panel.querySelector('#gtm-agent-input');
    sendBtn = panel.querySelector('#gtm-agent-send');
    panel.querySelector('#gtm-agent-close').addEventListener('click', toggle);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = input.value.trim();
      if (q && !busy) { input.value = ''; ask(q); }
    });

    SUGGESTIONS.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = s;
      b.addEventListener('click', function () { if (!busy) ask(s); });
      suggEl.appendChild(b);
    });

    addMsg('ai', '<p>Hi — I can see your accounts, pipeline, meetings and drafts. Ask me anything, or try a suggestion below.</p>');
  }

  function toggle() {
    ensureUI();
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) input.focus();
  }

  function addMsg(kind, html) {
    ensureUI();
    var d = document.createElement('div');
    d.className = 'gtm-msg ' + kind;
    if (kind === 'user') d.textContent = html;
    else d.innerHTML = html;
    msgsEl.appendChild(d);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return d;
  }

  function note(text) { addMsg('note', esc(text)); }

  function workspaceReady() {
    host = window.__gtmAgentHost;
    return !!(host && host.state && host.state.verified && host.state.workspaceReady);
  }

  async function ask(question) {
    ensureUI();
    if (!panel.classList.contains('open')) panel.classList.add('open');
    addMsg('user', question);
    var typing = addMsg('ai', '<span class="gtm-typing">Thinking&hellip;</span>');
    busy = true; sendBtn.disabled = true;
    try {
      if (!workspaceReady()) {
        // Give the app a moment to finish loading its data.
        var waited = 0;
        while (!workspaceReady() && waited < 8000) {
          await new Promise(function (r) { setTimeout(r, 400); });
          waited += 400;
        }
      }
      var res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: question, history: history.slice(-8) })
      });
      var data;
      try { data = await res.json(); }
      catch (e) { throw new Error('The assistant could not be reached.'); }
      if (!res.ok) throw new Error(data.error || 'The assistant request failed.');
      history.push({ role: 'user', content: question });
      history.push({ role: 'assistant', content: data.answerText || '' });
      typing.innerHTML = renderAnswer(data.answer);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      var actions = data.actions || [];
      for (var i = 0; i < actions.length; i++) {
        try { await runAction(actions[i]); }
        catch (e) { note('Action failed: ' + (e.message || e)); }
      }
    } catch (e) {
      typing.innerHTML = '<p>' + esc(e.message || 'Something went wrong.') + '</p>';
    } finally {
      busy = false; sendBtn.disabled = false;
    }
  }

  async function runAction(a) {
    host = window.__gtmAgentHost;
    if (!host) { note('Workspace is not ready yet — action skipped.'); return; }
    if (a.type === 'create_draft') {
      if (!host.state.workspaceReady) throw new Error('Workspace is still loading.');
      var account = null;
      try { account = host._verifiedAccount ? host._verifiedAccount(a.company || '') : null; } catch (e) {}
      var contactEmail = account && account.contacts && account.contacts[0] ? account.contacts[0].email : '';
      var draft = host._newWorkspaceDraft('email', {
        title: a.title || ((account && account.name ? account.name : (a.company || 'Follow-up')) + ' — follow-up'),
        subject: a.subject || '',
        text: a.text || '',
        recipients: a.recipients || contactEmail || '',
        cc: a.cc || '',
        threadId: a.threadId || '',
        inReplyTo: a.inReplyTo || '',
        references: a.references || '',
        company: (account && account.name) || a.company || 'No company linked',
        accountIds: account ? ['company:' + account.id] : [],
        rationale: 'Drafted by the GTM assistant.'
      });
      await host._saveWorkspaceDraft(draft);
      note('Created draft "' + draft.title + '" — opened in Drafts.');
    } else if (a.type === 'propose_crm_update') {
      if (a.ok) note('Proposal queued: ' + (a.company || '') + ' — ' + (a.field || '') + ' → ' + (a.proposedValue || '') + '. Nothing was written to HubSpot; Hollie reviews it in the workspace.');
      else note('Could not save the CRM proposal.');
    } else if (a.type === 'mark_queue_item') {
      if (a.ok && host.hollieFeedback) {
        try { host.hollieFeedback(a.itemId, a.action); note('Marked ' + a.action + ' — removed from the queue.'); }
        catch (e) { note('Saved, but the queue view did not update — refresh to see it.'); }
      } else if (a.ok) {
        note('Marked ' + a.action + ' — it will drop off the queue on next refresh.');
      } else {
        note('Could not update that queue item.');
      }
    } else if (a.type === 'navigate') {
      var view = a.view || 'today';
      var params = a.params || {};
      if (view === 'account' && a.account && !params.accountId) {
        var c = null;
        try { c = host._verifiedAccount(a.account); } catch (e) {}
        if (c) params.accountId = c.id;
      }
      if (view === 'meeting' && a.meeting && !params.meetingId) params.meetingId = a.meeting;
      host.go(view, params)();
      note('Opened ' + view + '.');
    } else {
      note('Unknown action: ' + a.type);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureUI);
  } else {
    ensureUI();
  }
})();

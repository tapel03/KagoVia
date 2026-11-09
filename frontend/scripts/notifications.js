/* Notifications page: tabs filter the list, pages move 8 at a time, counts stay in sync.
   Demo data for now; replace NOTIFS with the API response when the backend is wired in. */
(function () {
  'use strict';

  var PAGE_SIZE = 8;

  var ICONS = {
    update: "<svg class='ico-inline' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'/></svg>",
    mention: "<svg class='ico-inline' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719'/></svg>",
    alert: "<svg class='ico-inline' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'/><path d='M12 9v4'/><path d='M12 17h.01'/></svg>",
    system: "<svg class='ico-inline' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M10.268 21a2 2 0 0 0 3.464 0'/><path d='M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326'/></svg>"
  };
  var COLOUR = { update: 'blue', mention: 'purple', alert: 'orange', system: 'gray' };
  var TYPE_LABEL = { update: 'Project update', mention: 'Mention', alert: 'Alert', system: 'System' };

  // type: update | mention | alert | system
  var NOTIFS = [
    { type: 'update', unread: true, time: '5 minutes ago', title: 'Sarah Parker invited you to join "Modern Family Home"', body: 'You have been added as an Estimator.', details: [['Project', 'Modern Family Home'], ['Role', 'Estimator'], ['Invited by', 'Sarah Parker']] },
    { type: 'update', unread: false, time: '1 hour ago', title: 'New estimate completed for "Beach House Project"', body: 'The total estimated cost is R2,345,678.', link: 'estimator.html', details: [['Project', 'Beach House Project'], ['Total', 'R2,345,678'], ['Status', 'Completed']] },
    { type: 'alert', unread: true, time: '2 hours ago', title: 'Material price updated', body: 'Cement (32.5N) price increased by 5.2% from BuildMart.', details: [['Supplier', 'BuildMart'], ['Old price', 'R78.50 / bag'], ['New price', 'R82.60 / bag'], ['Change', '+5.2%'], ['Region', 'Gauteng']], warning: 'This change may affect your active estimates.' },
    { type: 'mention', unread: true, time: '3 hours ago', title: 'Michael Johnson mentioned you in a comment', body: '@Moses Please review the updated floor plan.', details: [['Project', 'Modern Family Home'], ['From', 'Michael Johnson']] },
    { type: 'update', unread: false, time: '5 hours ago', title: 'Project "Office Building" status changed to In Progress', body: 'The project has moved to the execution phase.', details: [['Project', 'Office Building'], ['New status', 'In Progress']] },
    { type: 'update', unread: false, time: '1 day ago', title: 'New supplier "BuildIt Hardware" added', body: 'You can now source materials from BuildIt Hardware.', details: [['Supplier', 'BuildIt Hardware'], ['Region', 'Gauteng']] },
    { type: 'system', unread: false, time: '2 days ago', title: 'System maintenance scheduled', body: 'Maintenance on 18 May from 02:00 to 04:00. Some features may be unavailable.', details: [['Date', '18 May'], ['Window', '02:00 to 04:00']] },
    { type: 'alert', unread: false, time: '2 days ago', title: 'Lisa Wang updated material prices for Gauteng', body: '125 materials were updated.', details: [['Region', 'Gauteng'], ['Materials updated', '125']] },
    { type: 'mention', unread: true, time: '2 days ago', title: 'Thabo Nkosi mentioned you on "Soweto Duplex"', body: '@Moses Can you confirm the roof pitch before Friday?', details: [['Project', 'Soweto Duplex'], ['From', 'Thabo Nkosi']] },
    { type: 'update', unread: false, time: '3 days ago', title: 'Floor plan option B approved', body: 'Naledi Mokoena approved option B for "Pretoria Townhouse".', details: [['Project', 'Pretoria Townhouse'], ['Approved by', 'Naledi Mokoena']] },
    { type: 'system', unread: false, time: '3 days ago', title: 'New feature: export estimates to Word and Excel', body: 'Estimates can now be downloaded as .docx or .xlsx files.', details: [['Where', 'Estimator page'], ['Formats', 'Word, Excel']] },
    { type: 'alert', unread: true, time: '4 days ago', title: 'Budget warning on "Beach House Project"', body: 'The estimate is 8% above your set budget.', details: [['Project', 'Beach House Project'], ['Over budget by', '8%']], warning: 'Review the estimate or adjust the budget.' },
    { type: 'update', unread: false, time: '4 days ago', title: 'Estimate shared with you', body: 'Sipho Dlamini shared "Garage Extension" estimate.', details: [['Project', 'Garage Extension'], ['Shared by', 'Sipho Dlamini']] },
    { type: 'system', unread: false, time: '5 days ago', title: 'Your password was changed', body: 'If this was not you, reset your password now.', details: [['Device', 'Chrome on Windows'], ['Location', 'Johannesburg']] },
    { type: 'update', unread: false, time: '6 days ago', title: 'Project "Durban Holiday Home" created', body: 'You created a new project.', details: [['Project', 'Durban Holiday Home'], ['Region', 'KwaZulu-Natal']] },
    { type: 'system', unread: false, time: '1 week ago', title: 'Monthly AI design limit reset', body: 'You have 3 new AI floor plan generations this month.', details: [['Plan', 'Free'], ['Generations', '3']] },
    { type: 'update', unread: false, time: '1 week ago', title: 'Comment added to "Modern Family Home"', body: 'Sarah Parker: Kitchen moved next to dining area.', details: [['Project', 'Modern Family Home'], ['From', 'Sarah Parker']] },
    { type: 'system', unread: false, time: '1 week ago', title: 'Terms of service updated', body: 'Read what changed in our updated terms.', link: 'terms.html', details: [['Effective', 'Next month']] },
    { type: 'update', unread: false, time: '2 weeks ago', title: 'Supplier quote received', body: 'Cashbuild sent a quote for roofing materials.', details: [['Supplier', 'Cashbuild'], ['Category', 'Roofing']] },
    { type: 'system', unread: false, time: '2 weeks ago', title: 'New sign-in to your account', body: 'Signed in from Safari on iPhone.', details: [['Device', 'Safari on iPhone'], ['Location', 'Pretoria']] },
    { type: 'update', unread: false, time: '2 weeks ago', title: 'Team member joined', body: 'Lerato Mahlangu joined "Office Building".', details: [['Project', 'Office Building'], ['Member', 'Lerato Mahlangu']] },
    { type: 'system', unread: false, time: '3 weeks ago', title: 'Welcome to KagoBuild', body: 'Start by creating your first project.', link: 'projects.html', details: [['Next step', 'Create a project']] },
    { type: 'update', unread: false, time: '3 weeks ago', title: 'Estimate updated for "Garage Extension"', body: 'Prices refreshed with the latest supplier rates.', details: [['Project', 'Garage Extension']] },
    { type: 'system', unread: false, time: '1 month ago', title: 'Email address confirmed', body: 'Your account is now fully active.', details: [['Status', 'Confirmed']] }
  ];

  var state = { tab: 'all', page: 1 };
  var $ = function (s, r) { return (r || document).querySelector(s); };

  function matches(n, tab) {
    if (tab === 'all') return true;
    if (tab === 'unread') return n.unread;
    if (tab === 'mentions') return n.type === 'mention';
    if (tab === 'alerts') return n.type === 'alert';
    if (tab === 'system') return n.type === 'system';
    if (tab === 'updates') return n.type === 'update';
    return true;
  }
  function count(tab) { return NOTIFS.filter(function (n) { return matches(n, tab); }).length; }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderItem(n) {
    var item = el('div', 'notif-item' + (n.unread ? ' is-unread' : ''));
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    var icon = el('span', 'notif-item-icon ' + COLOUR[n.type]);
    icon.innerHTML = ICONS[n.type]; // fixed, trusted markup
    var body = el('div', 'notif-item-body');
    body.appendChild(el('strong', null, n.title));
    var p = el('p', null, n.body + ' ');
    if (n.link) {
      var a = el('a', null, 'Open ›');
      a.href = n.link;
      a.addEventListener('click', function (e) { e.stopPropagation(); });
      p.appendChild(a);
    }
    body.appendChild(p);
    var meta = el('div', 'notif-item-meta');
    meta.appendChild(el('span', null, n.time));
    if (n.unread) meta.appendChild(el('span', 'notif-unread-dot'));
    item.append(icon, body, meta);
    var open = function () { openDetail(n); };
    item.addEventListener('click', open);
    item.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return item;
  }

  function pageButton(label, page, opts) {
    var b = el('button', opts && opts.active ? 'active' : '', label);
    b.type = 'button';
    if (opts && opts.aria) b.setAttribute('aria-label', opts.aria);
    if (opts && opts.active) b.setAttribute('aria-current', 'page');
    if (opts && opts.disabled) b.disabled = true;
    else b.addEventListener('click', function () { state.page = page; render(); $('#notifList').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
    return b;
  }

  function render() {
    var list = NOTIFS.filter(function (n) { return matches(n, state.tab); });
    var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * PAGE_SIZE;
    var shown = list.slice(start, start + PAGE_SIZE);

    var box = $('#notifList');
    box.textContent = '';
    if (!shown.length) {
      var empty = el('div', 'notif-empty');
      empty.appendChild(el('strong', null, state.tab === 'unread' ? "You're all caught up" : 'No notifications here'));
      empty.appendChild(el('p', null, state.tab === 'all' ? 'New notifications will appear here.' : 'Try another tab to see more.'));
      box.appendChild(empty);
    } else {
      shown.forEach(function (n) { box.appendChild(renderItem(n)); });
    }

    // Pagination
    $('#notifRange').textContent = list.length
      ? 'Showing ' + (start + 1) + ' to ' + (start + shown.length) + ' of ' + list.length + ' notifications'
      : 'Showing 0 notifications';
    var btns = $('#notifPages');
    btns.textContent = '';
    btns.appendChild(pageButton('‹', state.page - 1, { aria: 'Previous page', disabled: state.page === 1 }));
    for (var i = 1; i <= pages; i++) btns.appendChild(pageButton(String(i), i, { active: i === state.page, aria: 'Page ' + i }));
    btns.appendChild(pageButton('›', state.page + 1, { aria: 'Next page', disabled: state.page === pages }));

    // Tab counts and active state
    document.querySelectorAll('.notif-tab').forEach(function (t) {
      var on = t.dataset.tab === state.tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      var c = t.querySelector('.notif-count');
      if (c) c.textContent = '(' + count(t.dataset.tab) + ')';
    });

    // Header bell matches the unread count
    var bell = document.getElementById('bellCount');
    if (bell) { bell.textContent = count('unread'); bell.hidden = count('unread') === 0; }

    // Summary card
    $('#sumTotal').textContent = NOTIFS.length;
    $('#sumUnread').textContent = count('unread');
    $('#sumAlerts').textContent = count('alerts');
    $('#sumMentions').textContent = count('mentions');
  }

  function setTab(tab) { state.tab = tab; state.page = 1; render(); }

  // Detail modal
  function openDetail(n) {
    n.unread = false;
    $('#detailIcon').innerHTML = ICONS[n.type];
    $('#detailTitle').textContent = n.title;
    var rows = $('#detailRows');
    rows.textContent = '';
    var first = el('div', 'notif-detail-row');
    first.appendChild(el('span', null, n.body));
    rows.appendChild(first);
    var typeRow = el('div', 'notif-detail-row');
    typeRow.append(el('span', null, 'Type'), el('strong', null, TYPE_LABEL[n.type]));
    rows.appendChild(typeRow);
    (n.details || []).forEach(function (d) {
      var r = el('div', 'notif-detail-row');
      r.append(el('span', null, d[0]), el('strong', null, d[1]));
      rows.appendChild(r);
    });
    var w = $('#detailWarning');
    w.textContent = n.warning || '';
    w.hidden = !n.warning;
    openModal('detailModal');
    render();
  }

  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.notif-tab').forEach(function (t) {
      t.addEventListener('click', function () { setTab(t.dataset.tab); });
    });
    $('#markAllReadPage').addEventListener('click', function () {
      NOTIFS.forEach(function (n) { n.unread = false; });
      document.querySelectorAll('.notif-dd-dot').forEach(function (d) { d.remove(); });
      render();
    });
    $('#viewUnread').addEventListener('click', function () { setTab('unread'); });
    $('#viewAlerts').addEventListener('click', function () { setTab('alerts'); });
    $('#viewMentions').addEventListener('click', function () { setTab('mentions'); });

    document.querySelectorAll('.modal-overlay').forEach(function (o) {
      o.addEventListener('click', function (e) { if (e.target === o) o.classList.remove('open'); });
    });
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () { closeModal(b.dataset.close); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(function (o) { o.classList.remove('open'); });
    });
    $('#openEmailPrefs').addEventListener('click', function () { openModal('prefsModal'); });
    $('#openClearAll').addEventListener('click', function () { openModal('clearAllModal'); });
    $('#confirmClearAll').addEventListener('click', function () {
      NOTIFS.length = 0;
      closeModal('clearAllModal');
      render();
    });

    // Open a tab from the address, e.g. notifications.html#unread
    var h = location.hash.replace('#', '');
    if (['all', 'unread', 'mentions', 'alerts', 'system', 'updates'].indexOf(h) !== -1) state.tab = h;
    render();
  });
})();

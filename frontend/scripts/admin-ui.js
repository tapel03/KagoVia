/* Shared helpers: KPI cards, CRUD tables, charts, modals and toasts. */
window.AdminUI = (function () {
    var esc = function (v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    };

    function el(html) {
        var t = document.createElement('template');
        t.innerHTML = html.trim();
        return t.content.firstElementChild;
    }

    function toast(msg) {
        var box = document.getElementById('toasts');
        if (!box) {
            box = document.createElement('div');
            box.id = 'toasts';
            box.className = 'toasts';
            document.body.appendChild(box);
        }
        var t = el('<div class="toast">' + esc(msg) + '</div>');
        box.appendChild(t);
        setTimeout(function () { t.remove(); }, 3200);
    }

    function openModal(title, bodyHTML, buttons) {
        var m = el('<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">' +
            '<div class="modal-head"><h5>' + esc(title) + '</h5><button class="modal-x" aria-label="Close">×</button></div>' +
            '<div class="modal-body">' + bodyHTML + '</div><div class="modal-foot"></div></div></div>');
        var close = function () { m.remove(); };
        m.querySelector('.modal-x').onclick = close;
        m.addEventListener('mousedown', function (e) { if (e.target === m) close(); });
        var foot = m.querySelector('.modal-foot');
        buttons.forEach(function (b) {
            var x = el('<button class="btn ' + (b.cls || '') + '">' + esc(b.label) + '</button>');
            x.onclick = function () { b.run ? b.run(close, m) : close(); };
            foot.appendChild(x);
        });
        document.body.appendChild(m);
        var f = m.querySelector('input,select,textarea');
        if (f) f.focus();
        return { close: close, root: m };
    }

    function info(title, html) {
        openModal(title, html, [{ label: 'Close', cls: 'primary' }]);
    }

    function form(o) {
        var vals = o.values || {};
        var body = '<div class="form-grid">' + o.fields.map(function (f) {
            var v = vals[f.key] == null ? '' : vals[f.key];
            var inp;
            if (f.type === 'select') {
                inp = '<select class="admin-select" name="' + f.key + '">' + f.options.map(function (op) {
                    return '<option' + (op === v ? ' selected' : '') + '>' + esc(op) + '</option>';
                }).join('') + '</select>';
            } else if (f.type === 'textarea') {
                inp = '<textarea class="admin-input" name="' + f.key + '" rows="4">' + esc(v) + '</textarea>';
            } else {
                inp = '<input class="admin-input" name="' + f.key + '" type="text" value="' + esc(v) + '">';
            }
            return '<label class="field' + (f.type === 'textarea' ? ' full' : '') + '"><span>' + esc(f.label) + '</span>' + inp + '</label>';
        }).join('') + '</div>';

        openModal(o.title, body, [
            { label: 'Cancel' },
            { label: o.saveLabel || 'Save', cls: 'primary', run: function (close, m) {
                var out = {};
                m.querySelectorAll('[name]').forEach(function (i) { out[i.name] = i.value.trim(); });
                if (!out[o.fields[0].key]) { toast(o.fields[0].label + ' is required'); return; }
                o.onSave(out);
                close();
            }}
        ]);
    }

    /* KPI icons: pages pass an emoji, we draw the matching line icon
       so every admin card looks like the dashboard's. */
    var KPI_PATHS = {
        users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/>',
        user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
        alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
        box: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/>',
        calc: '<rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><path d="M16 14v4"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/>',
        cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/>',
        ruler: '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/>',
        money: '<line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
        house: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
        clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
        file: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M16 13H8"/><path d="M16 17H8"/>',
        live: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
        shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
        flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/>',
        truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
        db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
        lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
        search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
        plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
        refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
        megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
        pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
        down: '<path d="M16 17h6v-6"/><path d="m22 17-8.5-8.5-5 5L2 7"/>',
        folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
        bank: '<path d="M10 18v-7"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="M6 18v-7"/><path d="M3 22h18"/><path d="m12 2 9 5H3z"/>',
        target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
        globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
        pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
        mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
        ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
        gear: '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
        pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
        undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
        handshake: '<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/>'
    };

    var KPI_EMOJI = {
        '👥': 'users', '🧑‍💼': 'user', '✅': 'check', '⚠️': 'alert', '🚨': 'alert', '🧱': 'box',
        '🧮': 'calc', '🤖': 'cpu', '📐': 'ruler', '📏': 'ruler', '💰': 'money', '💲': 'money', '💱': 'money',
        '🏠': 'house', '⏱': 'clock', '🕒': 'clock', '⏳': 'clock', '🧾': 'file', '📝': 'file',
        '🤝': 'handshake', '🟢': 'live', '🛡': 'shield', '🔐': 'shield', '🚩': 'flag', '🚚': 'truck',
        '🗄': 'db', '💾': 'db', '🔒': 'lock', '🔑': 'key', '🔎': 'search', '🔍': 'search', '🔌': 'plug',
        '🔄': 'refresh', '🔁': 'refresh', '📣': 'megaphone', '📍': 'pin', '📉': 'down', '📁': 'folder',
        '🏛': 'bank', '🎯': 'target', '🌐': 'globe', '✏️': 'pencil', '✉️': 'mail', '⛔': 'ban',
        '⚙️': 'gear', '⏸': 'pause', '↩️': 'undo'
    };

    function kpiIcon(icon) {
        var bare = String(icon || '').replace(/\uFE0F/g, '');
        var key = KPI_PATHS[icon] ? icon : (KPI_EMOJI[icon] || KPI_EMOJI[bare] || KPI_EMOJI[bare + '\uFE0F']);
        if (!key) return icon || '';
        return '<svg class="ico-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + KPI_PATHS[key] + '</svg>';
    }

    function kpis(list) {
        return '<section class="admin-kpis">' + list.map(function (k) {
            return '<article class="kpi-card"><div class="kpi-icon ' + (k.color || 'red') + '">' + kpiIcon(k.icon) + '</div><div>' +
                '<h4>' + esc(k.label) + '</h4><h2>' + esc(k.value) + '</h2>' +
                '<p class="' + (k.up ? 'up' : '') + '">' + esc(k.sub || '') + '</p></div></article>';
        }).join('') + '</section>';
    }

    /* ----- Row "more" menus (shared by every CRUD table) ----- */
    function closeRowMenus(except) {
        document.querySelectorAll('.kb-row-pop.open').forEach(function (p) {
            if (p === except) return;
            p.classList.remove('open');
            var b = p.previousElementSibling;
            if (b) b.setAttribute('aria-expanded', 'false');
        });
    }

    function toggleRowMenu(btn) {
        var pop = btn.nextElementSibling;
        var open = !pop.classList.contains('open');
        closeRowMenus(pop);
        pop.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (!open) return;
        // Fixed position so the menu is never clipped by the table card
        var r = btn.getBoundingClientRect();
        pop.style.visibility = 'hidden';
        var h = pop.offsetHeight, w = pop.offsetWidth;
        var top = r.bottom + 6;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
        pop.style.top = top + 'px';
        pop.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
        pop.style.visibility = '';
        var first = pop.querySelector('button');
        if (first) first.focus({ preventScroll: true });
    }

    document.addEventListener('click', function (e) {
        if (!e.target.closest('.kb-row-actions')) closeRowMenus();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        var open = document.querySelector('.kb-row-pop.open');
        if (open) { closeRowMenus(); open.previousElementSibling.focus(); }
    });
    window.addEventListener('resize', function () { closeRowMenus(); });
    document.addEventListener('scroll', function () { closeRowMenus(); }, true);

    /* ----- CRUD table card -----
       cfg: title, columns[{key,label,type,options,filter,noForm}], rows, addLabel,
            readOnly, export, note, actions[{label,run,show}], toolbar[{label,run}] */
    function crud(target, cfg) {
        var rows = cfg.rows.map(function (r) { return Object.assign({}, r); });
        var cols = cfg.columns;
        var st = { q: '', f: {} };
        var visible = [];

        var labels = function (c) {
            if (c.type === 'status') return c.options.map(function (o) { return o[0]; });
            if (c.options) return c.options;
            var seen = [];
            rows.forEach(function (r) { if (seen.indexOf(r[c.key]) < 0) seen.push(r[c.key]); });
            return seen;
        };
        var pillCls = function (c, v) {
            var o = c.options.filter(function (x) { return x[0] === v; })[0];
            return o ? o[1] : 'neutral';
        };

        var filterCols = cols.filter(function (c) { return c.filter; });
        var extras = cfg.toolbar || [];
        var acts = cfg.actions || [];

        var root = el('<section class="admin-card"></section>');
        root.innerHTML =
            '<div class="admin-card-head"><h5>' + esc(cfg.title) + '</h5><span class="muted" data-count></span></div>' +
            (cfg.note ? '<div class="notice">' + esc(cfg.note) + '</div>' : '') +
            '<div class="admin-toolbar">' +
                '<input class="admin-search" type="search" placeholder="Search..." data-q>' +
                filterCols.map(function (c) {
                    return '<select class="admin-select" data-f="' + c.key + '"><option value="">All ' + esc(c.label.toLowerCase()) + '</option>' +
                        labels(c).map(function (l) { return '<option>' + esc(l) + '</option>'; }).join('') + '</select>';
                }).join('') +
                '<span class="spacer"></span>' +
                extras.map(function (x, i) { return '<button class="btn" data-x="' + i + '">' + esc(x.label) + '</button>'; }).join('') +
                (cfg.export ? '<button type="button" class="btn btn-export" data-export>' +
                    '<svg class="ico-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>' +
                    'Export<svg class="ico-inline ox-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>' : '') +
                (cfg.readOnly ? '' : '<button class="btn primary" data-add>+ ' + esc(cfg.addLabel || 'Add') + '</button>') +
            '</div>' +
            '<div class="table-wrap"><table class="admin-table kb-cards"><thead><tr>' +
                cols.map(function (c) { return '<th' + (c.type === 'num' ? ' class="r"' : '') + '>' + esc(c.label) + '</th>'; }).join('') +
                ((cfg.readOnly && !acts.length) ? '' : '<th></th>') +
            '</tr></thead><tbody></tbody></table></div>';
        target.appendChild(root);

        var tbody = root.querySelector('tbody');
        var hasActions = !(cfg.readOnly && !acts.length);

        function draw() {
            var q = st.q.toLowerCase();
            var list = [];
            rows.forEach(function (r, i) {
                var okF = Object.keys(st.f).every(function (k) { return !st.f[k] || r[k] === st.f[k]; });
                var okQ = !q || cols.some(function (c) { return String(r[c.key]).toLowerCase().indexOf(q) >= 0; });
                if (okF && okQ) list.push(i);
            });
            tbody.innerHTML = list.length ? list.map(function (i) {
                var r = rows[i];
                var tds = cols.map(function (c) {
                    var v = r[c.key];
                    var lab = ' data-label="' + esc(c.label) + '"';
                    if (c.type === 'status') return '<td' + lab + '><span class="pill ' + pillCls(c, v) + '">' + esc(v) + '</span></td>';
                    return '<td' + lab + (c.type === 'num' ? ' class="r"' : '') + '>' + esc(v) + '</td>';
                }).join('');
                var btns = '';
                acts.forEach(function (a, ai) {
                    if (a.show && !a.show(r)) return;
                    var lab = typeof a.label === 'function' ? a.label(r) : a.label;
                    btns += '<button type="button" role="menuitem" data-a="' + ai + '" data-i="' + i + '">' + esc(lab) + '</button>';
                });
                if (!cfg.readOnly) {
                    btns += '<button type="button" role="menuitem" data-a="edit" data-i="' + i + '">Edit</button>' +
                            '<button type="button" role="menuitem" class="danger" data-a="del" data-i="' + i + '">Delete</button>';
                }
                /* All row actions live in one "more" menu so the table never
                   needs to scroll sideways, however many actions a row has. */
                var name = esc(r[cols[0].key]);
                var menu = btns ? '<div class="kb-row-actions">' +
                    '<button type="button" class="kb-row-more" aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ' + name + '" title="Actions">' +
                        '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>' +
                    '</button><div class="kb-row-pop" role="menu">' + btns + '</div></div>' : '';
                return '<tr>' + tds + (hasActions ? '<td class="actions">' + menu + '</td>' : '') + '</tr>';
            }).join('') : '<tr><td class="empty" colspan="' + (cols.length + 1) + '">No results found</td></tr>';
            root.querySelector('[data-count]').textContent = list.length + ' of ' + rows.length;
            visible = list;
        }

        var fields = cols.filter(function (c) { return !c.noForm; }).map(function (c) {
            var isSel = c.type === 'status' || c.type === 'select';
            return { key: c.key, label: c.label, type: isSel ? 'select' : (c.type === 'textarea' ? 'textarea' : 'text'), options: isSel ? labels(c) : null };
        });

        var api = {
            rows: rows,
            draw: draw,
            toast: toast,
            add: function (r) { rows.unshift(r); draw(); }
        };

        root.querySelector('[data-q]').oninput = function (e) { st.q = e.target.value; draw(); };
        root.querySelectorAll('[data-f]').forEach(function (s) {
            s.onchange = function () { st.f[s.getAttribute('data-f')] = s.value; draw(); };
        });
        root.querySelectorAll('[data-x]').forEach(function (b) {
            b.onclick = function () { extras[+b.getAttribute('data-x')].run(api); };
        });

        /* Export: Excel / Word / PowerPoint (no CSV). cfg.export can be true
           (all three) or a list of formats, e.g. ['xlsx', 'docx']. Exports the
           rows currently shown, so search and filters apply. */
        var exp = root.querySelector('[data-export]');
        if (exp && window.OfficeExport) {
            var fmts = Array.isArray(cfg.export) ? cfg.export : ['xlsx', 'docx', 'pptx'];
            OfficeExport.menu(exp, fmts.map(function (f) {
                return { fmt: f, run: function (fmt) {
                    var list = visible.map(function (i) { return rows[i]; });
                    if (!list.length) { toast('Nothing to export'); return; }
                    var name = 'kagobuild-' + cfg.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                    var filtered = list.length < rows.length;
                    OfficeExport.table(fmt, name, {
                        title: cfg.title,
                        subtitle: list.length + ' row' + (list.length === 1 ? '' : 's') + (filtered ? ' (filtered)' : ''),
                        cols: cols.map(function (c) { return c.label; }),
                        rows: list.map(function (r) { return cols.map(function (c) { return r[c.key]; }); })
                    });
                    toast('Exported ' + list.length + ' row' + (list.length === 1 ? '' : 's') + ' to ' + ({ xlsx: 'Excel', docx: 'Word', pptx: 'PowerPoint' })[fmt]);
                } };
            }));
        }

        var add = root.querySelector('[data-add]');
        if (add) add.onclick = function () {
            var defaults = {};
            fields.forEach(function (f) { defaults[f.key] = f.options ? f.options[0] : ''; });
            form({ title: cfg.addLabel || 'Add', fields: fields, values: defaults, saveLabel: 'Add', onSave: function (out) {
                rows.unshift(Object.assign({}, defaults, out));
                draw();
                toast('Added');
            }});
        };

        tbody.onclick = function (e) {
            var more = e.target.closest('.kb-row-more');
            if (more) { e.stopPropagation(); toggleRowMenu(more); return; }
            var b = e.target.closest('button[data-a]');
            if (!b) return;
            closeRowMenus();
            var i = +b.getAttribute('data-i');
            var a = b.getAttribute('data-a');
            if (a === 'edit') {
                form({ title: 'Edit', fields: fields, values: rows[i], onSave: function (out) {
                    Object.assign(rows[i], out);
                    draw();
                    toast('Saved');
                }});
            } else if (a === 'del') {
                if (confirm('Delete this item? This cannot be undone.')) {
                    rows.splice(i, 1);
                    draw();
                    toast('Deleted');
                }
            } else {
                acts[+a].run(rows[i], api);
                draw();
            }
        };

        draw();
        return api;
    }

    /* ----- Bar chart card with range tabs. series: {Week:{labels,values}, Month:{...}} ----- */
    function chart(target, cfg) {
        var keys = Object.keys(cfg.series);
        var root = el('<section class="admin-card"><div class="admin-card-head"><h5>' + esc(cfg.title) + '</h5>' +
            '<div class="range-tabs">' + keys.map(function (k, i) {
                return '<button class="range-tab' + (i ? '' : ' active') + '" data-k="' + esc(k) + '">' + esc(k) + '</button>';
            }).join('') + '</div></div>' +
            '<div class="bar-chart" data-c></div>' +
            '<div class="chart-foot"><span>Total<strong data-t>0</strong></span><span>Average<strong data-a>0</strong></span><span>Peak<strong data-p>0</strong></span></div></section>');
        target.appendChild(root);

        function render(k) {
            var s = cfg.series[k];
            var max = Math.max.apply(null, s.values);
            var total = s.values.reduce(function (a, b) { return a + b; }, 0);
            root.querySelector('[data-c]').innerHTML = s.values.map(function (v, i) {
                return '<div class="bar-col"><span class="bar-val">' + v + '</span>' +
                    '<div class="bar" style="height:' + Math.round(v / max * 80) + '%"></div>' +
                    '<span class="bar-lbl">' + esc(s.labels[i]) + '</span></div>';
            }).join('');
            root.querySelector('[data-t]').textContent = total.toLocaleString('en-US');
            root.querySelector('[data-a]').textContent = Math.round(total / s.values.length).toLocaleString('en-US');
            root.querySelector('[data-p]').textContent = max.toLocaleString('en-US');
        }

        root.querySelector('.range-tabs').onclick = function (e) {
            var b = e.target.closest('.range-tab');
            if (!b) return;
            root.querySelectorAll('.range-tab').forEach(function (t) { t.classList.remove('active'); });
            b.classList.add('active');
            render(b.getAttribute('data-k'));
        };
        render(keys[0]);
        return root;
    }

    return { esc: esc, el: el, toast: toast, info: info, form: form, kpis: kpis, crud: crud, chart: chart, openModal: openModal };
})();
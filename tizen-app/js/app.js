/* TV-Store UI (#844 phase 4): the Apps2Samsung catalog on the TV, driven with the d-pad, installing
 * through the service (download, sign, push, vd_appinstall). ES5 on purpose: Tizen 4.0 ships
 * Chromium 56.
 *
 * The list is built from resolved.json the way the heads build theirs: the community bundle's
 * embedded catalog gives every package a name, description, category, group and variant, a
 * version and ids; the other providers (Jellyfin builds and such) are one app each with the
 * release's files as variants. Two kinds of app are filtered by the Settings screen (the gear
 * above the list), remembered on the TV:
 *   - adult packages: left out until "Show adult (18+) apps" is on, which asks "I am 18 or older"
 *     first, as the phone does (#850); listed with an 18+ badge then;
 *   - packages the TV cannot install by itself (marked "PC / phone"): listed greyed by default, so
 *     nobody thinks they are missing; "Show apps that need a PC or phone" off hides them. These are
 *     packages that ask for settings before they install (`user_settings`) and packages a head
 *     rewrites with its own injectors (TVapp channels, ImmiTV and Camera PiP server settings),
 *     known by file name here, as in the heads' Packaging/ folder.
 */
(function () {
    'use strict';
    var BASE = 'http://127.0.0.1:8077';
    var sub = document.getElementById('sub'), countEl = document.getElementById('count');
    var listEl = document.getElementById('list'), detailEl = document.getElementById('detail');

    // What the manifest providers are called; resolved.json carries only their ids.
    var PROVIDERS = {
        'jellyfin-tizen-builds': { name: 'Jellyfin', category: 'media', description: 'Jellyfin for Samsung TV, built from jellyfin-web by jeppevinkel. Pick the variant for your server version; plain builds for most sets, OblongIcon for Tizen 8+ launchers.' },
        'moonfin': { name: 'Moonfin', category: 'media', description: 'Jellyfin client with a different take on the UI.' },
        'litefin': { name: 'Litefin', category: 'media', description: 'A lighter Jellyfin client for Samsung TVs.' },
        'tizentube': { name: 'TizenTube', category: 'streaming', description: 'YouTube for Samsung TV with ad blocking and SponsorBlock, built on Cobalt.' },
        'jellyfin-avplay': { name: 'Jellyfin AVPlay', category: 'media', description: 'Jellyfin client using the TV’s AVPlay for hardware decoding.' },
        'jellyfin-avplay-smarthub': { name: 'Jellyfin AVPlay (Smart Hub)', category: 'media', description: 'Jellyfin AVPlay build with Smart Hub preview rows.' },
        'jellyfin-legacy': { name: 'Jellyfin (legacy builds)', category: 'media', description: 'Older Jellyfin builds for servers on 10.8 to 10.10 and for older sets.' }
    };
    var CATEGORY_ORDER = ['media', 'iptv', 'streaming', 'games', 'casting', 'tools', 'other'];
    var HEAD_ONLY = /tvapp|immitv|camerapip|camera-pip/i;   // the heads' injectors, keyed by file name

    var catalogApps = [];      // every app the catalog has, before the Settings filters
    var apps = [], rows = [], idx = 0, selected = null, variantIdx = 0, focusCol = 'list';
    var gearEl = document.getElementById('gear');
    gearEl.onfocus = function () { focusCol = 'gear'; };
    gearEl.onclick = function () { openSettings(); };

    // ---- settings, remembered on the TV ----------------------------------------------------------
    var SETTINGS_KEY = 'a2s.store.settings';
    var settings = loadSettings();
    var confirmingAdult = false;   // the "I am 18 or older" question is showing

    function loadSettings() {
        var s = { showAdult: false, showNeedsHead: true };
        try {
            var saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}');
            if (typeof saved.showAdult === 'boolean') s.showAdult = saved.showAdult;
            if (typeof saved.showNeedsHead === 'boolean') s.showNeedsHead = saved.showNeedsHead;
        } catch (e) {}
        return s;
    }

    function saveSettings() {
        try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
    }
    var installed = {};        // packageId -> version, from the platform
    var ready = null;          // the service's /ping

    function xhr(method, path, bodyObj, cb) {
        var r = new XMLHttpRequest(); r.open(method, BASE + path, true); r.timeout = 180000;
        r.onreadystatechange = function () { if (r.readyState === 4) { if (r.status === 200 || r.status === 400) { try { cb(null, JSON.parse(r.responseText)); } catch (e) { cb(e); } } else cb(new Error('HTTP ' + r.status)); } };
        r.onerror = r.ontimeout = function () { cb(new Error('service unreachable')); };
        if (bodyObj) { r.setRequestHeader('Content-Type', 'application/json'); r.send(JSON.stringify(bodyObj)); } else r.send();
    }

    function startService(cb) {
        try { var pkg = tizen.application.getCurrentApplication().appInfo.id.split('.')[0]; tizen.application.launch(pkg + '.sdbservice', function () {}, function () {}); } catch (e) {}
        var tries = 0; (function poll() { xhr('GET', '/ping', null, function (err, res) {
            if (!err) return cb(null, res);
            if (++tries > 25) return cb(new Error('service did not start'));
            setTimeout(poll, 300);
        }); })();
    }

    // What the platform says is installed: packageId -> version. Empty off a TV.
    function readInstalled(cb) {
        try {
            tizen.application.getAppsInfo(function (infos) {
                var map = {};
                for (var i = 0; i < infos.length; i++) if (infos[i].packageId) map[infos[i].packageId] = infos[i].version || '';
                cb(map);
            }, function () { cb({}); });
        } catch (e) { cb({}); }
    }

    // ---- the catalog ------------------------------------------------------------------------

    // One installable file.
    function variant(label, file, url, version, appId, packageId) {
        return { label: label || file.replace(/\.(wgt|tpk)$/i, ''), file: file, url: url, version: version || '', appId: appId || '', packageId: packageId || '' };
    }

    function build(cat) {
        var out = [], byKey = {};
        function app(key, name, category, description) {
            if (!byKey[key]) { byKey[key] = { name: name, category: category || 'other', description: description || '', variants: [], needsHead: null, adult: false }; out.push(byKey[key]); }
            return byKey[key];
        }
        (cat.providers || []).forEach(function (p) {
            if (p.ok === false) return;
            var rel = (p.releases || [])[0]; if (!rel) return;
            var assets = (rel.assets || []).filter(function (a) { return /\.(wgt|tpk)$/i.test(a.name); });
            var byFile = {}; assets.forEach(function (a) { byFile[a.name] = a; });

            if (p.catalog && p.catalog.apps) {
                // The community bundle: the catalog is the truth, the release gives the download.
                p.catalog.apps.forEach(function (e) {
                    var a = byFile[e.file]; if (!a) return;
                    var key = 'c:' + (e.group || e.name), v = variant(e.variant, e.file, a.browser_download_url, e.version || a.package_version, e.app_id || a.app_id, e.package_id || a.package_id);
                    var x = app(key, e.group || e.name, e.category, e.description);
                    if (e.group && x.variants.length === 0) x.description = e.description;
                    x.variants.push(v);
                    if (e.adult) x.adult = true;
                    if (e.user_settings) v.needsHead = 'asks for settings before it installs';
                    else if (HEAD_ONLY.test(e.file)) v.needsHead = 'is configured by Apps2Samsung while it installs';
                });
                return;
            }

            var info = PROVIDERS[p.id] || { name: p.id, category: 'other', description: '' };
            var x = app('p:' + p.id, info.name, info.category, info.description);
            assets.forEach(function (a) { x.variants.push(variant(null, a.name, a.browser_download_url, a.package_version, a.app_id, a.package_id)); });
        });

        out = out.filter(function (x) { return x.variants.length > 0; });
        out.forEach(function (x) {
            // An app is "needs a head" when every file of it does.
            var all = x.variants.every(function (v) { return !!v.needsHead; });
            x.needsHead = all ? x.variants[0].needsHead : null;
            x.key = x.name.toLowerCase();
        });
        out.sort(function (a, b) {
            var ca = CATEGORY_ORDER.indexOf(a.category), cb = CATEGORY_ORDER.indexOf(b.category);
            if (ca !== cb) return ca - cb;
            return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
        });
        return out;
    }

    // The catalog as the Settings say to show it.
    function visible(all) {
        return all.filter(function (x) {
            if (x.adult && !settings.showAdult) return false;
            if (x.needsHead && !settings.showNeedsHead) return false;
            return true;
        });
    }

    // Installed / update state of an app: from the variant whose package id the TV lists.
    function state(x) {
        for (var i = 0; i < x.variants.length; i++) {
            var v = x.variants[i];
            if (v.packageId && installed.hasOwnProperty(v.packageId)) {
                var have = installed[v.packageId];
                return { installed: true, version: have, update: !!(v.version && have && v.version !== have), variant: i };
            }
        }
        return { installed: false };
    }

    // ---- rendering ----------------------------------------------------------------------------

    function categoryName(id) { return (window.__categories && window.__categories[id]) || id; }

    // The letter tile in front of a row, as Core's AppTiles: the first letter or digit, on the
    // category's colour; an app outside the known categories gets a stable colour from its name.
    var TILES = ['media', 'iptv', 'streaming', 'games', 'casting', 'tools', 'other'];
    function tileLetter(name) { var m = String(name || '').match(/[A-Za-z0-9]/); return m ? m[0].toUpperCase() : '?'; }
    function tileClass(category, name) {
        if (TILES.indexOf(category) >= 0 && category !== 'other') return 't-' + category;
        if (!name) return 't-other';
        var h = 0; for (var i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
        return 't-' + TILES[h % TILES.length];
    }
    function badge(cls, text) { return '<span class="badge ' + cls + '">' + esc(text) + '</span>'; }

    function render() {
        listEl.innerHTML = ''; rows = [];
        var lastCat = null, card = null;
        var counts = {}; apps.forEach(function (x) { counts[x.category] = (counts[x.category] || 0) + 1; });
        apps.forEach(function (x, i) {
            if (x.category !== lastCat) {
                lastCat = x.category;
                var g = document.createElement('div'); g.className = 'grp';
                g.innerHTML = '<span class="t">' + esc(categoryName(x.category)) + '</span><span class="n">' + counts[x.category] + '</span>';
                listEl.appendChild(g);
                card = document.createElement('div'); card.className = 'card'; listEl.appendChild(card);
            }
            var row = document.createElement('div'); row.className = 'row' + (x.needsHead ? ' dim' : ''); row.tabIndex = 0;
            var st = state(x);
            var subline = categoryName(x.category) + (x.variants.length > 1 ? ' \u00b7 ' + x.variants.length + ' variants' : (x.variants[0].version ? ' \u00b7 v' + x.variants[0].version : ''));
            var badges = '';
            if (st.installed) badges += badge(st.update ? 'b-warn' : 'b-ok', st.update ? 'Update' : 'Installed');
            if (x.adult) badges += badge('b-warn', '18+');
            if (x.needsHead) badges += badge('b-mute', 'PC / phone');
            row.innerHTML = '<div class="tile ' + tileClass(x.category, x.name) + '">' + esc(tileLetter(x.name)) + '</div>'
                + '<div class="txt"><div class="name">' + esc(x.name) + badges + '</div><div class="meta">' + esc(subline) + '</div></div>'
                + '<svg class="chev" viewBox="0 0 8 14" fill="none" stroke="#F2F2F7" stroke-width="1.6"><path d="M1 1l6 6-6 6"/></svg>';
            row.onclick = function () { select(i); };
            row.onfocus = function () { idx = i; focusCol = 'list'; select(i); };
            card.appendChild(row); rows.push(row);
        });
        var hidden = catalogApps.length - apps.length;
        countEl.textContent = apps.length + (apps.length === 1 ? ' app' : ' apps') + (hidden > 0 ? ' \u00b7 ' + hidden + ' hidden' : '');
        if (!apps.length) listEl.innerHTML = '<div class="empty">No apps to show. Press \u25b2 for Settings.</div>';
    }

    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    function select(i) {
        idx = i; selected = apps[i];
        var st = state(selected);
        variantIdx = st.installed ? st.variant : 0;
        rows.forEach(function (r, j) { r.className = 'row' + (j === i ? ' sel' : '') + (apps[j].needsHead ? ' dim' : ''); });
        detailEl.innerHTML = '';
        var sheet = document.createElement('div'); sheet.className = 'sheet'; detailEl.appendChild(sheet);
        var h = document.createElement('h2'); h.textContent = selected.name; sheet.appendChild(h);
        if (selected.description) { var d = document.createElement('div'); d.className = 'desc'; d.textContent = selected.description; sheet.appendChild(d); }
        var sl = document.createElement('div'); sl.className = 'subline';
        sl.textContent = categoryName(selected.category) + (selected.variants.length > 1 ? ' \u00b7 ' + selected.variants.length + ' variants' : '');
        sheet.appendChild(sl);
        if (st.installed || selected.adult) {
            var pills = document.createElement('div'); pills.className = 'pills';
            if (selected.adult) pills.innerHTML += '<span class="pill warn">Adults only (18+)</span>';
            if (st.installed) pills.innerHTML += '<span class="pill ' + (st.update ? 'warn' : 'ok') + '">' + (st.update ? 'Update available' : 'Installed') + (st.version ? ' \u00b7 v' + esc(st.version) : '') + '</span>';
            sheet.appendChild(pills);
        }
        var notice = document.createElement('div'); notice.className = 'notice'; notice.id = 'notice'; notice.style.display = 'none'; sheet.appendChild(notice);

        if (selected.variants.length > 1) {
            var vh = document.createElement('div'); vh.className = 'vh'; vh.textContent = 'Variant'; sheet.appendChild(vh);
            var vars = document.createElement('div'); vars.className = 'vars'; sheet.appendChild(vars);
            selected.variants.forEach(function (v, k) {
                var el = document.createElement('div'); el.className = 'var' + (k === variantIdx ? ' sel' : ''); el.tabIndex = 0; el.setAttribute('data-k', k);
                el.innerHTML = '<span class="radio"></span><span class="vl">' + esc(v.label) + (v.needsHead ? badge('b-mute', 'PC / phone') : '') + '</span><span class="vv">' + esc(v.version ? 'v' + v.version : v.file) + '</span>';
                el.onclick = function () { chooseVariant(k); };
                el.onfocus = function () { focusCol = 'detail'; };
                vars.appendChild(el);
            });
        }

        var btns = document.createElement('div'); btns.className = 'btns';
        var btn = document.createElement('button'); btn.id = 'installBtn'; btn.onclick = doInstall; btn.onfocus = function () { focusCol = 'detail'; };
        btns.appendChild(btn);
        var cur = selected.variants[variantIdx];
        if (st.installed && cur.appId) {
            var open = document.createElement('button'); open.className = 'alt'; open.textContent = 'Open'; open.id = 'openBtn';
            open.onclick = function () { launch(cur.appId); }; open.onfocus = function () { focusCol = 'detail'; };
            btns.appendChild(open);
        }
        sheet.appendChild(btns);
        var stEl = document.createElement('div'); stEl.className = 'status'; stEl.id = 'status'; sheet.appendChild(stEl);
        var lg = document.createElement('div'); lg.className = 'log'; lg.id = 'log'; sheet.appendChild(lg);
        refreshInstallButton();
    }

    function chooseVariant(k) {
        variantIdx = k;
        var vars = detailEl.querySelectorAll('.var');
        for (var i = 0; i < vars.length; i++) vars[i].className = 'var' + (i === k ? ' sel' : '');
        refreshInstallButton();
    }

    function refreshInstallButton() {
        var btn = document.getElementById('installBtn'), stEl = document.getElementById('status'), notice = document.getElementById('notice');
        var v = selected.variants[variantIdx], st = state(selected);
        var label = st.installed && st.variant === variantIdx ? (st.update ? 'Update to v' + v.version : 'Reinstall') : 'Install on this TV';
        stEl.className = 'status'; stEl.textContent = '';
        if (v.needsHead) {
            btn.disabled = true; btn.textContent = 'Install from a PC or phone';
            notice.style.display = ''; notice.textContent = selected.name + ' ' + v.needsHead + ', which this TV cannot do yet. Install it with Apps2Samsung on a PC or phone.';
            return;
        }
        if (ready && !ready.certReady) {
            btn.disabled = true; btn.textContent = label;
            notice.style.display = ''; notice.textContent = 'Not armed yet. Open this TV\u2019s Toolbox in Apps2Samsung and press "Arm TV-Store" once; after that every install runs here.';
            return;
        }
        notice.style.display = 'none';
        btn.disabled = false; btn.textContent = label;
    }

    // ---- the Settings screen -------------------------------------------------------------------

    function option(key, title, hint) {
        var on = settings[key];
        var el = document.createElement('div'); el.className = 'opt'; el.tabIndex = 0; el.setAttribute('data-key', key);
        el.innerHTML = '<div class="ot"><div class="ont">' + esc(title) + '</div><div class="oh">' + esc(hint) + '</div></div>'
            + '<span class="sw' + (on ? ' on' : '') + '"><span class="knob"></span></span>';
        el.onclick = function () { toggle(key); };
        el.onfocus = function () { focusCol = 'detail'; };
        return el;
    }

    function openSettings(focusKey) {
        selected = null;
        rows.forEach(function (r, j) { r.className = 'row' + (apps[j].needsHead ? ' dim' : ''); });
        detailEl.innerHTML = '';
        var sheet = document.createElement('div'); sheet.className = 'sheet'; detailEl.appendChild(sheet);
        var h = document.createElement('h2'); h.textContent = 'Settings'; sheet.appendChild(h);
        var list = document.createElement('div'); list.className = 'opts'; sheet.appendChild(list);
        list.appendChild(option('showAdult', 'Show adult (18+) apps', 'Apps marked adult-only stay out of the list until this is on.'));
        list.appendChild(option('showNeedsHead', 'Show apps that need a PC or phone',
            'Some apps need Apps2Samsung on a PC or phone to install. Turn this off to keep them out of the list.'));

        if (confirmingAdult) {
            var notice = document.createElement('div'); notice.className = 'notice';
            notice.textContent = 'These apps are meant for adults only. Turn them on only if you are 18 or older.';
            sheet.appendChild(notice);
            var btns = document.createElement('div'); btns.className = 'btns';
            var yes = document.createElement('button'); yes.id = 'adultYes'; yes.textContent = 'I am 18 or older';
            yes.onclick = function () { confirmingAdult = false; setSetting('showAdult', true); };
            var no = document.createElement('button'); no.className = 'alt'; no.textContent = 'Cancel';
            no.onclick = function () { confirmingAdult = false; openSettings('showAdult'); };
            yes.onfocus = no.onfocus = function () { focusCol = 'detail'; };
            btns.appendChild(yes); btns.appendChild(no); sheet.appendChild(btns);
        }

        var note = document.createElement('div'); note.className = 'subline'; note.style.marginTop = '18px';
        note.textContent = 'Remembered on this TV.';
        sheet.appendChild(note);

        focusCol = 'detail';
        var target = confirmingAdult ? document.getElementById('adultYes') : detailEl.querySelector('.opt[data-key="' + (focusKey || 'showAdult') + '"]');
        if (target) target.focus();
    }

    function toggle(key) {
        // Turning adult apps on asks first; turning anything off does not.
        if (key === 'showAdult' && !settings.showAdult) { confirmingAdult = true; openSettings(key); return; }
        setSetting(key, !settings[key]);
    }

    function setSetting(key, value) {
        settings[key] = value; saveSettings();
        apps = visible(catalogApps); idx = 0; render();
        openSettings(key);
    }

    // ---- actions ------------------------------------------------------------------------------

    function doInstall() {
        var btn = document.getElementById('installBtn'), stEl = document.getElementById('status'), lg = document.getElementById('log');
        var x = selected, v = x.variants[variantIdx];
        if (btn.disabled) return;
        btn.disabled = true; stEl.className = 'status'; stEl.textContent = 'Installing ' + x.name + (x.variants.length > 1 ? ' (' + v.label + ')' : '') + '…'; lg.textContent = '';
        var seen = 0, timer = null;
        function tick() {
            xhr('GET', '/logs', null, function (err, res) {
                if (err || !res || !res.logs) return;
                var lines = res.logs.filter(function (l) { return l.indexOf('install:') >= 0; });
                if (seen === 0) seen = Math.max(0, lines.length - 1);
                lg.textContent = lines.slice(seen).map(function (l) { return l.replace(/^\S+\s+install:\s*/, ''); }).join('\n');
                lg.className = 'log' + (lg.textContent ? ' on' : '');
            });
        }
        timer = setInterval(tick, 700);
        xhr('POST', '/install', { url: v.url, file: v.file, appId: v.appId, packageId: v.packageId }, function (err, res) {
            clearInterval(timer); tick();
            if (err) { btn.disabled = false; stEl.className = 'status err'; stEl.textContent = 'Error: ' + err.message; return; }
            if (!res.ok) { btn.disabled = false; stEl.className = 'status ' + (res.code === 'NO_CERT' ? 'warn' : 'err'); stEl.textContent = res.error; return; }
            stEl.className = 'status ok'; stEl.textContent = '✓ Installed ' + x.name + '. It is in the Apps row now.';
            if (v.packageId) installed[v.packageId] = v.version;
            readInstalled(function (map) { for (var k in map) installed[k] = map[k]; render(); select(idx); rows[idx].className += ''; var ob = document.getElementById('openBtn'); if (ob) ob.focus(); else document.getElementById('installBtn').focus(); });
        });
    }

    function launch(appId) {
        try { tizen.application.launch(appId, function () {}, function (e) { var s = document.getElementById('status'); s.className = 'status err'; s.textContent = 'Could not open it: ' + (e && e.message); }); }
        catch (e) {}
    }

    // ---- keys ---------------------------------------------------------------------------------

    function focusables() { return Array.prototype.slice.call(detailEl.querySelectorAll('.opt, .var, button:not([disabled])')); }

    document.addEventListener('keydown', function (e) {
        var k = e.keyCode;
        if (k === 10009) {           // RETURN: details or gear -> list, list -> leave
            if ((focusCol === 'detail' || focusCol === 'gear') && rows.length) { rows[idx].focus(); e.preventDefault(); return; }
            try { tizen.application.getCurrentApplication().exit(); } catch (x) {}
            return;
        }
        if (focusCol === 'gear') {
            if (k === 13) { openSettings(); e.preventDefault(); }
            else if ((k === 40 || k === 37) && rows.length) { rows[idx].focus(); e.preventDefault(); }
            else if (k === 39) { var fg = focusables(); if (fg.length) { fg[0].focus(); e.preventDefault(); } }
            return;
        }
        if (focusCol === 'list') {
            if (!rows.length) { if (k === 38) { gearEl.focus(); e.preventDefault(); } return; }
            if (k === 40) { idx = Math.min(idx + 1, rows.length - 1); rows[idx].focus(); e.preventDefault(); }
            else if (k === 38) { if (idx === 0) gearEl.focus(); else { idx--; rows[idx].focus(); } e.preventDefault(); }
            else if (k === 39 || k === 13) { var f = focusables(); if (f.length) { f[0].focus(); e.preventDefault(); } }
            return;
        }
        var f2 = focusables(), at = f2.indexOf(document.activeElement);
        var back = function () { if (rows.length) rows[idx].focus(); else gearEl.focus(); };
        if (k === 37) { back(); e.preventDefault(); }
        else if (k === 40) { if (at < f2.length - 1) f2[at + 1].focus(); e.preventDefault(); }
        else if (k === 38) { if (at > 0) f2[at - 1].focus(); else if (!selected) gearEl.focus(); else back(); e.preventDefault(); }
        else if (k === 13) {
            var el = document.activeElement;
            if (el && el.className.indexOf('opt') === 0) toggle(el.getAttribute('data-key'));
            else if (el && el.className.indexOf('var') === 0) chooseVariant(parseInt(el.getAttribute('data-k'), 10));
            else if (el && el.tagName === 'BUTTON') el.click();
            e.preventDefault();
        }
    });

    // ---- the API a head drives over the web inspector (#844 phase 3) ----------------------------
    function showArmed(ping) {
        ready = ping;
        if (ping.certReady) { sub.textContent = 'Ready. Installs are signed on this TV.'; sub.className = 'sub ok'; }
        else { sub.textContent = 'Not armed yet: open this TV’s Toolbox in Apps2Samsung (PC, phone or CLI) and press "Arm TV-Store" to hand over the signing certificate.'; sub.className = 'sub warn'; }
        if (selected) refreshInstallButton();
    }
    window.A2SStore = {
        version: '0.3.0',
        status: function () { return new Promise(function (resolve) { xhr('GET', '/ping', null, function (err, res) { resolve(err ? { ok: false, error: err.message } : res); }); }); },
        setCertificate: function (certs) {
            return new Promise(function (resolve) {
                xhr('POST', '/cert', certs, function (err, res) {
                    if (err) return resolve({ ok: false, error: err.message });
                    if (res && res.ok) showArmed({ ok: true, certReady: true });
                    resolve(res || { ok: false, error: 'no answer from the service' });
                });
            });
        }
    };

    // ---- boot ---------------------------------------------------------------------------------
    startService(function (err, ping) {
        if (err) { sub.textContent = err.message; sub.className = 'sub err'; return; }
        showArmed(ping);
        readInstalled(function (map) {
            installed = map;
            xhr('GET', '/catalog', null, function (err, cat) {
                if (err) { sub.textContent = 'Catalog unavailable: ' + err.message; sub.className = 'sub err'; return; }
                var community = (cat.providers || []).filter(function (p) { return p.catalog && p.catalog.categories; })[0];
                window.__categories = community ? community.catalog.categories : {};
                catalogApps = build(cat); apps = visible(catalogApps); render();
                if (apps.length) rows[0].focus(); else gearEl.focus();
            });
        });
    });
})();

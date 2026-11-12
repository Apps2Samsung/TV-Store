/* The store in a phone or PC browser (#101): the page at http://<TV IP>:8077/.
 *
 * Nothing here installs anything. The page shows what the TV-Store screen last told the service
 * (POST /store/state from app.js: the apps with their Installed / Update state, why one cannot be
 * installed from here, the running install), and Install asks the TV-Store screen to do it
 * (POST /store/install). The screen then installs the way it does when OK is pressed on the TV, with
 * the same checks, signing and questions, and shows it. So TV-Store has to be open on the TV; the
 * page says so when it is not.
 *
 * An app with settings (the catalog's user_settings: a server address, an API key) gets a form
 * first: the values go to the service with the request, are checked there and kept on the TV, and
 * written into the package when the screen installs it (usersettings.js). A saved value is never
 * sent back to a browser; the form only says which fields are saved. #app=<key> in the address
 * opens that app's form or card (the QR code on the TV links there).
 *
 * Inline and offline: no external assets, so it works on a LAN without internet. The page's script
 * is client() below, sent as its own source: ES5, for old phone browsers. */
'use strict';

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

var CSS = ''
    + ':root{color-scheme:dark}*{box-sizing:border-box}'
    + 'body{margin:0;background:#0D1B2A;color:#F4F7FB;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:16px;line-height:1.45}'
    + '.wrap{max-width:1100px;margin:0 auto;padding:20px 16px 80px}'
    + 'h1{font-size:24px;margin:0}.sub{color:#9FB0C6;font-size:14px;margin-top:4px}'
    + '.top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px}'
    + '.live{font-size:14px;padding:6px 12px;border-radius:999px;background:rgba(48,196,110,.14);color:#30C46E;white-space:nowrap}.live.off{background:rgba(240,160,32,.14);color:#F0A020}'
    + '.card{background:#142638;border-radius:16px;padding:16px;margin-bottom:14px}'
    + '.notice{border-radius:12px;padding:12px 14px;margin-bottom:14px;background:rgba(240,160,32,.14);color:#F0A020}.notice.bad{background:rgba(255,107,94,.14);color:#FF6B5E}.notice.info{background:rgba(244,247,251,.06);color:#9FB0C6}'
    + '.bar{height:8px;border-radius:4px;background:rgba(244,247,251,.14);overflow:hidden;margin-top:10px}.bar i{display:block;height:100%;background:#2DD4BF;transition:width .4s}.bar.bad i{background:#FF6B5E}'
    + '.tools{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}'
    + 'input{font:inherit}input[type=search],.fld input{width:100%;padding:12px 14px;border-radius:12px;border:2px solid transparent;background:rgba(244,247,251,.08);color:#F4F7FB}input[type=search]{flex:1 1 240px;width:auto;min-width:0}'
    + '.fld input:focus,input[type=search]:focus{outline:none;border-color:#2DD4BF}'
    + '.btn{border:0;border-radius:12px;padding:10px 16px;font:inherit;font-weight:700;background:#2DD4BF;color:#042F2E;cursor:pointer;text-decoration:none;display:inline-block;text-align:center}.btn.sec{background:rgba(244,247,251,.12);color:#F4F7FB}.btn[disabled]{background:rgba(244,247,251,.08);color:#9FB0C6;cursor:default}'
    + '.chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;margin-bottom:14px;scrollbar-width:none}.chips::-webkit-scrollbar{display:none}@media (hover:hover) and (min-width:700px){.chips{flex-wrap:wrap;overflow:visible}}'
    + '.chip{flex:none;border:0;border-radius:999px;padding:7px 14px;font:inherit;font-size:14px;background:rgba(244,247,251,.08);color:#9FB0C6;cursor:pointer}.chip.on{background:#F4F7FB;color:#0D1B2A}'
    + '.grid{display:flex;flex-wrap:wrap;margin:0 -7px}.app{width:100%;padding:0 7px}@media(min-width:640px){.app{width:50%}}@media(min-width:960px){.app{width:33.333%}}'
    + '.app .card{display:flex;flex-direction:column;height:calc(100% - 14px)}.app .card.hl{box-shadow:inset 0 0 0 2px #2DD4BF}'
    + '.hd{display:flex;align-items:center;gap:12px}.nm{font-weight:700;font-size:17px}.mt{color:#9FB0C6;font-size:13px}'
    + '.tile{position:relative;flex:none;width:52px;height:52px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:22px;overflow:hidden}'
    + '.tile img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover}'
    + '.desc{color:#9FB0C6;font-size:14px;margin:10px 0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}'
    + '.badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.b{font-size:12px;padding:3px 8px;border-radius:999px;background:rgba(244,247,251,.08);color:#9FB0C6}.b.ok{background:rgba(48,196,110,.14);color:#30C46E}.b.warn{background:rgba(240,160,32,.14);color:#F0A020}'
    + '.act{margin-top:auto;padding-top:10px}.act .why{color:#9FB0C6;font-size:13px;margin-top:6px}.act .btn{width:100%}.act .btn+.btn{margin-top:8px}'
    + '.empty{color:#9FB0C6;text-align:center;padding:40px 0}'
    + '.veil{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(5,12,20,.72);display:none;align-items:flex-start;justify-content:center;overflow-y:auto;padding:24px 16px}.veil.on{display:flex}'
    + '.form{width:100%;max-width:560px;background:#142638;border-radius:18px;padding:20px}.form h2{margin:0 0 4px;font-size:20px}'
    + '.fld{margin-top:16px}.fld label{display:block;font-size:14px;margin-bottom:6px}.fld .req{color:#F0A020}.fld .err{color:#FF6B5E;font-size:13px;margin-top:6px}.fld.bad input{border-color:#FF6B5E}.fld .saved{color:#30C46E;font-size:13px;margin-top:6px}'
    + '.btns{display:flex;gap:10px;margin-top:20px}.btns .btn{flex:1}a{color:#2DD4BF}'
    + '.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:calc(100% - 32px);background:#F4F7FB;color:#0D1B2A;padding:12px 16px;border-radius:12px;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.4);display:none;z-index:9}.toast.on{display:block}';

// The page's own script, sent as source. Polls /store/state every 2 s and renders it.
/* eslint-disable */
function client() {
    var S = null, cat = 'all', q = '', busy = {}, sent = {}, seen = {}, form = null, wanted = null;
    var STEPS = ['Downloading', 'Checking and signing', 'Installing on the TV', 'Ready to open'];
    var $ = function (id) { return document.getElementById(id); };
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function toast(t) { var e = $('toast'); e.textContent = t; e.className = 'toast on'; clearTimeout(toast.t); toast.t = setTimeout(function () { e.className = 'toast'; }, 6000); }
    function ago(ms) { var s = Math.round(ms / 1000); return s < 90 ? s + ' s' : Math.round(s / 60) + ' min'; }
    function gb(b) { return b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB'; }
    function req(m, p, body, cb) {
        var x = new XMLHttpRequest(); x.open(m, p, true); x.timeout = 10000;
        x.onload = function () { var r = null; try { r = JSON.parse(x.responseText); } catch (e) {} cb(x.status, r); };
        x.onerror = x.ontimeout = function () { cb(0, null); };
        if (body) { x.setRequestHeader('Content-Type', 'application/json'); x.send(JSON.stringify(body)); } else x.send();
    }
    function apps() { return (S && S.state && S.state.apps) || []; }
    function app(k) { return apps().filter(function (a) { return a.key === k; })[0] || null; }
    function live() { return !!(S && S.live && S.enabled); }
    function tile(a) {
        var c = ((S.state && S.state.categories) || []).filter(function (k) { return k.id === a.cat; })[0], m = String(a.name || '').match(/[A-Za-z0-9]/);
        return '<div class="tile" style="background:' + esc(c ? c.color : '#868E96') + '">' + esc(m ? m[0].toUpperCase() : '?')
            + (a.icon ? '<img alt="" src="/icon/' + esc(a.icon) + '" onerror="this.parentNode.removeChild(this)">' : '') + '</div>';
    }
    function badges(a) {
        var b = '';
        if (a.installed !== null) b += a.update ? '<span class="b warn">Update to v' + esc(a.latest) + '</span>' : '<span class="b ok">Installed' + (a.installed ? ' · v' + esc(a.installed) : '') + '</span>';
        else if (a.latest) b += '<span class="b">v' + esc(a.latest) + '</span>';
        if (a.source) b += '<span class="b">' + esc(a.source) + '</span>';
        if (a.variant) b += '<span class="b">' + esc(a.variant) + '</span>';
        if (a.settings) b += '<span class="b">' + (a.saved && a.saved.length ? 'Settings saved on the TV' : 'Has settings') + '</span>';
        if (a.adult) b += '<span class="b warn">18+</span>';
        if (a.root) b += '<span class="b warn">root</span>';
        if (a.partner) b += '<span class="b">Partner certificate</span>';
        return b;
    }
    function action(a) {
        var j = S.state.job, mine = j && j.running && j.key === a.key;
        if (mine) return '<button class="btn" disabled>' + (j.update ? 'Updating' : 'Installing') + ' on the TV…</button>';
        if (busy[a.key]) return '<button class="btn" disabled>Sent to the TV…</button>';
        var current = a.installed !== null && !a.update;
        // An app with settings that is on the TV and current: its settings can be changed, which installs it again.
        if (current && a.settings && !a.why) return '<button class="btn sec" data-form="' + esc(a.key) + '"' + (live() ? '' : ' disabled') + '>Change its settings</button>';
        if (current) return a.why ? '<div class="why">' + esc(a.why) + '</div>' : '';
        var label = a.update ? 'Update' : 'Install';
        if (!a.can) return '<button class="btn" disabled>' + label + '</button><div class="why">' + esc(a.why) + '</div>';
        return '<button class="btn" ' + (a.settings ? 'data-form' : 'data-key') + '="' + esc(a.key) + '"' + (live() ? '' : ' disabled') + '>' + label + (a.settings ? '…' : '') + '</button>';
    }
    function jobHtml(j) {
        var pct = j.error || j.ok ? 100 : Math.min(100, Math.round(j.step / 4 * 100 + 8));
        var h = '<div class="card"><div class="nm">' + esc(j.name) + '</div><div class="mt">'
            + (j.error ? (j.update ? 'Update failed' : 'Install failed') : j.ok ? (j.update ? 'Updated' : 'Installed') + ' on the TV' : (j.update ? 'Updating' : 'Installing') + ': step ' + Math.min(j.step + 1, 4) + ' of 4, ' + STEPS[Math.min(j.step, 3)])
            + '</div><div class="bar' + (j.error ? ' bad' : '') + '"><i style="width:' + pct + '%"></i></div>';
        if (j.error) h += '<div class="notice bad" style="margin:12px 0 0">' + esc(j.error) + (j.onTv ? ' Answer it on the TV.' : '') + '</div>';
        if (S.state.queue && S.state.queue.length) h += '<div class="mt" style="margin-top:10px">Next: ' + esc(S.state.queue.join(', ')) + '</div>';
        return h + '</div>';
    }
    function render() {
        if (!S) return;
        var st = S.state || {}, tv = st.tv || {}, list = apps();
        $('title').textContent = 'TV-Store' + (tv.model ? ' on ' + tv.model : '');
        var sub = [];
        if (tv.tizen) sub.push('Tizen ' + tv.tizen);
        if (tv.version) sub.push('TV-Store v' + tv.version);
        if (tv.certs && tv.certs.length) sub.push('signs with ' + tv.certs.map(function (c) { return c.name + (c.level ? ' (' + c.level + ')' : ''); }).join(', '));
        if (tv.free) sub.push(gb(tv.free) + ' free');
        $('sub').textContent = sub.join(' · ');
        var l = $('live');
        if (!S.enabled) { l.className = 'live off'; l.textContent = 'Off in TV-Store’s Settings'; }
        else if (S.live) { l.className = 'live'; l.textContent = 'TV-Store is open on the TV'; }
        else { l.className = 'live off'; l.textContent = 'TV-Store is not open on the TV'; }
        var n = '';
        if (!S.enabled) n = '<div class="notice">Installing from a browser is off. Turn on “Install from a browser” in TV-Store’s Settings on the TV.</div>';
        else if (!S.state) n = '<div class="notice">Open TV-Store on the TV. This page shows the store once TV-Store has loaded it there.</div>';
        else if (!S.live) n = '<div class="notice">Open TV-Store on the TV to install from here. This is what it showed ' + ago(S.age) + ' ago.</div>';
        else if (!tv.armed) n = '<div class="notice">TV-Store is not armed yet: open this TV in Apps2Samsung on a phone or PC and press Arm TV-Store once.</div>';
        $('notice').innerHTML = n;
        $('job').innerHTML = st.job ? jobHtml(st.job) : '';
        var u = $('updall');
        if (!S.state) { $('grid').innerHTML = ''; $('chips').innerHTML = ''; u.style.display = 'none'; return; }
        var ups = list.filter(function (a) { return a.update && a.can && !a.settings; });
        u.style.display = ups.length ? '' : 'none'; u.textContent = 'Update all (' + ups.length + ')'; u.disabled = !live() || !!busy['*all'];
        var cats = (st.categories || []).filter(function (c) { return list.some(function (a) { return a.cat === c.id; }); });
        if (cat !== 'all' && cat !== 'tv' && !cats.some(function (c) { return c.id === cat; })) cat = 'all';
        $('chips').innerHTML = '<button class="chip' + (cat === 'all' ? ' on' : '') + '" data-cat="all">All</button>'
            + (list.some(function (a) { return a.installed !== null; }) ? '<button class="chip' + (cat === 'tv' ? ' on' : '') + '" data-cat="tv">On the TV</button>' : '')
            + cats.map(function (c) { return '<button class="chip' + (cat === c.id ? ' on' : '') + '" data-cat="' + esc(c.id) + '">' + esc(c.name) + '</button>'; }).join('');
        var ql = q.toLowerCase(), shown = list.filter(function (a) {
            if (cat === 'tv' && a.installed === null) return false;
            if (cat !== 'all' && cat !== 'tv' && a.cat !== cat) return false;
            return !ql || (a.name + ' ' + (a.author || '') + ' ' + (a.desc || '')).toLowerCase().indexOf(ql) >= 0;
        });
        $('grid').innerHTML = shown.length ? shown.map(function (a) {
            return '<div class="app" id="app-' + esc(a.key) + '"><div class="card' + (wanted === a.key ? ' hl' : '') + '"><div class="hd">' + tile(a) + '<div style="min-width:0"><div class="nm">' + esc(a.name) + '</div><div class="mt">' + esc(a.author ? 'by ' + a.author : '') + '</div></div></div>'
                + '<div class="badges">' + badges(a) + '</div>' + (a.desc ? '<div class="desc">' + esc(a.desc) + '</div>' : '') + '<div class="act">' + action(a) + '</div></div></div>';
        }).join('') : '<div class="empty">Nothing here.</div>';
    }
    // The settings form: one field per setting, saved ones said, never shown.
    function openForm(a, errors) {
        form = { key: a.key };
        var s = a.settings, saved = a.saved || [], current = a.installed !== null && !a.update;
        var h = '<div class="form"><h2>' + esc(a.name) + '</h2><div class="mt">' + (current ? 'Changing its settings installs it again on the TV.' : 'These are written into the app before the TV installs it.')
            + (s.help ? ' <a href="' + esc(s.help) + '" target="_blank" rel="noopener">Where to find them</a>' : '') + '</div>';
        s.fields.forEach(function (f) {
            var has = saved.indexOf(f.key) >= 0, err = errors && errors[f.key];
            var ph = has ? 'Saved on the TV; leave empty to keep it' : f.default ? 'Default: ' + f.default : f.required ? '' : 'Optional';
            h += '<div class="fld' + (err ? ' bad' : '') + '"><label for="f-' + esc(f.key) + '">' + esc(f.label) + (f.required ? ' <span class="req">*</span>' : '') + '</label>'
                + '<input id="f-' + esc(f.key) + '" data-field="' + esc(f.key) + '" autocomplete="off" autocapitalize="off" spellcheck="false"' + (f.type === 'number' ? ' inputmode="numeric"' : '') + ' placeholder="' + esc(ph) + '">'
                + (err ? '<div class="err">' + esc(err) + '</div>' : has ? '<div class="saved">Saved on the TV</div>' : '') + '</div>';
        });
        h += '<div class="btns"><button class="btn sec" data-close="1">Cancel</button><button class="btn" data-submit="1">' + (current ? 'Save and install again' : a.update ? 'Update on the TV' : 'Install on the TV') + '</button></div></div>';
        $('veil').innerHTML = h; $('veil').className = 'veil on';
        var first = $('veil').querySelector('input'); if (first) try { first.focus(); } catch (e) {}
    }
    function closeForm() { form = null; $('veil').className = 'veil'; $('veil').innerHTML = ''; }
    function submitForm() {
        var a = form && app(form.key); if (!a) return closeForm();
        var vals = {};
        Array.prototype.forEach.call($('veil').querySelectorAll('input[data-field]'), function (i) { vals[i.getAttribute('data-field')] = i.value; });
        var k = a.key;
        busy[k] = true;
        req('POST', '/store/install', { key: k, settings: vals }, function (code, r) {
            if (code === 200 && r && r.ok) { sent[r.request.id] = k; closeForm(); toast('Sent to the TV: ' + a.name); }
            else { delete busy[k]; if (r && r.fields) { var keep = {}; Array.prototype.forEach.call($('veil').querySelectorAll('input[data-field]'), function (i) { keep[i.getAttribute('data-field')] = i.value; }); openForm(a, r.fields); Array.prototype.forEach.call($('veil').querySelectorAll('input[data-field]'), function (i) { i.value = keep[i.getAttribute('data-field')] || ''; }); } toast((r && r.error) || 'The TV did not answer'); }
            render();
        });
    }
    // #app=<key>: the TV's QR code for one app. Its form when it has settings, else its card.
    function openWanted() {
        if (!wanted || !S || !S.state) return;
        var a = app(wanted); if (!a) { wanted = null; return; }
        if (a.settings && live() && !busy[a.key] && (a.can || (a.installed !== null && !a.why))) { openForm(a); wanted = null; return; }
        cat = 'all'; render();
        var el = $('app-' + a.key); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
        setTimeout(function () { wanted = null; render(); }, 4000);
        wanted = a.key;
    }
    function poll() {
        req('GET', '/store/state', null, function (code, r) {
            if (code === 200 && r && r.ok) {
                var first = !S || !S.state;
                S = r;
                (r.requests || []).forEach(function (x) {
                    if (!sent[x.id]) return;
                    if (x.status !== 'waiting') delete busy[sent[x.id]];
                    if (seen[x.id] === x.status) return;
                    seen[x.id] = x.status;
                    if (x.status === 'taken') toast('The TV started it: ' + x.name);
                    if (x.status === 'failed') toast('Not installed: ' + x.name + (x.message ? ': ' + x.message : ''));
                    if (x.status === 'done') toast(x.name + ' is on the TV');
                });
                if (!form) render();
                if (first && r.state) openWanted();
            } else if (!S) $('notice').innerHTML = '<div class="notice bad">Cannot reach TV-Store on the TV.</div>';
            setTimeout(poll, 2000);
        });
    }
    function ask(body, k, name) {
        busy[k] = true; render();
        req('POST', '/store/install', body, function (code, r) {
            if (code === 200 && r && r.ok) { sent[r.request.id] = k; toast('Sent to the TV: ' + name); }
            else { delete busy[k]; if (r && r.code === 'NEEDS_SETTINGS' && app(k)) openForm(app(k)); toast((r && r.error) || 'The TV did not answer'); }
            render();
        });
    }
    document.addEventListener('click', function (e) {
        var t = e.target; if (!t || !t.getAttribute) return;
        if (t.id === 'veil') return closeForm();
        if (t.getAttribute('data-close')) return closeForm();
        if (t.getAttribute('data-submit')) return submitForm();
        var c = t.getAttribute('data-cat'); if (c) { cat = c; render(); return; }
        var f = t.getAttribute('data-form'); if (f && !t.disabled) { var fa = app(f); if (fa) openForm(fa); return; }
        var k = t.getAttribute('data-key');
        if (k && !t.disabled) { var a = app(k); if (a) ask({ key: k }, k, a.name); return; }
        if (t.id === 'updall' && !t.disabled) ask({ all: true }, '*all', 'the updates');
    });
    document.addEventListener('keydown', function (e) { if (!form) return; if (e.keyCode === 27) closeForm(); if (e.keyCode === 13 && e.target && e.target.getAttribute && e.target.getAttribute('data-field')) submitForm(); });
    $('q').addEventListener('input', function () { q = this.value.trim(); render(); });
    var m = /[#&]app=([^&]+)/.exec(location.hash || ''); if (m) { try { wanted = decodeURIComponent(m[1]); } catch (x) {} }
    poll();
}

// The page; ip names the TV in the title until the state says its model.
function page(ip) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TV-Store</title><style>' + CSS + '</style></head><body><div class="wrap">'
        + '<div class="top"><div><h1 id="title">TV-Store</h1><div class="sub" id="sub">' + esc(ip || '') + '</div></div><span class="live off" id="live">Connecting…</span></div>'
        + '<div id="notice"></div><div id="job"></div>'
        + '<div class="tools"><input type="search" id="q" placeholder="Search apps" autocomplete="off"><button class="btn" id="updall" style="display:none">Update all</button><a class="btn sec" href="/upload">Send your own .wgt</a></div>'
        + '<div class="chips" id="chips"></div><div class="grid" id="grid"></div></div><div class="veil" id="veil"></div><div class="toast" id="toast"></div>'
        + '<script>(' + client.toString() + ')();</script></body></html>';
}

module.exports = { page: page };

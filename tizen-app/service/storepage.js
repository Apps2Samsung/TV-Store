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
    + '.wrap{max-width:1100px;margin:0 auto;padding:16px 16px 80px}'
    // The TV's card: its name, whether TV-Store is open on it, and three numbers.
    + '.hero{border-radius:20px;padding:18px;margin-bottom:14px;background:#142638;background:radial-gradient(120% 140% at 100% 0,rgba(45,212,191,.26),rgba(45,212,191,0) 55%),linear-gradient(160deg,#1B3A55,#11263A)}'
    + '.lbl{color:#9FB0C6;font-size:12px;letter-spacing:.08em;text-transform:uppercase}'
    + 'h1{font-size:26px;line-height:1.15;margin:2px 0 4px;word-wrap:break-word}.sub{color:#9FB0C6;font-size:13px;margin-top:4px}'
    + '.live{font-size:14px;font-weight:700;color:#30C46E}.live:before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:#30C46E;margin-right:7px}.live.off{color:#F0A020}.live.off:before{background:#F0A020}'
    + '.stats{display:flex;margin:14px -4px 0}.stats:empty{display:none}.stat{flex:1;min-width:0;margin:0 4px;background:rgba(5,12,20,.35);border-radius:12px;padding:8px 10px;font-size:12px;color:#9FB0C6}.stat b{display:block;font-size:17px;color:#F4F7FB;white-space:nowrap}'
    + '@media(min-width:700px){.hero{display:flex;align-items:center;justify-content:space-between;padding:22px 24px}.hero>div:first-child{min-width:0;padding-right:20px}.stats{flex:0 0 420px;margin-top:0}}'
    + '.card{background:#142638;border-radius:16px;padding:16px;margin-bottom:14px}'
    + '.notice{border-radius:12px;padding:12px 14px;margin-bottom:14px;background:rgba(240,160,32,.14);color:#F0A020}.notice.bad{background:rgba(255,107,94,.14);color:#FF6B5E}.notice.info{background:rgba(244,247,251,.06);color:#9FB0C6}'
    + '.bar{height:8px;border-radius:4px;background:rgba(244,247,251,.14);overflow:hidden;margin-top:10px}.bar i{display:block;height:100%;background:#2DD4BF;transition:width .4s}.bar.bad i{background:#FF6B5E}'
    + '.tools{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}'
    + 'input{font:inherit}input[type=search],.fld input{width:100%;padding:12px 14px;border-radius:12px;border:2px solid transparent;background:rgba(244,247,251,.08);color:#F4F7FB}input[type=search]{flex:1 1 240px;width:auto;min-width:0}'
    + '.fld input:focus,input[type=search]:focus{outline:none;border-color:#2DD4BF}'
    + '.btn{border:0;border-radius:12px;padding:10px 16px;font:inherit;font-weight:700;background:#2DD4BF;color:#042F2E;cursor:pointer;text-decoration:none;display:inline-block;text-align:center}.btn.sec{background:rgba(244,247,251,.12);color:#F4F7FB}.btn[disabled]{background:rgba(244,247,251,.08);color:#9FB0C6;cursor:default}'
    + '.chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;scrollbar-width:none}.chips::-webkit-scrollbar{display:none}@media (hover:hover) and (min-width:700px){.chips{flex-wrap:wrap;overflow:visible}}'
    + '.chip{flex:none;border:0;border-radius:999px;padding:7px 14px;font:inherit;font-size:14px;background:rgba(244,247,251,.08);color:#9FB0C6;cursor:pointer}.chip.on{background:#F4F7FB;color:#0D1B2A}'
    // A section (Updates, On the TV, a category) is a heading and a list; an app is one row in it:
    // one card of rows on a phone, a card per row in two or three columns on a wider screen.
    + '.sh{display:flex;align-items:center;min-height:32px;margin:16px 0 8px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9FB0C6}.sh .pb{margin-left:auto;text-transform:none;letter-spacing:0}'
    + '.list{background:#142638;border-radius:16px;overflow:hidden}'
    + '.r{padding:10px 12px;border-bottom:1px solid rgba(244,247,251,.09)}.r:last-child{border-bottom:0}.r.hl{box-shadow:inset 0 0 0 2px #2DD4BF}'
    + '.rm{display:flex;align-items:center;cursor:pointer}.r.open .rm{align-items:flex-start}.rb{flex:1;min-width:0;margin:0 12px}'
    + '.nm{font-weight:700;font-size:16px}.mt{color:#9FB0C6;font-size:13px}.ds{color:#8497AE;font-size:13px}'
    + '.rb .nm,.rb .mt,.ds{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.r.open .rb .nm,.r.open .rb .mt,.r.open .ds{white-space:normal}'
    + '.tile{position:relative;flex:none;width:44px;height:44px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:19px;overflow:hidden}'
    + '.tile img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover}'
    + '.pb{flex:none;border:0;border-radius:999px;padding:7px 14px;font:inherit;font-size:13px;font-weight:800;background:rgba(45,212,191,.14);color:#2DD4BF;cursor:pointer;white-space:nowrap}.pb.fill{background:#2DD4BF;color:#042F2E}.pb.done{background:none;color:#30C46E;padding-right:2px;cursor:default}.pb[disabled]{background:rgba(244,247,251,.08);color:#9FB0C6;cursor:default}'
    + '.why{color:#9FB0C6;font-size:13px;margin:6px 0 0 56px}.more{display:none;margin:8px 0 0 56px}.r.open .more{display:block}'
    + '.b{display:inline-block;font-size:12px;padding:3px 8px;margin:0 6px 4px 0;border-radius:999px;background:rgba(244,247,251,.08);color:#9FB0C6}.b.ok{background:rgba(48,196,110,.14);color:#30C46E}.b.warn{background:rgba(240,160,32,.14);color:#F0A020}.nm .b{margin:0 0 0 6px;font-weight:400;vertical-align:1px}'
    + '@media(min-width:640px){.list{display:flex;flex-wrap:wrap;align-items:flex-start;background:none;border-radius:0;overflow:visible;margin:-5px}.r,.r:last-child{width:calc(50% - 10px);margin:5px;background:#142638;border-radius:14px;border-bottom:0}}@media(min-width:960px){.r,.r:last-child{width:calc(33.333% - 10px)}}'
    + '.empty{color:#9FB0C6;text-align:center;padding:40px 0}'
    + '.veil{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(5,12,20,.72);display:none;align-items:flex-start;justify-content:center;overflow-y:auto;padding:24px 16px}.veil.on{display:flex}'
    + '.form{width:100%;max-width:560px;background:#142638;border-radius:18px;padding:20px}.form h2{margin:0 0 4px;font-size:20px}'
    + '.fld{margin-top:16px}.fld label{display:block;font-size:14px;margin-bottom:6px}.fld .req{color:#F0A020}.fld .err{color:#FF6B5E;font-size:13px;margin-top:6px}.fld.bad input{border-color:#FF6B5E}.fld .saved{color:#30C46E;font-size:13px;margin-top:6px}'
    + '.btns{display:flex;gap:10px;margin-top:20px}.btns .btn{flex:1}a{color:#2DD4BF}'
    + '.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:calc(100% - 32px);background:#F4F7FB;color:#0D1B2A;padding:12px 16px;border-radius:12px;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.4);display:none;z-index:9}.toast.on{display:block}';

// The page's own script, sent as source. Polls /store/state every 2 s and renders it.
/* eslint-disable */
function client() {
    var S = null, cat = 'all', q = '', busy = {}, sent = {}, seen = {}, form = null, wanted = null, open = {}, drawn = null;
    var STEPS = ['Downloading', 'Checking and signing', 'Installing on the TV', 'Ready to open'];
    var $ = function (id) { return document.getElementById(id); };
    var NAME = $('title').textContent;   // the TV's address, until the state says its model
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
    // What the row's second line says: the version, an update as from and to, who made it.
    function meta(a) {
        var p = [];
        if (a.installed !== null && a.update) p.push((a.installed ? 'v' + a.installed + ' to ' : 'Update to ') + 'v' + a.latest);
        else if (a.installed !== null) p.push(a.installed ? 'v' + a.installed : 'Installed');
        else if (a.latest) p.push('v' + a.latest);
        if (a.author) p.push('by ' + a.author);
        return p.join(' · ');
    }
    // The rest, shown when the row is tapped open.
    function badges(a) {
        var b = '';
        if (a.source) b += '<span class="b">' + esc(a.source) + '</span>';
        if (a.variant) b += '<span class="b">' + esc(a.variant) + '</span>';
        if (a.settings) b += '<span class="b">' + (a.saved && a.saved.length ? 'Settings saved on the TV' : 'Has settings') + '</span>';
        if (a.partner) b += '<span class="b">Partner certificate</span>';
        return b;
    }
    function pending(a) { var j = S.state.job; return !!((j && j.running && j.key === a.key) || busy[a.key]); }
    function action(a) {
        var j = S.state.job, mine = j && j.running && j.key === a.key;
        if (mine) return '<button class="pb" disabled>' + (j.update ? 'Updating' : 'Installing') + '…</button>';
        if (busy[a.key]) return '<button class="pb" disabled>Sent to the TV…</button>';
        var current = a.installed !== null && !a.update;
        // An app with settings that is on the TV and current: its settings can be changed, which installs it again.
        if (current && a.settings && !a.why) return '<button class="pb" data-form="' + esc(a.key) + '"' + (live() ? '' : ' disabled') + '>Settings</button>';
        if (current) return '<span class="pb done">✓ On the TV</span>';
        var label = a.update ? 'Update' : 'Install';
        if (!a.can) return '<button class="pb" disabled>' + label + '</button>';
        return '<button class="pb' + (a.update ? ' fill' : '') + '" ' + (a.settings ? 'data-form' : 'data-key') + '="' + esc(a.key) + '"' + (live() ? '' : ' disabled') + '>' + label + (a.settings ? '…' : '') + '</button>';
    }
    // One app: its tile, name, version and one line of its description, the button on the right. A tap
    // on the row opens it: the whole description and the rest of what is known about it.
    function row(a) {
        var current = a.installed !== null && !a.update, more = badges(a);
        return '<div class="r' + (wanted === a.key ? ' hl' : '') + (open[a.key] ? ' open' : '') + '" id="app-' + esc(a.key) + '"><div class="rm" data-row="' + esc(a.key) + '">' + tile(a)
            + '<div class="rb"><div class="nm">' + esc(a.name) + (a.adult ? '<span class="b warn">18+</span>' : '') + (a.root ? '<span class="b warn">root</span>' : '') + '</div><div class="mt">' + esc(meta(a)) + '</div>'
            + (a.desc ? '<div class="ds">' + esc(a.desc) + '</div>' : '') + '</div>' + action(a) + '</div>'
            + (a.why && !pending(a) && (current || !a.can) ? '<div class="why">' + esc(a.why) + '</div>' : '')
            + (more ? '<div class="more">' + more + '</div>' : '') + '</div>';
    }
    function section(title, items, extra) {
        return items.length ? '<div class="sh"><span>' + esc(title) + ' · ' + items.length + '</span>' + (extra || '') + '</div><div class="list">' + items.map(row).join('') + '</div>' : '';
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
        $('title').textContent = tv.model || NAME;
        $('sub').textContent = tv.certs && tv.certs.length ? 'Signs with ' + tv.certs.map(function (c) { return c.name + (c.level ? ' (' + c.level + ')' : ''); }).join(', ') : '';
        var onTv = list.filter(function (a) { return a.installed !== null; }).length, stats = '';
        function stat(big, small) { stats += '<div class="stat"><b>' + esc(big) + '</b>' + esc(small) + '</div>'; }
        if (S.state) {
            stat(onTv + (onTv === 1 ? ' app' : ' apps'), 'on the TV');
            if (tv.free) stat(gb(tv.free), 'free');
            if (tv.tizen) stat('Tizen ' + tv.tizen, tv.version ? 'TV-Store v' + tv.version : '');
        }
        $('stats').innerHTML = stats;
        var l = $('live');
        if (!S.enabled) { l.className = 'live off'; l.textContent = 'Off in TV-Store’s Settings'; }
        else if (S.live) { l.className = 'live'; l.textContent = 'TV-Store is open, ready to install'; }
        else { l.className = 'live off'; l.textContent = 'TV-Store is not open on the TV'; }
        var n = '';
        if (!S.enabled) n = '<div class="notice">Installing from a browser is off. Turn on “Install from a browser” in TV-Store’s Settings on the TV.</div>';
        else if (!S.state) n = '<div class="notice">Open TV-Store on the TV. This page shows the store once TV-Store has loaded it there.</div>';
        else if (!S.live) n = '<div class="notice">Open TV-Store on the TV to install from here. This is what it showed ' + ago(S.age) + ' ago.</div>';
        else if (!tv.armed) n = '<div class="notice">TV-Store is not armed yet: open this TV in Apps2Samsung on a phone or PC and press Arm TV-Store once.</div>';
        $('notice').innerHTML = n;
        $('job').innerHTML = st.job ? jobHtml(st.job) : '';
        if (!S.state) { $('apps').innerHTML = drawn = ''; $('chips').innerHTML = ''; return; }
        var cats = (st.categories || []).filter(function (c) { return list.some(function (a) { return a.cat === c.id; }); });
        if (cat !== 'all' && cat !== 'tv' && !cats.some(function (c) { return c.id === cat; })) cat = 'all';
        $('chips').innerHTML = '<button class="chip' + (cat === 'all' ? ' on' : '') + '" data-cat="all">All</button>'
            + (onTv ? '<button class="chip' + (cat === 'tv' ? ' on' : '') + '" data-cat="tv">On the TV</button>' : '')
            + cats.map(function (c) { return '<button class="chip' + (cat === c.id ? ' on' : '') + '" data-cat="' + esc(c.id) + '">' + esc(c.name) + '</button>'; }).join('');
        var ql = q.toLowerCase(), h = '';
        if (cat === 'all' && !ql) {
            // Everything: what needs an update first, then what is on the TV, then the rest per category.
            var ups = list.filter(function (a) { return a.update && a.can && !a.settings; });
            h += section('Updates', list.filter(function (a) { return a.installed !== null && a.update; }),
                ups.length ? '<button class="pb" id="updall"' + (live() && !busy['*all'] ? '' : ' disabled') + '>Update all (' + ups.length + ')</button>' : '');
            h += section('On the TV', list.filter(function (a) { return a.installed !== null && !a.update; }));
            var rest = list.filter(function (a) { return a.installed === null; });
            cats.forEach(function (c) { h += section(c.name, rest.filter(function (a) { return a.cat === c.id; })); });
            h += section('Other', rest.filter(function (a) { return !cats.some(function (c) { return c.id === a.cat; }); }));
        } else {
            // A category, On the TV or a search: one list.
            var named = cats.filter(function (c) { return c.id === cat; })[0];
            h = section(ql ? 'Found' : cat === 'tv' ? 'On the TV' : named ? named.name : 'Apps', list.filter(function (a) {
                if (cat === 'tv' && a.installed === null) return false;
                if (cat !== 'all' && cat !== 'tv' && a.cat !== cat) return false;
                return !ql || (a.name + ' ' + (a.author || '') + ' ' + (a.desc || '')).toLowerCase().indexOf(ql) >= 0;
            }));
        }
        h = h || '<div class="empty">Nothing here.</div>';
        // Only when it changed: the poll comes every 2 s, and a redraw loads every icon again.
        if (h !== drawn) { $('apps').innerHTML = h; drawn = h; }
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
        cat = 'all'; open[a.key] = true; wanted = a.key; render();
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
        if (t.id === 'updall') { if (!t.disabled) ask({ all: true }, '*all', 'the updates'); return; }
        // Anywhere else on a row: open or close it.
        while (t && t.getAttribute && !t.getAttribute('data-row')) t = t.parentNode;
        if (t && t.getAttribute) { var rk = t.getAttribute('data-row'); open[rk] = !open[rk]; render(); }
    });
    document.addEventListener('keydown', function (e) { if (!form) return; if (e.keyCode === 27) closeForm(); if (e.keyCode === 13 && e.target && e.target.getAttribute && e.target.getAttribute('data-field')) submitForm(); });
    $('q').addEventListener('input', function () { q = this.value.trim(); render(); });
    var m = /[#&]app=([^&]+)/.exec(location.hash || ''); if (m) { try { wanted = decodeURIComponent(m[1]); } catch (x) {} }
    poll();
}

// The page; ip names the TV in its card until the state says its model.
function page(ip) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TV-Store</title><style>' + CSS + '</style></head><body><div class="wrap">'
        + '<div class="hero"><div><div class="lbl">TV-Store on</div><h1 id="title">' + esc(ip || 'your TV') + '</h1><div class="live off" id="live">Connecting…</div><div class="sub" id="sub"></div></div><div class="stats" id="stats"></div></div>'
        + '<div id="notice"></div><div id="job"></div>'
        + '<div class="tools"><input type="search" id="q" placeholder="Search apps" autocomplete="off"><a class="btn sec" href="/upload">Send your own .wgt</a></div>'
        + '<div class="chips" id="chips"></div><div id="apps"></div></div><div class="veil" id="veil"></div><div class="toast" id="toast"></div>'
        + '<script>(' + client.toString() + ')();</script></body></html>';
}

module.exports = { page: page };

/* TV-Store UI: load the catalog through the service, D-pad navigate, install the selected app.
 * The service does the real work (download, sign, push, vd_appinstall); this renders and drives it. */
(function () {
    'use strict';
    var BASE = 'http://127.0.0.1:8077';
    var sub = document.getElementById('sub'), listEl = document.getElementById('list'), detailEl = document.getElementById('detail');
    var apps = [], rows = [], idx = 0, selected = null;

    function xhr(method, path, bodyObj, cb) {
        var r = new XMLHttpRequest(); r.open(method, BASE + path, true); r.timeout = 120000;
        r.onreadystatechange = function () { if (r.readyState === 4) { if (r.status === 200) { try { cb(null, JSON.parse(r.responseText)); } catch (e) { cb(e); } } else cb(new Error('HTTP ' + r.status)); } };
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

    // Flatten resolved.json into installable entries: one per asset, newest release per provider.
    function flatten(cat) {
        var out = [];
        (cat.providers || []).forEach(function (p) {
            if (p.ok === false) return;
            var rel = (p.releases || [])[0]; if (!rel) return;
            (rel.assets || []).forEach(function (a) {
                if (!/\.(wgt|tpk)$/i.test(a.name)) return;
                out.push({ name: a.name.replace(/\.(wgt|tpk)$/i, ''), file: a.name, url: a.browser_download_url,
                           appId: a.app_id, packageId: a.package_id, version: a.package_version, category: p.id || 'other' });
            });
        });
        out.sort(function (x, y) { return x.name.toLowerCase() < y.name.toLowerCase() ? -1 : 1; });
        return out;
    }

    function render() {
        listEl.innerHTML = ''; rows = [];
        var lastCat = null;
        apps.forEach(function (app, i) {
            if (app.category !== lastCat) { lastCat = app.category; var c = document.createElement('div'); c.className = 'cat'; c.textContent = app.category; listEl.appendChild(c); }
            var row = document.createElement('div'); row.className = 'row'; row.tabIndex = 0;
            row.innerHTML = '<div>' + app.name + '</div><div class="meta">' + (app.version ? 'v' + app.version : '') + '</div>';
            row.onclick = function () { select(i); };
            row.onfocus = function () { idx = i; select(i); };
            listEl.appendChild(row); rows.push(row);
        });
    }

    function select(i) {
        idx = i; selected = apps[i];
        rows.forEach(function (r, j) { r.className = 'row' + (j === i ? ' sel' : ''); });
        detailEl.innerHTML = '';
        var h = document.createElement('h2'); h.textContent = selected.name; detailEl.appendChild(h);
        var pills = document.createElement('div');
        pills.innerHTML = '<span class="pill">' + selected.category + '</span>' + (selected.version ? '<span class="pill">v' + selected.version + '</span>' : '') + '<span class="pill">' + selected.file + '</span>';
        detailEl.appendChild(pills);
        var btn = document.createElement('button'); btn.textContent = 'Install on this TV'; btn.id = 'installBtn';
        btn.onclick = doInstall; detailEl.appendChild(btn);
        var st = document.createElement('div'); st.className = 'status'; st.id = 'status'; detailEl.appendChild(st);
    }

    function doInstall() {
        var btn = document.getElementById('installBtn'), st = document.getElementById('status');
        btn.disabled = true; st.className = 'status'; st.textContent = 'Installing ' + selected.name + '…';
        xhr('POST', '/install', selected, function (err, res) {
            btn.disabled = false;
            if (err) { st.className = 'status err'; st.textContent = 'Error: ' + err.message; return; }
            if (!res.ok) { st.className = 'status ' + (res.code === 'SIGNER_NOT_READY' ? 'warn' : 'err'); st.textContent = res.error; return; }
            st.className = 'status ok'; st.textContent = '✓ Installed ' + selected.name + '. Open it from the Apps row.';
        });
    }

    document.addEventListener('keydown', function (e) {
        if (!rows.length) return;
        if (e.keyCode === 40) { idx = Math.min(idx + 1, rows.length - 1); rows[idx].focus(); }
        else if (e.keyCode === 38) { idx = Math.max(idx - 1, 0); rows[idx].focus(); }
        else if (e.keyCode === 13) { var b = document.getElementById('installBtn'); if (document.activeElement && document.activeElement.className.indexOf('row') >= 0) select(idx); else if (b) b.click(); }
    });

    startService(function (err, ping) {
        if (err) { sub.textContent = err.message; sub.className = 'sub err'; return; }
        sub.textContent = ping.signerReady ? 'Ready.' : 'Catalog ready. On-TV signing is still in development (#844), so Install reports that step.';
        xhr('GET', '/catalog', null, function (err, cat) {
            if (err) { sub.textContent = 'Catalog unavailable: ' + err.message; sub.className = 'sub err'; return; }
            apps = flatten(cat); render();
            if (apps.length) rows[0].focus();
        });
    });
})();

/* TV-Store UI: load the catalog through the service, D-pad navigate, install the selected app.
 * The service does the real work (download, sign, push, vd_appinstall); this renders and drives it. */
(function () {
    'use strict';
    var BASE = 'http://127.0.0.1:8077';
    var sub = document.getElementById('sub'), listEl = document.getElementById('list'), detailEl = document.getElementById('detail');
    var apps = [], rows = [], idx = 0, selected = null;

    function xhr(method, path, bodyObj, cb) {
        var r = new XMLHttpRequest(); r.open(method, BASE + path, true); r.timeout = 120000;
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

    // What the sub line says about the signing certificate: armed, or how to arm it. The head's
    // toolbox is the only way in; TV-Store cannot make a certificate on its own (#844, phase 2).
    function showArmed(ping) {
        if (ping.certReady) { sub.textContent = 'Ready. Installs are signed on this TV.'; sub.className = 'sub ok'; }
        else { sub.textContent = 'Not armed yet: open this TV\'s Toolbox in Apps2Samsung (PC, phone or CLI) and press "Arm TV-Store" to hand over the signing certificate.'; sub.className = 'sub warn'; }
    }

    // The API a head drives over the web inspector, like the debug agent's window.A2S: the page is
    // the only thing on the TV that can reach the service's loopback port from outside, so the
    // certificate hand-over (#844 phase 3) comes in here. Every call resolves, never rejects, with
    // { ok, ... } so the head reads one shape.
    window.A2SStore = {
        version: '0.2.0',
        // The service's /ping: { ok, ownIp, certReady, signerReady } or { ok: false, error }.
        status: function () {
            return new Promise(function (resolve) {
                xhr('GET', '/ping', null, function (err, res) { resolve(err ? { ok: false, error: err.message } : res); });
            });
        },
        // certs = { authorKeyPem, authorCertPem, distributorKeyPem, distributorCertPem } (PEM, cert
        // PEMs may hold a chain). Stored by the service; the sub line follows at once.
        setCertificate: function (certs) {
            return new Promise(function (resolve) {
                xhr('POST', '/cert', certs, function (err, res) {
                    if (err) return resolve({ ok: false, error: err.message });
                    if (res && res.ok) showArmed({ certReady: true });
                    resolve(res || { ok: false, error: 'no answer from the service' });
                });
            });
        },
    };

    startService(function (err, ping) {
        if (err) { sub.textContent = err.message; sub.className = 'sub err'; return; }
        showArmed(ping);
        xhr('GET', '/catalog', null, function (err, cat) {
            if (err) { sub.textContent = 'Catalog unavailable: ' + err.message; sub.className = 'sub err'; return; }
            apps = flatten(cat); render();
            if (apps.length) rows[0].focus();
        });
    });
})();

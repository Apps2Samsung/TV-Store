/* An app's user settings (catalog user_settings, Apps2Samsung #791): values the user types (a server
 * address, an API key, a port) that are written into the package before it is signed. TV-Store takes
 * them from a phone or PC browser (#101 follow-up) and does what Apps2Samsung's UserSettingsPatcher
 * does, rule for rule, so a package comes out the same whichever installs it:
 *   - each field is an exact-text replacement: `find` -> `replace` with {value} in it, in the spec's
 *     one file, or in every one of the field's `targets` ({ file, find, replace }); every occurrence;
 *   - the find text missing, or the file missing, stops the install: the package changed upstream,
 *     and installing would hand the TV an app that silently cannot connect;
 *   - a value is trimmed; empty is refused when required, else it takes the spec's default, else the
 *     field is left out and its text untouched;
 *   - checks: required, digits only for a number, min / max / disallow, the field's pattern (a
 *     pattern that does not compile is the catalog's problem, not the user's: skipped);
 *   - escaping: when the character right before {value} in the replacement is ' or ", a backslash
 *     and that quote in the value are escaped; a number goes in as it is.
 * Values are kept on the TV per package file (the stored typed values; a default is taken fresh at
 * each install), so an update from the TV writes them again. They can be credentials: never logged,
 * never handed back to a browser, only which keys are set.
 * ES5, Node 4: test/usersettings.test.js. */
'use strict';
var Buf = require('./compat.js');
var zip = require('./zip.js');

function str(s, max) { return typeof s === 'string' ? s.slice(0, max || 4000) : ''; }
function isSignature(name) { return /^(author-signature|signature[0-9]*)\.xml$/i.test(name); }

// The catalog's user_settings, cleaned up: { file, help, fields: [...] }, or null when it has no field
// that can be written. A field needs a key and either targets or find (+ the spec's file).
function normalize(spec) {
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.fields)) return null;
    var file = str(spec.file, 300).trim(), fields = [];
    spec.fields.forEach(function (f) {
        if (!f || typeof f !== 'object' || !/^[A-Za-z0-9_.-]{1,64}$/.test(f.key || '')) return;
        var targets = (Array.isArray(f.targets) ? f.targets : []).filter(function (t) { return t && typeof t.file === 'string' && t.file && typeof t.find === 'string' && t.find && typeof t.replace === 'string'; })
            .map(function (t) { return { file: t.file, find: t.find, replace: t.replace }; });
        var find = str(f.find), replace = str(f.replace);
        if (!targets.length && !(file && find)) return;
        var type = String(f.type || 'text').toLowerCase() === 'number' ? 'number' : 'text';
        fields.push({ key: f.key, label: str(f.label, 300) || f.key, type: type, required: f.required === true, pattern: str(f.pattern, 500),
                      find: find, replace: replace, targets: targets, isNumber: f.isNumber === true || type === 'number',
                      default: f.default === undefined || f.default === null ? '' : String(f.default).trim(),
                      min: typeof f.min === 'number' ? f.min : null, max: typeof f.max === 'number' ? f.max : null,
                      disallow: (Array.isArray(f.disallow) ? f.disallow : []).filter(function (n) { return typeof n === 'number'; }) });
    });
    if (!fields.length) return null;
    var help = str(spec.help_url, 500);
    return { file: file, help: /^https:\/\//.test(help) ? help : '', fields: fields };
}
// What a browser may see of a spec: no find / replace / pattern internals it does not need.
function publicSpec(spec) {
    return { help: spec.help, fields: spec.fields.map(function (f) {
        return { key: f.key, label: f.label, type: f.type, required: f.required, default: f.default, min: f.min, max: f.max, pattern: f.pattern };
    }) };
}

// Why value will not do for field f, in words, or null when it will (Apps2Samsung's Validate).
function validate(f, value) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return f.required ? 'Fill this in.' : null;
    if (f.isNumber && !/^[0-9]+$/.test(v)) return 'Digits only.';
    if (f.isNumber && (f.min !== null || f.max !== null || f.disallow.length)) {
        var n = v.length > 15 ? Infinity : parseInt(v, 10);
        if ((f.min !== null && n < f.min) || (f.max !== null && n > f.max))
            return f.min !== null && f.max !== null ? 'A number from ' + f.min + ' to ' + f.max + '.' : f.min !== null ? 'At least ' + f.min + '.' : 'At most ' + f.max + '.';
        if (f.disallow.indexOf(n) >= 0) return n + ' is not allowed here.';
    }
    if (f.pattern) {
        var re = null;
        try { re = new RegExp(f.pattern); } catch (e) { re = null; }
        if (re && !re.test(v)) return 'That does not look right for this field.';
    }
    return null;
}

// The value as it goes into the text (Apps2Samsung's Escape).
function escape(type, replace, value) {
    if (type === 'number') return value;
    var at = replace.indexOf('{value}'), q = at > 0 ? replace.charAt(at - 1) : '';
    if (q !== '\'' && q !== '"') return value;
    return value.split('\\').join('\\\\').split(q).join('\\' + q);
}

// Works out the values for an install. given: what the user typed now ({ key: value }, or null when
// nothing was typed now); stored: the values kept on the TV ({ key: value }, or null when none).
// A field typed now wins, else the stored one, else the default. Returns { keep, values, errors }:
// keep is what to store (typed values only), values what goes into the package, errors { key: why }.
function resolve(spec, given, stored) {
    var keep = {}, values = {}, errors = {}, bad = false;
    spec.fields.forEach(function (f) {
        var g = given && Object.prototype.hasOwnProperty.call(given, f.key) ? String(given[f.key] == null ? '' : given[f.key]).trim() : '';
        var s = stored && Object.prototype.hasOwnProperty.call(stored, f.key) ? String(stored[f.key]).trim() : '';
        var v = g || s;
        var why = validate(f, v || f.default);
        if (why) { errors[f.key] = why; bad = true; return; }
        if (v) keep[f.key] = v;
        if (v || f.default) values[f.key] = v || f.default;
    });
    return { keep: keep, values: values, errors: bad ? errors : null };
}

// Every replacement, in spec order: a field's targets, or its find / replace in the spec's file.
function edits(spec, values) {
    var out = [];
    spec.fields.forEach(function (f) {
        if (!Object.prototype.hasOwnProperty.call(values, f.key)) return;
        var list = f.targets.length ? f.targets : [{ file: spec.file, find: f.find, replace: f.replace }];
        list.forEach(function (t) { out.push({ key: f.key, file: t.file.replace(/^\.?\//, ''), find: t.find, text: t.replace.split('{value}').join(escape(f.type, t.replace, values[f.key])) }); });
    });
    return out;
}

function readEntry(file, e, cb) {
    var chunks = [], done = false, st = zip.entryStream(file, e);
    function fin(err, b) { if (done) return; done = true; cb(err, b); }
    st.on('data', function (d) { chunks.push(d); });
    st.on('error', fin);
    st.on('end', function () { fin(null, Buffer.concat(chunks)); });
}

// Writes inFile to outFile with the edits made (signature files dropped: it is signed again).
// cb(err, { files, keys }); err.code 'SETTINGS_PATCH' with the file and the missing text.
function patch(inFile, outFile, list, cb) {
    var byFile = {}, order = [];
    list.forEach(function (e) { if (!byFile[e.file]) { byFile[e.file] = []; order.push(e.file); } byFile[e.file].push(e); });
    var entries;
    try { entries = zip.readCentral(inFile); } catch (e) { return cb(e); }
    var names = {};
    entries.forEach(function (e) { names[e.name] = e; });
    for (var i = 0; i < order.length; i++) if (!names[order[i]] || names[order[i]].dir) return cb(fail(order[i] + ' is not in the package.', order[i], null));
    var items = [], changed = [], keys = {}, n = 0;
    (function next() {
        if (n === entries.length) {
            try { zip.writeFile(outFile, items); } catch (e) { return cb(e); }
            return cb(null, { files: changed, keys: Object.keys(keys) });
        }
        var e = entries[n++];
        if (isSignature(e.name)) return next();
        if (!byFile[e.name]) { items.push({ name: e.name, from: inFile, entry: e }); return next(); }
        readEntry(inFile, e, function (err, buf) {
            if (err) return cb(new Error('cannot read ' + e.name + ' from the package: ' + err.message));
            var text = buf.toString('utf8');
            for (var j = 0; j < byFile[e.name].length; j++) {
                var ed = byFile[e.name][j];
                if (text.indexOf(ed.find) < 0) return cb(fail('‘' + ed.find + '’ is not in ' + e.name + '.', e.name, ed.find));
                text = text.split(ed.find).join(ed.text);
                keys[ed.key] = true;
            }
            items.push({ name: e.name, data: Buf.from(text, 'utf8') });
            changed.push(e.name);
            setImmediate(next);
        });
    })();
}
function fail(message, file, find) { var e = new Error(message); e.code = 'SETTINGS_PATCH'; e.file = file; e.find = find; return e; }

module.exports = { normalize: normalize, publicSpec: publicSpec, validate: validate, escape: escape, resolve: resolve, edits: edits, patch: patch };

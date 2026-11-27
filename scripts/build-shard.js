#!/usr/bin/env node
/* Packs vetro-shard/tvstore-onboot into the one-file bundle Vetro installs (#159):
 * vetro-shard/tvstore-onboot-<version>.vplugin. The same text as the catalog's own build
 * (andrearicci93/vetro-plugins, scripts/build.cjs) makes of the folder, so the SHA-256 matches:
 * { format, version, manifest, files } with the files in the order of their names and the manifest
 * not among them. Plain ES5: the test that holds the committed bundle against the folder runs on
 * Node 4 too.   node scripts/build-shard.js [--print]   (--print: to stdout, nothing written) */
'use strict';
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..', 'vetro-shard'), ID = 'tvstore-onboot';

function pack() {
    var folder = path.join(ROOT, ID), manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8')), files = {};
    fs.readdirSync(folder).sort().forEach(function (n) {
        if (n.charAt(0) === '.' || n === 'node_modules' || n === 'config.json' || n === 'manifest.json') return;
        if (fs.statSync(path.join(folder, n)).isDirectory()) throw new Error('a folder in the Shard: ' + n);
        files[n] = fs.readFileSync(path.join(folder, n), 'utf8');
    });
    return { manifest: manifest, file: path.join(ROOT, ID + '-' + manifest.version + '.vplugin'), text: JSON.stringify({ format: 'vetro-plugin', version: 1, manifest: manifest, files: files }) + '\n' };
}
module.exports = pack;

if (require.main === module) {
    var b = pack();
    if (process.argv[2] === '--print') process.stdout.write(b.text);
    else {
        fs.readdirSync(ROOT).forEach(function (n) { if (/\.vplugin$/.test(n)) fs.unlinkSync(path.join(ROOT, n)); });
        fs.writeFileSync(b.file, b.text);
        console.log('built ' + path.relative(path.join(__dirname, '..'), b.file) + ' (' + Buffer.byteLength(b.text) + ' bytes)');
    }
}

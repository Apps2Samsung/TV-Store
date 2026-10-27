/* The streaming signer (signFile) against the in-memory one (sign): a DEFLATED fixture package with a
 * large file is signed both ways. RSA PKCS#1 v1.5 is deterministic, so both signature files must come
 * out byte for byte the same, and the file-signed package must hold the same files, still compressed.
 * Also checks that signFile's memory stays far below the package size. */
'use strict';
var Buf = require('../tizen-app/service/compat.js');
var fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
var signer = require('../tizen-app/service/signer.js');
var zip = require('../tizen-app/service/zip.js');
var F = path.join(__dirname, 'fixtures');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }

// A DEFLATED zip, built by hand (zip.write only does STORED).
function deflatedZip(files) {
    var locals = [], central = [], offset = 0;
    files.forEach(function (f) {
        var name = Buf.from(f.name, 'utf8'), comp = zlib.deflateRawSync(f.data), crc = zip.crc32(f.data);
        var lh = Buf.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
        lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
        var cd = Buf.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
        cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(f.data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
        var rec = Buffer.concat([lh, name, comp]); locals.push(rec); central.push(Buffer.concat([cd, name])); offset += rec.length;
    });
    var cdBuf = Buffer.concat(central), eocd = Buf.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat(locals.concat([cdBuf, eocd]));
}

var big = crypto.randomBytes(24 * 1024 * 1024);          // incompressible: the package is ~24 MB
var files = [
    { name: 'config.xml', data: Buf.from('<?xml version="1.0"?>\n<widget id="http://x/t" version="1.0.0"><name>T</name></widget>\n') },
    { name: 'index.html', data: Buf.from('<!doctype html><title>t</title>\n') },
    { name: 'js/big.bin', data: big },
    { name: 'img/empty.txt', data: Buf.alloc(0) },
];
var pkg = deflatedZip(files);
var certs = {
    authorKeyPem: fs.readFileSync(path.join(F, 'author.key'), 'utf8'), authorCertPem: fs.readFileSync(path.join(F, 'author.crt'), 'utf8'),
    distributorKeyPem: fs.readFileSync(path.join(F, 'distributor.key'), 'utf8'), distributorCertPem: fs.readFileSync(path.join(F, 'distributor.crt'), 'utf8'),
};
var mem = zip.readEntries(signer.sign(pkg, certs));
function find(list, n) { for (var i = 0; i < list.length; i++) if (list[i].name === n) return list[i].data; }

var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'a2s-sign-')) : os.tmpdir();
var inFile = path.join(dir, 'in.wgt'), outFile = path.join(dir, 'out.wgt');
fs.writeFileSync(inFile, pkg);
pkg = null; files[2].data = null;                        // only the files from here on
if (global.gc) global.gc();
var rssBefore = process.memoryUsage().rss, peak = rssBefore;
var timer = setInterval(function () { peak = Math.max(peak, process.memoryUsage().rss); }, 5);

signer.signFile(inFile, outFile, certs, function (err) {
    clearInterval(timer);
    if (err) fail('signFile: ' + err.message);
    var outBuf = fs.readFileSync(outFile), out = zip.readEntries(outBuf);
    if (out[0].name !== 'author-signature.xml' || out[1].name !== 'signature1.xml') fail('signature files not first');
    ['author-signature.xml', 'signature1.xml'].forEach(function (n) {
        if (!find(out, n).equals(find(mem, n))) fail(n + ' differs from the in-memory signer');
    });
    ['config.xml', 'index.html', 'img/empty.txt'].forEach(function (n) { if (!find(out, n).equals(find(mem, n))) fail(n + ' content differs'); });
    if (!find(out, 'js/big.bin').equals(big)) fail('big file content differs');
    if (zip.readCentral(outFile).filter(function (e) { return e.name === 'js/big.bin'; })[0].method !== 8) fail('big file was not copied over compressed');
    var grew = Math.round((peak - rssBefore) / 1024 / 1024);
    if (grew > 12) fail('signFile grew the process by ' + grew + ' MB for a 24 MB package; it should stream');
    [inFile, outFile].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    try { fs.rmdirSync(dir); } catch (e) {}
    console.log('PASS: signFile matches sign byte for byte, streams (' + grew + ' MB growth for a 24 MB package), keeps files compressed');
    process.exit(0);
});

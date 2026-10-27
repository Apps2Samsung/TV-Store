/* Minimal zip for the signer. Node's zlib does the inflate, so no npm dependency.
 * On the TV the signer works on files, never on a whole package in memory: a 41 MB package took the
 * service down on a Tizen 6 set while it held the download, every inflated file and the repacked
 * copy at once. readCentral lists a package on disk, entryStream inflates one entry as a stream (for
 * its digest), and writeFile copies entries over still compressed, 64 KiB at a time.
 * readEntries/write work on Buffers and are kept for the tests' fixtures. */
'use strict';
var Buf = require('./compat.js');
var zlib = require('zlib');

function readEntries(buf) {
    // Find the End Of Central Directory record, then walk the central directory.
    var eocd = -1;
    for (var i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error('not a zip (no EOCD)');
    var count = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
    var p = cdOff, out = [];
    for (var n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central dir header');
        var method = buf.readUInt16LE(p + 10), compSize = buf.readUInt32LE(p + 20), uncompSize = buf.readUInt32LE(p + 24);
        var nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commLen = buf.readUInt16LE(p + 32);
        var lho = buf.readUInt32LE(p + 42);
        var name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
        // Local header: recompute data start (its name/extra lengths can differ from the central dir's).
        var lhNameLen = buf.readUInt16LE(lho + 26), lhExtraLen = buf.readUInt16LE(lho + 28);
        var dataStart = lho + 30 + lhNameLen + lhExtraLen;
        var comp = buf.slice(dataStart, dataStart + compSize);
        var data = method === 0 ? comp : zlib.inflateRawSync(comp);
        if (data.length !== uncompSize) throw new Error('size mismatch for ' + name);
        out.push({ name: name, data: data, dir: name.charAt(name.length - 1) === '/' });
        p += 46 + nameLen + extraLen + commLen;
    }
    return out;
}

function crc32(buf) {
    var c, T = crc32.T || (crc32.T = (function () { var t = []; for (var n = 0; n < 256; n++) { c = n; for (var k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })());
    c = 0xFFFFFFFF; for (var i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// entries: [{name, data(Buffer)}], all STORED. Returns a Buffer (a valid .wgt).
function write(entries) {
    var locals = [], central = [], offset = 0;
    entries.forEach(function (e) {
        var nameBuf = Buf.from(e.name, 'utf8'), crc = crc32(e.data), size = e.data.length;
        var lh = Buf.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
        lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
        var localRec = Buffer.concat([lh, nameBuf, e.data]);
        var cd = Buf.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
        cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(size, 20); cd.writeUInt32LE(size, 24);
        cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34);
        cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([cd, nameBuf]));
        locals.push(localRec); offset += localRec.length;
    });
    var cdBuf = Buffer.concat(central), localBuf = Buffer.concat(locals);
    var eocd = Buf.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16); eocd.writeUInt16LE(0, 20);
    return Buffer.concat([localBuf, cdBuf, eocd]);
}

// ---- on disk ---------------------------------------------------------------------------------------
var fs = require('fs');
var CHUNK = 64 * 1024;

function readAt(fd, pos, len) { var b = Buf.alloc(len), n = 0; while (n < len) { var r = fs.readSync(fd, b, n, len - n, pos + n); if (!r) break; n += r; } return n === len ? b : b.slice(0, n); }

// The entries of the package at `file`: [{name, dir, method, flags, crc, compSize, uncompSize, dataStart}].
function readCentral(file) {
    var fd = fs.openSync(file, 'r');
    try {
        var size = fs.fstatSync(fd).size, tailLen = Math.min(size, 22 + 65535), tail = readAt(fd, size - tailLen, tailLen);
        var eocd = -1;
        for (var i = tail.length - 22; i >= 0; i--) { if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
        if (eocd < 0) throw new Error('not a zip (no EOCD)');
        var count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
        var cd = readAt(fd, cdOff, cdSize), p = 0, out = [];
        for (var n = 0; n < count; n++) {
            if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central dir header');
            var nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commLen = cd.readUInt16LE(p + 32);
            var e = { flags: cd.readUInt16LE(p + 8), method: cd.readUInt16LE(p + 10), crc: cd.readUInt32LE(p + 16),
                      compSize: cd.readUInt32LE(p + 20), uncompSize: cd.readUInt32LE(p + 24), name: cd.slice(p + 46, p + 46 + nameLen).toString('utf8') };
            if (e.method !== 0 && e.method !== 8) throw new Error('unsupported compression ' + e.method + ' for ' + e.name);
            // Local header: its name/extra lengths can differ from the central dir's.
            var lho = cd.readUInt32LE(p + 42), lh = readAt(fd, lho, 30);
            if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header for ' + e.name);
            e.dataStart = lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
            e.dir = e.name.charAt(e.name.length - 1) === '/';
            out.push(e);
            p += 46 + nameLen + extraLen + commLen;
        }
        return out;
    } finally { fs.closeSync(fd); }
}

// The uncompressed bytes of one entry, as a stream.
function entryStream(file, e) {
    if (!e.compSize) { var empty = new (require('stream').PassThrough)(); empty.end(); return empty; }
    var raw = fs.createReadStream(file, { start: e.dataStart, end: e.dataStart + e.compSize - 1, highWaterMark: CHUNK });
    if (e.method === 0) return raw;
    var inf = zlib.createInflateRaw();
    raw.on('error', function (err) { inf.emit('error', err); });
    return raw.pipe(inf);
}

// Writes a package to `outFile`. items: {name, data: Buffer} (stored as is) or {name, from: file, entry}
// (copied over still compressed, with the crc and sizes the source's central directory gives).
function writeFile(outFile, items) {
    var out = fs.openSync(outFile, 'w'), central = [], offset = 0;
    function put(b) { var n = 0; while (n < b.length) n += fs.writeSync(out, b, n, b.length - n, null); offset += b.length; }
    try {
        items.forEach(function (it) {
            var nameBuf = Buf.from(it.name, 'utf8'), e = it.entry, method, crc, comp, uncomp;
            if (e) { method = e.method; crc = e.crc; comp = e.compSize; uncomp = e.uncompSize; }
            else { method = 0; crc = crc32(it.data); comp = uncomp = it.data.length; }
            var flags = 0x0800;     // names are UTF-8; no data descriptor, the sizes are known up front
            var at = offset, lh = Buf.alloc(30);
            lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
            lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
            lh.writeUInt32LE(comp, 18); lh.writeUInt32LE(uncomp, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
            put(lh); put(nameBuf);
            if (e) {
                var src = fs.openSync(it.from, 'r');
                try { for (var p = 0; p < comp; p += CHUNK) { var b = readAt(src, e.dataStart + p, Math.min(CHUNK, comp - p)); if (!b.length) throw new Error('package ends inside ' + it.name); put(b); } }
                finally { fs.closeSync(src); }
            } else put(it.data);
            var cd = Buf.alloc(46);
            cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(method, 10);
            cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp, 20); cd.writeUInt32LE(uncomp, 24);
            cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34);
            cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(at, 42);
            central.push(Buffer.concat([cd, nameBuf]));
        });
        var cdBuf = Buffer.concat(central), cdAt = offset, eocd = Buf.alloc(22);
        put(cdBuf);
        eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(items.length, 8); eocd.writeUInt16LE(items.length, 10);
        eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(cdAt, 16); eocd.writeUInt16LE(0, 20);
        put(eocd);
    } finally { fs.closeSync(out); }
}

module.exports = { readEntries: readEntries, write: write, crc32: crc32, readCentral: readCentral, entryStream: entryStream, writeFile: writeFile, readAt: readAt };

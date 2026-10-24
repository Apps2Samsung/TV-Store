/* Minimal zip for the signer: read (list + inflate entries) and write (STORED). Node's zlib does the
 * inflate, so no npm dependency. The signer digests decompressed content (compression-independent) and
 * writes a STORED package, which Tizen installs fine (the debug agent ships STORED too). */
'use strict';
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
        var nameBuf = Buffer.from(e.name, 'utf8'), crc = crc32(e.data), size = e.data.length;
        var lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
        lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
        var localRec = Buffer.concat([lh, nameBuf, e.data]);
        var cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
        cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(size, 20); cd.writeUInt32LE(size, 24);
        cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34);
        cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([cd, nameBuf]));
        locals.push(localRec); offset += localRec.length;
    });
    var cdBuf = Buffer.concat(central), localBuf = Buffer.concat(locals);
    var eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16); eocd.writeUInt16LE(0, 20);
    return Buffer.concat([localBuf, cdBuf, eocd]);
}

module.exports = { readEntries: readEntries, write: write, crc32: crc32 };

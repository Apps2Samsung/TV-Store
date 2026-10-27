'use strict';
var fake = require('./fake-sdbd.js');
var sdb = require('../tizen-app/service/sdb.js');
var crypto = require('crypto');
var PORT = 26191;
var fileBytes = crypto.randomBytes(200000);   // ~200 KB, spans many sync chunks
var installCmdSeen = null;
var WD = setTimeout(function(){ console.error('FAIL: watchdog timeout (8s)'); process.exit(3); }, 8000);

fake.start(PORT, {
    shell: function (cmd) { if (cmd.indexOf('vd_appinstall') >= 0) { installCmdSeen = cmd; return 'spend time for wascmd is [12]ms\nappInstall return : [0]\n'; } return 'unknown\n'; }
}, function (h) {
    var c = new sdb.SdbClient('127.0.0.1', PORT);
    c.connect(function (err) {
        if (err) return done(err);
        var remote = '/home/owner/share/tmp/sdk_tools/TVStoreTest.wgt';
        // The service pushes from a file through a { size, read } source; push that way here too.
        c.push(remote, { size: fileBytes.length, read: function (off, len) { return fileBytes.slice(off, off + len); } }, function (err) {
            if (err) return done(err);
            var got = h.received[remote];
            if (!got) return done(new Error('fake sdbd never received the file'));
            if (got.length !== fileBytes.length || !got.equals(fileBytes)) return done(new Error('pushed bytes differ: got ' + got.length + ' of ' + fileBytes.length));
            c.shell('0 vd_appinstall A2SProbe01 ' + remote, function (err, out) {
                if (err) return done(err);
                done(null, { pushedBytes: got.length, intact: true, installCmdSeen: installCmdSeen, installReply: out.trim() });
            });
        });
    });
    function done(err, res) {
        clearTimeout(WD); c.end(); h.server.close();
        if (err) { console.error('FAIL:', err.message); process.exit(1); }
        console.log('PASS');
        console.log('  pushed+verified bytes:', res.pushedBytes);
        console.log('  install command seen :', res.installCmdSeen);
        console.log('  install reply        :', JSON.stringify(res.installReply));
        process.exit(0);
    }
});

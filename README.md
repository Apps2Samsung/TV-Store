# Apps2Samsung TV-Store

Install Apps2Samsung catalog apps **natively, from the TV itself** — no PC or phone in the loop after
first setup. A Tizen web app with a background Node service that acts as the TV's own "host PC":
it connects to the set's own `sdbd`, pushes a package and runs `0 vd_appinstall`, so the app lands
in the Apps row like one installed from a laptop. Part of [Apps2Samsung#844](https://github.com/Apps2Samsung/Apps2Samsung/issues/844).

## Why this works (and why it's the only way)
A web app our certificates sign can't call `tizen.package.install` (platform privilege), and Samsung
won't issue a platform certificate to a normal account (`svdca` returns code 203 — tested). The one
installer our Public/Partner certificates reach is `sdbd` on port 26101. A `.wgt` sandbox can't open a
raw socket, but a `<tizen:service>` Node component can (proven on retail by the tessel SMB proxy).
Phase-0 probe result: **`sdbd` accepts a connection from the TV's own LAN IP, with no key auth**, once
Developer Mode's Host PC IP is set to the TV's own address.

## Layout
- `tizen-app/` — the package (`config.xml`, `index.html`, `js/app.js`, `icon.png`, `service/`).
- `tizen-app/service/sdb.js` — the SDB client (CNXN, OPEN/OKAY/WRTE/CLSE, `shell:`, `sync:` push), ported from TizenSdb.Core.
- `tizen-app/service/index.js` — loopback HTTP control plane + the install pipeline (download → sign → push → `vd_appinstall`).
- `tizen-app/service/signer.js` — the .wgt signer. **Not finished** (see Status); the install flow surfaces that rather than pushing an unsigned package.
- `test/` — a fake `sdbd` and an end-to-end test of connect + push + install over the real `sdb.js`.

## Status
| Piece | State |
|---|---|
| sdbd accepts a TV-side connection | proven on retail (phase 0) |
| SDB client: connect, push, `vd_appinstall` | done, proven against a fake sdbd (`node test/run.js`) |
| Catalog UI from `resolved.json` | done |
| Service control plane (`/ping`, `/catalog`, `/install`) | done, smoke-tested |
| On-TV package signing | **done** — full W3C XML-DSig ported to Node (`service/signer.js`), output **byte-for-byte identical** to TizenSdb.Core's C# signer on the same input/keys (verified during the port); self-contained test in `test/sign.test.js` |
| Certificate hand-over from a head | endpoint ready (`POST /cert` takes author/distributor key+cert as **PEM**); a head still needs to call it (it holds the decrypted material) |

Install now downloads, signs (once a head has handed over the certificate via `POST /cert`), pushes and runs `vd_appinstall`. Without a certificate yet, it reports that cleanly. The one thing not exercised off-TV is the final `vd_appinstall` on real hardware.

## Build
A `.wgt` is just a zip of `tizen-app/` with `config.xml` at the root (no Tizen Studio needed):
```sh
scripts/build-wgt.sh        # -> dist/TV-Store.wgt
```
Install it with Apps2Samsung ("Your own package", or `apps2samsung-cli install dist/TV-Store.wgt --tv <ip>`),
which signs it with your certificate as it installs. On the TV, set Developer Mode's Host PC IP to the
TV's own IP so its sdbd accepts the service's connection.

## Test
```sh
node test/run.js            # connect + 200 KB push (verified intact) + vd_appinstall, against a fake sdbd
```

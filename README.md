# Apps2Samsung TV-Store

The Apps2Samsung catalog on the TV itself. Browse with the remote, press OK, and the app installs
as a real Tizen package, straight into the Apps row. No PC or phone in the loop after a one-time
setup.

![Home](docs/design/C1-home.png)

## How it looks

The screens below are the design the app is built towards. Dark glass, the Apps2Samsung category
colours, big tiles for a couch.

| | |
|---|---|
| ![App sheet](docs/design/C2-app-sheet.png) The app, its variants, one button. | ![Installing](docs/design/C3-installing.png) Download, sign, install: four steps you can watch or walk away from. |
| ![Done](docs/design/C4-done.png) Done, with Open right there. | ![On the TV](docs/design/C6-on-the-tv.png) Your apps, updates first. |

![First run](docs/design/C5-first-run.png)

The first time, the TV asks to be armed: open the Toolbox in Apps2Samsung on your phone or PC and
press **Arm TV-Store**. That hands over your signing certificate once; from then on the TV signs
and installs on its own.

## How it works

A Samsung TV only installs sideloaded packages through its developer connection (`sdbd`), the
same door Apps2Samsung uses from a PC. TV-Store is a web app with a small background service that
acts as the TV's own PC:

1. downloads the package from the catalog,
2. signs it on the TV with your certificate (the same signatures Apps2Samsung makes),
3. pushes it to the TV's own `sdbd` and installs it.

For that, Developer Mode's **Host PC IP** on the TV must be set to the TV's own address.

Some catalog apps need settings written into the package before they install (a server address,
an API key). The TV cannot do that yet, so those are shown greyed with a "Phone or PC" badge and
install from Apps2Samsung on a phone or PC instead.

## Layout

- `tizen-app/` – the package: `config.xml`, `index.html`, `js/app.js`, `icon.png`, `service/`
- `tizen-app/service/index.js` – the service: catalog, certificate, install pipeline
- `tizen-app/service/sdb.js` – the SDB client (connect, push, install)
- `tizen-app/service/signer.js` – the package signer
- `tizen-app/js/app.js` – the UI, and `window.A2SStore`, which Apps2Samsung calls to arm the TV
- `test/` – a fake `sdbd` plus signer and transport tests
- `docs/design/` – the screens above

## Build, test, release

A `.wgt` is a zip of `tizen-app/`; no Tizen Studio needed.

```sh
scripts/build-wgt.sh        # -> dist/TV-Store.wgt
node test/run.js            # connect + push + install against a fake sdbd
node test/sign.test.js      # the signer, with a certificate chain
```

Install the `.wgt` with Apps2Samsung like any package. A `vX.Y.Z` tag (matching the version in
`config.xml`) publishes a GitHub release with `TV-Store.wgt` as its one asset.

## Status

| Piece | State |
|---|---|
| Install through the TV's own `sdbd` | proven on a retail set |
| Signing on the TV | done, identical output to the Apps2Samsung signer |
| Arming from Apps2Samsung (phone, PC, CLI) | done |
| The screens above | designed, being built |
| First real install from the TV | next |

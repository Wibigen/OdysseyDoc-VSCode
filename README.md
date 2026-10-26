# OdysseyDoc — VS Code extension

The **[OdysseyDoc](https://wibigen.github.io/OdysseyDoc/)** documentation (Super Mario Odyssey 1.0.0 decomp + Ghidra pseudo-code) right inside VS Code, together with exlaunch modding tools ([SMO-Exlaunch-Base](https://github.com/Fuzzy2319/SMO-Exlaunch-Base)).

*Made by WibiDev*

## Everything comes from the site

The extension ships no data: it reads the `data/` files published by the OdysseyDoc site — exactly the ones your browser loads.

| Site data | Used for |
|---|---|
| `data/index.js` (106,891 entities, 74,171 addresses) | search, hovers, tree, CodeLens, diagnostics |
| `data/e/<n>.js` (details) | clang signatures, return types, parameters, calls / callers, fields with offsets, bases, hook safety |
| `data/src/<n>.js` | decomp sources (declaration / definition at the right line) |
| `data/gh/<n>.js` | Ghidra pseudo-code |
| `data/strings.js`, `data/symbols.js` | `.rodata` strings and data symbols |

- **Loading**: the index (7 MB) is downloaded once and cached. On startup the extension uses the cache, then checks in the background (ETag) whether the site was regenerated.
- **Details, sources and pseudo-code**: downloaded on demand and cached per revision (`decomp_rev` / `ghidra_rev`), so a new site build invalidates the cache automatically.
- **Offline, or to test a regenerated site**: point `odysseydoc.localSitePath` to a local clone of `wibigen.github.io`.
- **Commands**: *OdysseyDoc: Reload the site data* / *Clear the site data cache*.

## Features

### Hover and navigation
- **Function**: full signature (qualified types), status, offset(s), size, hook safety, mangled symbol and `#include`, followed by a preview of the **decomp** then the **Ghidra pseudo-code**, and *Decomp · Ghidra · Hook · Details · Site · Copy* links.
- **Class / struct / enum**: size, bases, and the declaration taken from the decomp.
- **`"_Z…"` symbol or `0x…` offset** (in an `InstallAt…` or a patch): the targeted function or data, with the delta. `.rodata` string text is shown too.
- Identification is exact when **clangd** is installed. Without clangd the extension falls back to the qualified name, the enclosing class or the short name, and picks between overloads by argument count and types.
- **F12 in pseudo-code or in a decomp source** opens the called function.
- **Search** (`Ctrl+Alt+Shift+F`): name, qualified name, offset, `0x71…` address or Ghidra address (`.text::002d2d48`). Same ranking as on the site.

### Details panel (`Ctrl+Alt+Shift+I`)
A panel inside VS Code with:
- addresses (offset / Ghidra / absolute);
- declaration and definition (with GitHub links);
- tabs **OdysseyDecomp** (default; switches to Ghidra when the function isn't written yet), **Ghidra pseudo-code**, **Calls** (calls / called by / overrides), **Fields & members** (offsets, types, methods, derived classes) and **Hook safety**;
- buttons to generate a hook (trampoline / replace / inline) or open the page on the site.

### Ghidra pseudo-code
- Opens in a read-only C++ tab.
- Addresses are annotated: strings (`0x192b1e5 "GetShine"`), functions (`FUN_… al::setNerve`) and data.
- **Fields too**: `this + 0x2e0` gets the field name, from the class offsets published on the site.

### exlaunch hooks
`Ctrl+Alt+Shift+H` generates the struct and the install line from the site data:
- **Signature**: return and parameter types come from clang (exact, qualified), with parameter names. If the function isn't decompiled, the type comes from Ghidra and is flagged with `⚠`.
- **Safety warnings** from the site: function too short, thunk, loop back to the entry, PC-relative instructions.
- **Insertion**: the `InstallAtSymbol` (or `InstallAtOffset`) line goes into `exl_main`, and the class `#include` is added.

### Checks in your code
- **CodeLens** above every `InstallAtSymbol` / `InstallAtOffset` / `CodePatcher`.
- **Diagnostics**:
  - symbol not found in the binary, with a quick fix (e.g. `_ZN5Shine5isGotEv` → `_ZNK5Shine5isGotEv`);
  - misaligned offset;
  - offset in the middle of a function;
  - offset that lands on data.
- **Side views**:
  - *Project hooks*: hooks never installed, targets not found;
  - *OdysseyDoc explorer*: the site tree (folders → files → classes → methods), filterable by status.

### Build, exlaunch base and deployment
- **exlaunch base**: locate it once (*OdysseyDoc: Locate the exlaunch base*). Your `.cpp` can then live anywhere.
- **F7 (quick build)**:
  1. copies the `.cpp` to `<base>/src/main.cpp` (replacing the old one, which is backed up), along with the local `.h` files it includes;
  2. runs `make` (through WSL on Windows);
  3. on error, the log stays in the console and errors are underlined in **your** `.cpp`;
  4. on success, `subsdk9` and `main.npdm` are copied next to the `.cpp`.
- **Deployment**: to a folder (Atmosphère SD, Ryujinx, yuzu and forks, exefs) or over FTP to the Switch.
- **Snippets**: `smo-hook-trampoline`, `smo-exe`, `smo-nerves`, `smo-actor-cpp`, …
- **clangd**: code completion setup with the devkitA64 headers, for a `.cpp` anywhere.

## Installation
Install `OdysseyDoc-v3.2.vsix` (*Extensions → … → Install from VSIX*). To rebuild after changing the code:
- **Windows**: `BUILD_VSIX.cmd`;
- **Linux / WSL**: `./BUILD_VSIX.sh`.

Requires Node.js LTS. The script leaves the `.vsix` next to itself and cleans up `dist/`, `out/` and `node_modules/`.

> The old *SMO Modding* extension is a duplicate: uninstall it. Settings are now named `odysseydoc.*`; in particular you need to locate the exlaunch base again.

## Main settings

| Setting | Purpose |
|---|---|
| `odysseydoc.siteUrl` | site the data comes from (default `https://wibigen.github.io/OdysseyDoc/`) |
| `odysseydoc.localSitePath` | local clone of the site (offline / testing) |
| `odysseydoc.exlaunchBase` | your exlaunch base |
| `odysseydoc.navigation.fromGhidra` | F12 in Ghidra: pseudo-code (`ghidra`) or decomp (`decomp`) |
| `odysseydoc.hooks.installMode` | `symbol` or `offset` |
| `odysseydoc.hover.previewLines` | size of the code preview in hovers |
| `odysseydoc.build.useWsl` / `wslDistro` / `env` | building on Windows |
| `odysseydoc.deploy.targets` | deploy targets |

## Code layout
```
src/core/site.ts      site data format (DOC.got), index, search, type qualification, hook safety
src/core/hookgen.ts   hook generation from the site details
src/core/scan.ts      finds hooks / patches in your code
src/core/…            build (gcc), compile_commands for clangd, FTP, WSL paths
src/state.ts          download + cache of the site data
src/resolver.ts       "what is under the cursor?"
src/hover.ts, fiche.ts, pseudo.ts, lens.ts, views.ts, hooks.ts, build.ts, base.ts, deploy.ts, clangd.ts
media/fiche.js|css    details panel
```
### Tests
- `npm test`: unit tests.
- `npm run test:site -- <path to a local OdysseyDoc clone>`: runs the details panel, hover signature, hook generator and webview on **every** entity of the site, to catch data-format errors.

MIT license.

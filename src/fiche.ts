import * as vscode from "vscode";
import { CLASS_KINDS, Detail, GHIDRA_BASE, hex, HOOK_LABEL, hookSafety, KIND_LABEL, MAIN_BASE, SiteIndex, STATUS_LABEL } from "./core/site";
import { HookKind } from "./core/hookgen";
import { currentCppEditor, generateHookCommand, insertInclude } from "./hooks";
import { frameworkFor } from "./env";
import { signature } from "./hover";
import { decompSnippet, openGhidra, openOnSite, openSource, stripPseudoHeader } from "./sources";
import { DocState } from "./state";

function nonce() {
    let s = "";
    const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
}

const ST_CLASS = ["none", "ok", "minor", "major", "nd"];
const LIST_MAX = 300;

/** Details panel for a site entity: signature, addresses, decomp + Ghidra code, calls, fields, hook safety. */
export class FichePanel {
    private static panel: vscode.WebviewPanel | undefined;
    private static current: number | undefined;
    private static history: number[] = [];

    static async show(st: DocState, id: number, fromHistory = false) {
        const ix = await st.ix();
        if (id < 0 || id >= ix.size) return;
        if (!fromHistory && this.current !== undefined && this.current !== id) this.history.push(this.current);
        this.current = id;
        if (!this.panel) {
            const media = vscode.Uri.joinPath(st.ctx.extensionUri, "media");
            this.panel = vscode.window.createWebviewPanel("odysseydocFiche", "OdysseyDoc", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
            this.panel.iconPath = vscode.Uri.joinPath(media, "icon.png");
            this.panel.onDidDispose(() => {
                this.panel = undefined;
                this.current = undefined;
                this.history = [];
            });
            this.panel.webview.onDidReceiveMessage((m) => this.onMessage(st, m));
            this.panel.webview.html = this.html(this.panel.webview, media);
        } else this.panel.reveal(undefined, true);
        this.panel.title = `OdysseyDoc · ${ix.name(id)}`;
        let d: Detail;
        try {
            d = await st.detail(id);
        } catch (e) {
            if (this.current === id) this.post({ type: "error", text: `Could not load ${ix.q(id)} from the site: ${e instanceof Error ? e.message : e}` });
            throw e;
        }
        if (this.current !== id) return;
        this.post({ type: "entity", data: this.entityData(st, ix, id, d), canBack: this.history.length > 0 });

        // code: OdysseyDecomp first, then Ghidra (async)
        decompSnippet(st, d)
            .then((r) => this.current === id && this.post(r ? { type: "decomp", ...r } : { type: "decomp", error: ix.isBinOnly(id) ? "Entity inferred from the binary: no source in the decomp." : "No source code for this entity." }))
            .catch((e) => this.current === id && this.post({ type: "decomp", error: String(e) }));
        const ghs = (d.bin || []).flatMap((b) => b.gh.map((g) => ({ off: b.off, path: g[0], sig: g[1] })));
        if (ghs.length) {
            Promise.all(ghs.map(async (g) => ({ ...g, offHex: hex(g.off), text: stripPseudoHeader(await st.ghidra(id, g.path)) })))
                .then((list) => this.current === id && this.post({ type: "ghidra", list }))
                .catch((e) => this.current === id && this.post({ type: "ghidra", error: String(e) }));
        } else this.post({ type: "ghidra", error: ix.isFn(id) ? "No Ghidra pseudo-code (function without an address, or inlined)." : "Pseudo-code only exists for functions." });
    }

    private static post(m: unknown) {
        this.panel?.webview.postMessage(m);
    }

    private static ref(ix: SiteIndex, i: number) {
        return { id: i, q: ix.q(i), st: ST_CLASS[ix.status(i)] ?? "none", fn: ix.isFn(i), off: ix.offsets(i)[0] !== undefined ? hex(ix.offsets(i)[0]) : "" };
    }

    private static entityData(st: DocState, ix: SiteIndex, i: number, d: Detail) {
        const k = ix.kind(i);
        const refs = (ids: number[] | undefined) => {
            const all = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === "number" && x >= 0 && x < ix.size);
            return { list: all.slice(0, LIST_MAX).map((x) => this.ref(ix, x)), more: Math.max(0, all.length - LIST_MAX) };
        };
        const p = ix.parent(i);
        const isType = CLASS_KINDS.has(k) || k === "enum";
        const members = isType
            ? ix
                  .children(i)
                  .filter((c) => ix.isFn(c))
                  .map((c) => this.ref(ix, c))
            : [];
        return {
            id: i,
            kind: k,
            framework: frameworkFor(currentCppEditor()?.document.getText()),
            kindLabel: KIND_LABEL[k] ?? k,
            q: ix.q(i),
            sig: signature(ix, i, d),
            isFn: ix.isFn(i),
            isType,
            status: STATUS_LABEL[ix.status(i)],
            st: ST_CLASS[ix.status(i)] ?? "none",
            binOnly: ix.isBinOnly(i),
            bins: (d.bin || []).map((b) => {
                const r = hookSafety(b);
                return {
                    off: hex(b.off), ghidra: hex(b.off + GHIDRA_BASE), abs: hex(MAIN_BASE + b.off), sz: b.sz, st: b.st, obj: b.obj, thunk: !!b.thunk, lab: b.lab,
                    near: r.near, far: r.far, nearLabel: HOOK_LABEL[r.near], farLabel: HOOK_LABEL[r.far], issues: r.issues, checked: r.checked,
                    ins: b.hk?.i ?? [],
                };
            }),
            mangled: (d.bin || [])[0]?.lab.find((l) => l.startsWith("_Z")) ?? d.mangled ?? "",
            include: ix.includeFor(d.decl?.f),
            decl: d.decl ? { f: d.decl.f, l: d.decl.l, url: ix.githubUrl(d.decl.f, d.decl.l, d.decl.end) } : null,
            def: d.def ? { f: d.def.f, l: d.def.l, url: ix.githubUrl(d.def.f, d.def.l, d.def.end) } : null,
            rsrc: d.rsrc ?? "",
            gret: d.gret ?? "",
            cm: d.cm ?? "",
            parent: p !== null && ix.kind(p) !== "unit" ? this.ref(ix, p) : null,
            calls: refs(d.calls),
            callers: refs(d.callers),
            callsAmb: (Array.isArray(d.callsAmb) ? d.callsAmb : [])
                .slice(0, 50)
                .map((g) => (Array.isArray(g) ? g : [g]).filter((x) => typeof x === "number" && x >= 0 && x < ix.size).map((x) => this.ref(ix, x)))
                .filter((g) => g.length),
            callersAmb: refs(Array.isArray(d.callersAmb) ? d.callersAmb.flat() : []),
            overrides: refs(d.overrides),
            overby: refs(d.overby),
            size: d.size ?? null,
            bases: (d.bases || []).map((b) => ({ q: b[0], acc: b[1], virt: b[2], id: b[3] })),
            derived: refs(d.derived),
            fields: (d.fields || []).map((f) => ({ n: f.n, t: f.t, off: f.off, sz: f.sz, acc: f.acc ?? "", cm: f.cm ?? "", ti: f.ti ?? null })),
            values: d.values ?? [],
            nerves: d.nerves ?? [],
            members,
            underlying: d.underlying ?? d.type ?? "",
        };
    }

    private static async onMessage(st: DocState, m: { cmd: string; [k: string]: unknown }) {
        const id = this.current;
        if (id === undefined) return;
        switch (m.cmd) {
            case "copy":
                await vscode.env.clipboard.writeText(String(m.text));
                vscode.window.setStatusBarMessage(`Copied: ${m.text}`, 2500);
                break;
            case "hook":
                await generateHookCommand(st, id, m.kind as HookKind);
                break;
            case "ghidra":
                await openGhidra(st, id, false);
                break;
            case "source":
                await openSource(st, id, false);
                break;
            case "site":
                await openOnSite(st, id);
                break;
            case "url":
                await vscode.env.openExternal(vscode.Uri.parse(String(m.url)));
                break;
            case "include":
                await insertInclude(String(m.inc));
                break;
            case "show":
                await this.show(st, Number(m.id));
                break;
            case "back": {
                const prev = this.history.pop();
                if (prev !== undefined) await this.show(st, prev, true);
                break;
            }
            case "search":
                await vscode.commands.executeCommand("odysseydoc.searchFunction");
                break;
        }
    }

    private static html(webview: vscode.Webview, media: vscode.Uri): string {
        const n = nonce();
        const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "fiche.css"));
        const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "fiche.js"));
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head><body>
<header>
  <div class="top"><button class="icon" id="back" title="Back">◀</button><div class="name" id="name">Loading…</div><button class="icon" id="search" title="Search">🔍</button></div>
  <div class="chips" id="chips"></div>
  <div class="rows" id="rows"></div>
  <div class="actions" id="actions"></div>
</header>
<div class="tabs" id="tabs"></div>
<div id="panes"></div>
<script nonce="${n}" src="${js}"></script>
</body></html>`;
    }
}

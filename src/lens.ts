import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { mangledNameParts, scanSource } from "./core/scan";
import { hex, SiteIndex, STATUS_EMOJI, STATUS_LABEL } from "./core/site";
import { gameModuleAlias, parseSym } from "./core/hakkun";
import { cfg, projectRoot } from "./env";
import { symDb, usesSail } from "./framework";
import { findByMangled } from "./resolver";
import { DocState } from "./state";

const SELECTOR: vscode.DocumentSelector = [
    { language: "cpp", scheme: "file" },
    { language: "c", scheme: "file" },
];
export const SYM_SELECTOR: vscode.DocumentSelector = [{ language: "hakkun-sym", scheme: "file" }];

/** Hakkun symbol refs whose target is not a function (vtables, guards...): no binary check. */
const NON_FN_SYMBOL = /^_Z(TV|TI|TS|GV|TT|TH|TW)/;
/** Methods whose symbol must be a function of main. */
const HK_FN_METHODS = new Set(["installAtSym", "writeBranchAtSym", "writeBranchLinkAtSym"]);

/** Candidates for an unknown symbol (same qualified name, different mangling: missing const, wrong types…). */
export async function suggestionsForSymbol(st: DocState, ix: SiteIndex, sym: string): Promise<{ id: number; mangled: string; dem: string }[]> {
    const q = sym.startsWith("_Z") ? mangledNameParts(sym).join("::") : sym.replace(/\(.*$/, "").trim();
    if (!q) return [];
    const ids = ix.findFn(q);
    const dm = await st.details(ids);
    const out: { id: number; mangled: string; dem: string }[] = [];
    for (const i of ids) {
        const d = dm.get(i)!;
        const m = (d.bin || []).flatMap((b) => b.lab).find((l) => l.startsWith("_Z")) ?? d.mangled;
        if (m && m !== sym) out.push({ id: i, mangled: m, dem: d.dem ?? ix.q(i) });
    }
    return out;
}

export class HookLensProvider implements vscode.CodeLensProvider {
    private _onChange = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onChange.event;

    constructor(private st: DocState) {
        st.onIndexChanged(() => this._onChange.fire());
    }

    refresh() {
        this._onChange.fire();
    }

    async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        if (!cfg<boolean>("codeLens.enabled", true)) return [];
        const ix = await this.st.ix();
        const { refs } = scanSource(doc.getText());
        const out: vscode.CodeLens[] = [];
        for (const r of refs) {
            const range = new vscode.Range(doc.positionAt(r.stmtStart), doc.positionAt(r.end));
            if (r.kind === "symbol") {
                if (r.sail && (!r.value.startsWith("_Z") || NON_FN_SYMBOL.test(r.value))) continue;
                const ids = await findByMangled(this.st, ix, r.value);
                if (ids.length) out.push(this.lens(range, ix, ids[0], 0));
                else out.push(new vscode.CodeLens(range, { title: "$(warning) symbol not found in the binary", command: "odysseydoc.searchFunction", arguments: [mangledNameParts(r.value).join("::") || r.value] }));
            } else if (r.num !== undefined && r.kind !== "ptr") {
                const f = ix.findByOffset(r.num);
                const data = f ? undefined : ix.findData(r.num);
                if (f) out.push(this.lens(range, ix, f.id, f.delta, f.base));
                else if (data) out.push(new vscode.CodeLens(range, { title: `$(symbol-variable) data ${data.dem}${data.delta ? ` + ${hex(data.delta)}` : ""}`, command: "" }));
                else out.push(new vscode.CodeLens(range, { title: `$(warning) ${hex(r.num)}: no known function at this offset`, command: "" }));
            }
        }
        return out;
    }

    private lens(range: vscode.Range, ix: SiteIndex, i: number, delta: number, base?: number): vscode.CodeLens {
        const off = base ?? ix.offsets(i)[0];
        return new vscode.CodeLens(range, {
            title: `$(symbol-method) ${ix.q(i)}${delta ? ` + ${hex(delta)}` : ""}${off !== undefined ? ` · ${hex(off)}` : ""} · ${STATUS_EMOJI[ix.status(i)]} ${STATUS_LABEL[ix.status(i)]}`,
            command: "odysseydoc.showFiche",
            arguments: [i],
            tooltip: "Open the OdysseyDoc details",
        });
    }
}

export class HookDiagnostics {
    readonly collection = vscode.languages.createDiagnosticCollection("odysseydoc-hooks");
    private timers = new Map<string, NodeJS.Timeout>();

    constructor(private st: DocState) {}

    schedule(doc: vscode.TextDocument) {
        if (doc.uri.scheme !== "file" || !/^(cpp|c|hakkun-sym)$/.test(doc.languageId)) return;
        const k = doc.uri.toString();
        clearTimeout(this.timers.get(k));
        this.timers.set(
            k,
            setTimeout(() => {
                this.timers.delete(k);
                this.check(doc).catch(() => undefined);
            }, 500),
        );
    }

    async check(doc: vscode.TextDocument) {
        if (!cfg<boolean>("diagnostics.checkHooks", true)) {
            this.collection.delete(doc.uri);
            return;
        }
        const ix = await this.st.ix();
        if (doc.languageId === "hakkun-sym") return this.checkSym(doc, ix);
        const { refs, defs } = scanSource(doc.getText());
        const kindOf = new Map(defs.map((d) => [d.name, d.kind]));
        const diags: vscode.Diagnostic[] = [];
        const root = projectRoot();
        const sail = refs.some((r) => r.sail) && root !== undefined && usesSail(root) && cfg<boolean>("diagnostics.checkSyms", true);
        const declared = sail ? symDb.declared(root!) : new Set<string>();
        const mk = (range: vscode.Range, msg: string, sev: vscode.DiagnosticSeverity, code?: string) => {
            const d = new vscode.Diagnostic(range, msg, sev);
            d.source = "OdysseyDoc";
            if (code) d.code = code;
            diags.push(d);
        };
        for (const r of refs) {
            const range = new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end));
            if (r.kind === "symbol" && r.sail) {
                // Hakkun: installAtSym<"..."> & co go through sail, which aborts at boot if the symbol is not in syms/
                if (sail && !declared.has(r.value)) {
                    mk(
                        range,
                        `"${r.value}" is not declared in syms/: Hakkun aborts at boot with "UnresolvedSymbol" (sail). Declare it in a .sym file.`,
                        vscode.DiagnosticSeverity.Warning,
                        "odysseydoc-hk-nosym",
                    );
                }
                if (!r.value.startsWith("_Z") || NON_FN_SYMBOL.test(r.value) || !HK_FN_METHODS.has(r.method) || declared.has(r.value)) continue;
                if ((await findByMangled(this.st, ix, r.value)).length) continue;
                const sugg = await suggestionsForSymbol(this.st, ix, r.value);
                mk(
                    range,
                    `Symbol "${r.value}" not found in SMO 1.0.0 main.${sugg.length ? ` Candidate: ${sugg[0].dem} → ${sugg[0].mangled}` : " Check the mangling (const, parameter types, namespace)."}`,
                    vscode.DiagnosticSeverity.Warning,
                    "odysseydoc-unknown-symbol",
                );
                continue;
            }
            if (r.kind === "symbol") {
                if ((await findByMangled(this.st, ix, r.value)).length) continue;
                const sugg = await suggestionsForSymbol(this.st, ix, r.value);
                mk(
                    range,
                    r.value.startsWith("_Z")
                        ? `Symbol "${r.value}" not found in the binary: the hook will fail (LookupSymbol).${sugg.length ? ` Candidate: ${sugg[0].dem} → ${sugg[0].mangled}` : ""}`
                        : `"${r.value}" is not a mangled symbol: InstallAtSymbol expects an Itanium name (_Z…).`,
                    vscode.DiagnosticSeverity.Warning,
                    "odysseydoc-unknown-symbol",
                );
            } else if (r.num !== undefined && (r.kind === "offset" || r.kind === "patch")) {
                const v = r.num;
                if (v % 4 !== 0) {
                    mk(range, `${hex(v)} is not 4-byte aligned: it is not an AArch64 instruction address.`, vscode.DiagnosticSeverity.Error);
                    continue;
                }
                const f = ix.findByOffset(v);
                if (!f) {
                    const data = ix.findData(v);
                    if (data && r.kind === "offset") mk(range, `${hex(v)} is data (${data.dem}), not code.`, vscode.DiagnosticSeverity.Warning);
                    else if (!data) mk(range, `${hex(v)} does not match any known function of main (SMO ${ix.meta.game ?? "1.0.0"}).`, vscode.DiagnosticSeverity.Information);
                    continue;
                }
                const kind = kindOf.get(r.hookName);
                if (r.method === "installAtMainOffset" && r.kind === "offset" && f.delta === 0 && cfg<boolean>("diagnostics.hakkunOffsetHint", true)) {
                    mk(range, `Offsets are only valid for SMO 1.0.0: installAtSym<"…">() works on every version that exports the symbol.`, vscode.DiagnosticSeverity.Hint);
                }
                if (r.kind === "offset" && f.delta !== 0 && (kind === "trampoline" || kind === "replace")) {
                    mk(range, `${hex(v)} falls inside ${ix.q(f.id)} (+${hex(f.delta)}): a ${kind} hook must target the start of the function (${hex(f.base)}).`, vscode.DiagnosticSeverity.Warning, "odysseydoc-mid-function");
                }
            }
        }
        this.collection.set(doc.uri, diags);
    }

    /** .sym files (sail): dynamic symbols of the game module must exist in SMO 1.0.0 main. */
    private async checkSym(doc: vscode.TextDocument, ix: SiteIndex) {
        const diags: vscode.Diagnostic[] = [];
        const root = projectRoot();
        let versionList: string | undefined;
        try {
            if (root) versionList = fs.readFileSync(path.join(root.fsPath, "config", "VersionList.sym"), "utf8");
        } catch {
            /* ignore */
        }
        if (path.basename(doc.fileName) === "VersionList.sym" || path.basename(doc.fileName) === "ModuleList.sym") return this.collection.set(doc.uri, []);
        const game = gameModuleAlias(versionList);
        for (const b of parseSym(doc.getText())) {
            if (b.module !== game || (b.versions.length && !b.versions.includes("100"))) continue;
            for (const e of b.entries) {
                const target = !e.value ? e.name : /^"(_Z[^"]*)"$/.exec(e.value)?.[1];
                if (!target || !target.startsWith("_Z") || NON_FN_SYMBOL.test(target)) continue;
                if ((await findByMangled(this.st, ix, target)).length) continue;
                if (ix.dataByMangledName(target)) continue;
                const sugg = await suggestionsForSymbol(this.st, ix, target);
                const d = new vscode.Diagnostic(
                    new vscode.Range(e.line, e.start, e.line, e.end),
                    `"${target}" is not a function of SMO 1.0.0 main: sail will abort with UnresolvedSymbol on 1.0.0.${sugg.length ? ` Candidate: ${sugg[0].dem} → ${sugg[0].mangled}` : ""}`,
                    vscode.DiagnosticSeverity.Warning,
                );
                d.source = "OdysseyDoc";
                d.code = "odysseydoc-unknown-symbol";
                diags.push(d);
            }
        }
        this.collection.set(doc.uri, diags);
    }
}

export class HookCodeActions implements vscode.CodeActionProvider {
    static readonly kinds = [vscode.CodeActionKind.QuickFix];

    constructor(private st: DocState) {}

    async provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): Promise<vscode.CodeAction[]> {
        const ix = this.st.ixIfLoaded;
        if (!ix) return [];
        const out: vscode.CodeAction[] = [];
        for (const d of ctx.diagnostics) {
            // linker: "undefined symbol: al::isPadHoldA(int)" -> declare it in syms/
            if (d.code === "odysseydoc-undefined-symbol" && usesSail()) {
                const m = /undefined symbol: (.+?)(?: — |$)/.exec(d.message);
                if (m) for (const c of (await symbolsForLinkerName(this.st, ix, m[1].trim())).slice(0, 5)) out.push(declareAction(c.mangled, c.dem, d, out.length === 0));
                continue;
            }
            if (d.source !== "OdysseyDoc") continue;
            const text = doc.getText(d.range);
            if (d.code === "odysseydoc-hk-nosym") {
                out.push(declareAction(text, undefined, d, true));
                continue;
            }
            if (d.code === "odysseydoc-unknown-symbol") {
                for (const s of (await suggestionsForSymbol(this.st, ix, text)).slice(0, 6)) {
                    const a = new vscode.CodeAction(`Replace with ${s.mangled}  (${s.dem})`, vscode.CodeActionKind.QuickFix);
                    a.edit = new vscode.WorkspaceEdit();
                    a.edit.replace(doc.uri, d.range, s.mangled);
                    a.diagnostics = [d];
                    a.isPreferred = out.length === 0;
                    out.push(a);
                }
                const s = new vscode.CodeAction("Search for the right function…", vscode.CodeActionKind.QuickFix);
                s.command = { command: "odysseydoc.searchFunction", title: "", arguments: [mangledNameParts(text).join("::") || text] };
                out.push(s);
            } else if (d.code === "odysseydoc-mid-function") {
                const f = ix.findByOffset(parseInt(text.replace(/'/g, ""), 16));
                if (f) {
                    const a = new vscode.CodeAction(`Target the start of ${ix.q(f.id)} (${hex(f.base)})`, vscode.CodeActionKind.QuickFix);
                    a.edit = new vscode.WorkspaceEdit();
                    a.edit.replace(doc.uri, d.range, hex(f.base));
                    a.diagnostics = [d];
                    out.push(a);
                }
            }
        }
        return out;
    }
}

function declareAction(sym: string, dem: string | undefined, d: vscode.Diagnostic, preferred: boolean): vscode.CodeAction {
    const a = new vscode.CodeAction(`Declare ${sym}${dem ? `  (${dem})` : ""} in syms/`, vscode.CodeActionKind.QuickFix);
    a.command = { command: "odysseydoc.addSymbolToSyms", title: "", arguments: [sym] };
    a.diagnostics = [d];
    a.isPreferred = preferred;
    return a;
}

/** Linker name (mangled, or demangled "al::isPadHoldA(int)") -> mangled symbols of main. */
export async function symbolsForLinkerName(st: DocState, ix: SiteIndex, name: string): Promise<{ mangled: string; dem: string; id: number }[]> {
    if (name.startsWith("_Z")) {
        const ids = await findByMangled(st, ix, name);
        return [{ mangled: name, dem: ids.length ? ix.q(ids[0]) : "", id: ids[0] ?? -1 }];
    }
    const norm = (s: string) => s.replace(/\s+/g, "").replace(/\bconst\b/g, "const");
    const qual = name.replace(/\(.*$/, "").trim();
    const ids = ix.findFn(qual);
    const dm = await st.details(ids);
    const all: { mangled: string; dem: string; id: number }[] = [];
    for (const i of ids) {
        const d = dm.get(i)!;
        const m = (d.bin || []).flatMap((b) => b.lab).find((l) => l.startsWith("_Z")) ?? d.mangled;
        if (m) all.push({ mangled: m, dem: d.dem ?? ix.q(i), id: i });
    }
    const exact = all.filter((c) => norm(c.dem) === norm(name));
    return exact.length ? exact : all;
}

export function registerLens(ctx: vscode.ExtensionContext, st: DocState) {
    const lens = new HookLensProvider(st);
    const diags = new HookDiagnostics(st);
    const symWatcher = vscode.workspace.createFileSystemWatcher("**/*.sym");
    const symChanged = () => symDb.changed();
    ctx.subscriptions.push(
        vscode.languages.registerCodeLensProvider(SELECTOR, lens),
        vscode.languages.registerCodeActionsProvider([...(SELECTOR as vscode.DocumentFilter[]), ...(SYM_SELECTOR as vscode.DocumentFilter[])], new HookCodeActions(st), {
            providedCodeActionKinds: HookCodeActions.kinds,
        }),
        symWatcher,
        symWatcher.onDidChange(symChanged),
        symWatcher.onDidCreate(symChanged),
        symWatcher.onDidDelete(symChanged),
        symDb.onChange(() => vscode.workspace.textDocuments.forEach((d) => diags.schedule(d))),
        vscode.workspace.onDidSaveTextDocument((d) => d.languageId === "hakkun-sym" && symChanged()),
        diags.collection,
        vscode.workspace.onDidOpenTextDocument((d) => diags.schedule(d)),
        vscode.workspace.onDidChangeTextDocument((e) => diags.schedule(e.document)),
        vscode.workspace.onDidCloseTextDocument((d) => diags.collection.delete(d.uri)),
        st.onIndexChanged(() => vscode.workspace.textDocuments.forEach((d) => diags.schedule(d))),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("odysseydoc")) {
                lens.refresh();
                vscode.workspace.textDocuments.forEach((d) => diags.schedule(d));
            }
        }),
    );
    vscode.workspace.textDocuments.forEach((d) => diags.schedule(d));
    return { lens, diags };
}

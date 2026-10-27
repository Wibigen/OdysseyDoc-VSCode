import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { generateHook, HookKind, InstallMode } from "./core/hookgen";
import { hex } from "./core/site";
import { cfg, frameworkFor, projectRoot } from "./env";
import { Framework } from "./core/hakkun";
import { addSymbolToSyms, ENTRY_RX, entryName, usesSail } from "./framework";
import { DocState } from "./state";
import { adaptIncludeStyle, topLevelLine } from "./core/insert";

let lastCpp: vscode.TextEditor | undefined;

/** Remembers the last C/C++ editor (the details webview steals activeTextEditor). */
export function trackCppEditors(ctx: vscode.ExtensionContext) {
    const upd = (ed: vscode.TextEditor | undefined) => {
        if (ed && ed.document.uri.scheme === "file" && /^(cpp|c)$/.test(ed.document.languageId)) lastCpp = ed;
    };
    upd(vscode.window.activeTextEditor);
    ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(upd));
}

export function currentCppEditor(): vscode.TextEditor | undefined {
    const a = vscode.window.activeTextEditor;
    if (a && a.document.uri.scheme === "file" && /^(cpp|c)$/.test(a.document.languageId)) return a;
    if (lastCpp && !lastCpp.document.isClosed && vscode.window.visibleTextEditors.some((v) => v.document === lastCpp!.document)) {
        return vscode.window.visibleTextEditors.find((v) => v.document === lastCpp!.document);
    }
    return undefined;
}

/** File of the base that contains the entry point (exl_main / hkMain). */
export async function findExlMainFile(): Promise<vscode.Uri | undefined> {
    const root = projectRoot();
    const pattern = root ? new vscode.RelativePattern(root, "src/**/*.{cpp,cc,cxx}") : "src/**/*.{cpp,cc,cxx}";
    const files = await vscode.workspace.findFiles(pattern, "**/build/**", 200);
    for (const f of files) {
        try {
            const t = fs.readFileSync(f.fsPath, "utf8");
            if (ENTRY_RX.test(t)) return f;
        } catch {
            /* ignore */
        }
    }
    return undefined;
}

/** Looks for the class header in include/ (OdysseyHeaders): "Item/Shine.h" -> include/game/Item/Shine.h */
export function headerExists(inc: string): boolean {
    const root = projectRoot();
    if (!root || !inc) return false;
    const incDir = path.join(root.fsPath, "include");
    if (!fs.existsSync(incDir)) return false;
    try {
        for (const sub of fs.readdirSync(incDir)) {
            if (fs.existsSync(path.join(incDir, sub, ...inc.split("/")))) return true;
        }
        if (fs.existsSync(path.join(incDir, ...inc.split("/")))) return true;
    } catch {
        /* ignore */
    }
    return false;
}

/** "Item/Shine.h" -> "\"Item/Shine.h\"" ; keeps <…> and "…" as is */
function normInc(inc: string): string {
    const t = inc.trim();
    return t.startsWith('"') || t.startsWith("<") ? t : `"${t}"`;
}

function includeEdit(doc: vscode.TextDocument, incSpec: string, edit: vscode.WorkspaceEdit): boolean {
    const text = doc.getText();
    const spec = adaptIncludeStyle(text, normInc(incSpec));
    const bare = spec.slice(1, -1);
    const tail = bare.replace(/^(al|game)\//, "");
    if (text.includes(`"${bare}"`) || text.includes(`<${bare}>`) || text.includes(`"${tail}"`) || text.includes(`/${tail}"`)) return false;
    let lastInc = -1;
    let pragma = -1;
    for (let i = 0; i < Math.min(doc.lineCount, 200); i++) {
        const l = doc.lineAt(i).text;
        if (/^\s*#\s*include\b/.test(l)) lastInc = i;
        if (/^\s*#\s*pragma\s+once/.test(l)) pragma = i;
    }
    const line = lastInc >= 0 ? lastInc + 1 : pragma >= 0 ? pragma + 1 : 0;
    edit.insert(doc.uri, new vscode.Position(line, 0), `#include ${spec}\n${lastInc < 0 ? "\n" : ""}`);
    return true;
}

export async function insertInclude(inc: string) {
    const ed = currentCppEditor();
    if (!ed) return;
    const edit = new vscode.WorkspaceEdit();
    if (!includeEdit(ed.document, inc, edit)) {
        vscode.window.setStatusBarMessage(`#include ${normInc(inc)} already present`, 3000);
        return;
    }
    await vscode.workspace.applyEdit(edit);
}

/** Where to put an install line in exl_main / hkMain. */
function exlMainInstallPosition(doc: vscode.TextDocument): { pos: vscode.Position; indent: string } | undefined {
    const text = doc.getText();
    const m = /\b(?:exl_main|hkMain)\s*\([^)]*\)\s*\{/.exec(text);
    if (!m) return undefined;
    const start = m.index + m[0].length;
    // end of exl_main
    let depth = 1;
    let end = -1;
    for (let i = start; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end < 0) return undefined;
    const body = text.slice(start, end);
    const bodyStartLine = doc.positionAt(start).line;
    const indentM = /\n([ \t]+)\S/.exec(body);
    const indent = indentM ? indentM[1] : "    ";
    // after the last existing hook install line, otherwise after exl::hook::Initialize()
    const lines = body.split("\n");
    let after = -1;
    lines.forEach((l, i) => {
        if (/exl::hook::Initialize\s*\(\s*\)\s*;/.test(l) || /::InstallAt\w+\s*\(/.test(l) || /INJECT_\w*HOOK/.test(l) || /[.>]\s*installAt\w+\s*[<(]/.test(l) || /\bwriteBranch(Link)?At\w+/.test(l)) after = i;
    });
    if (after >= 0) return { pos: new vscode.Position(bodyStartLine + after + 1, 0), indent };
    return { pos: doc.positionAt(end).with(undefined, 0), indent };
}

async function chooseKind(title: string, fw: Framework, preset?: HookKind): Promise<HookKind | undefined> {
    if (preset && !(fw === "hakkun" && preset === "inline")) return preset;
    if (preset) vscode.window.showInformationMessage("Hakkun has no inline (register context) hook: pick a trampoline or a replace hook.");
    const def = cfg<HookKind>("hooks.defaultKind", "trampoline");
    if (!preset && !cfg<boolean>("hooks.askKind", true)) return fw === "hakkun" && def === "inline" ? "trampoline" : def;
    const items = [
        { label: "$(debug-step-into) Trampoline", description: `runs your code, then the original (${fw === "hakkun" ? "orig" : "Orig"})`, hk: "trampoline" as HookKind },
        { label: "$(replace) Replace", description: "replaces the function entirely", hk: "replace" as HookKind },
    ];
    if (fw === "exlaunch") items.push({ label: "$(debug-breakpoint-log) Inline", description: "runs at a specific instruction (registers)", hk: "inline" as HookKind });
    const pick = await vscode.window.showQuickPick(items, { title: `Hook for ${title}`, placeHolder: fw === "hakkun" ? "Hakkun hook type (HkTrampoline / HkReplace)" : "exlaunch hook type" });
    return pick?.hk;
}

export async function generateHookCommand(st: DocState, id: number, preset?: HookKind) {
    const ix = await st.ix();
    const d = await st.detail(id);
    if (!(d.bin || []).length) {
        vscode.window.showWarningMessage(`${ix.q(id)} has no address in the binary (inlined or not instantiated): it cannot be hooked.`);
        return;
    }
    const ed = currentCppEditor();
    const fw = frameworkFor(ed?.document.getText());
    const kind = await chooseKind(ix.q(id), fw, preset);
    if (!kind) return;
    const install = cfg<InstallMode>("hooks.installMode", "symbol");
    const r = generateHook(ix, id, d, { kind, install, framework: fw });
    const mode = cfg<string>("hooks.insertLocation", "auto");
    const entry = entryName(fw);
    const symMsg = declareSymbol(r.symbol, r.declPath);

    if (mode === "clipboard") {
        await vscode.env.clipboard.writeText(r.headers.map((h) => `#include "${h}"\n`).join("") + r.code + `\n// in ${entry}():\n` + r.install + "\n");
        vscode.window.showInformationMessage(`Hook ${r.name} copied to the clipboard.${symMsg}`);
        return;
    }

    const edIsCpp = !!ed && !/\.(h|hpp)$/.test(ed.document.fileName);
    const mainUri = await findExlMainFile();
    let targetDoc: vscode.TextDocument;
    let structPos: vscode.Position;
    if (edIsCpp && mode !== "beforeExlMain") {
        targetDoc = ed!.document;
        let l = ed!.selection.active.line;
        // never in the middle of the #includes: after the last one
        let lastInc = -1;
        for (let k = 0; k < Math.min(targetDoc.lineCount, 300); k++) if (/^\s*#\s*(include|pragma)\b/.test(targetDoc.lineAt(k).text)) lastInc = k;
        if (l <= lastInc) l = lastInc + 1;
        // never inside a function / lambda / class body: before the enclosing top-level declaration
        l = Math.max(lastInc + 1, topLevelLine(targetDoc.getText(), l));
        structPos = new vscode.Position(l, 0);
        const mainHere = /^.*\b(?:exl_main|hkMain)\s*\(/m.exec(targetDoc.getText());
        if (mainHere && mode !== "cursor") {
            // cursor inside / after exl_main: the struct goes right before exl_main
            const mainLine = targetDoc.positionAt(mainHere.index).line;
            if (l >= mainLine) structPos = new vscode.Position(mainLine, 0);
        }
    } else {
        if (!mainUri) {
            const doc = await vscode.workspace.openTextDocument({ language: "cpp", content: r.headers.map((h) => `#include "${h}"\n`).join("") + r.code + `\n// in ${entry}():\n// ` + r.install + "\n" });
            await vscode.window.showTextDocument(doc);
            return;
        }
        targetDoc = await vscode.workspace.openTextDocument(mainUri);
        const m = /^.*\b(?:exl_main|hkMain)\s*\(/m.exec(targetDoc.getText());
        structPos = m ? targetDoc.positionAt(m.index) : new vscode.Position(targetDoc.lineCount, 0);
    }

    // a hook with the same name already exists: hookName2, hookName3…
    const existing = targetDoc.getText();
    if (new RegExp(`\\b${r.name}\\b`).test(existing)) {
        let n = 2;
        while (new RegExp(`\\b${r.name}${n}\\b`).test(existing)) n++;
        const rx = new RegExp(`\\b${r.name}\\b`, "g");
        r.code = r.code.replace(rx, r.name + n);
        r.install = r.install.replace(rx, r.name + n);
        r.name = r.name + n;
    }
    const edit = new vscode.WorkspaceEdit();
    const inc = r.include;
    for (const h of r.headers) includeEdit(targetDoc, `"${h}"`, edit);
    if (cfg<boolean>("hooks.addInclude", true) && inc && (inc.startsWith("<") || headerExists(inc.slice(1, -1)))) includeEdit(targetDoc, inc, edit);
    const prevBlank = structPos.line === 0 || targetDoc.lineAt(structPos.line - 1).isEmptyOrWhitespace;
    const nextBlank = structPos.line >= targetDoc.lineCount || targetDoc.lineAt(structPos.line).isEmptyOrWhitespace;
    edit.insert(targetDoc.uri, structPos, (prevBlank ? "" : "\n") + r.code + (nextBlank ? "" : "\n"));

    let installedIn = "";
    const sameFileMain = ENTRY_RX.test(targetDoc.getText());
    if (sameFileMain) {
        const ip = exlMainInstallPosition(targetDoc);
        if (ip) {
            edit.insert(targetDoc.uri, ip.pos, `${ip.indent}${r.install}\n`);
            installedIn = path.basename(targetDoc.fileName);
        }
    }
    await vscode.workspace.applyEdit(edit);
    const shown = await vscode.window.showTextDocument(targetDoc, { preview: false, viewColumn: edIsCpp && ed!.document === targetDoc ? ed!.viewColumn : vscode.ViewColumn.One });
    // select the hook name
    const txt = targetDoc.getText();
    const ix0 = r.framework === "hakkun" ? txt.search(new RegExp(`\\b${r.name}\\s*=`)) : txt.indexOf(`(${r.name})`);
    const nameAt = ix0 < 0 ? -1 : r.framework === "hakkun" ? ix0 : ix0 + 1;
    if (nameAt >= 0) {
        const p0 = targetDoc.positionAt(nameAt);
        const p1 = targetDoc.positionAt(nameAt + r.name.length);
        shown.selection = new vscode.Selection(p0, p1);
        shown.revealRange(new vscode.Range(p0, p1), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    if (!installedIn) {
        await vscode.env.clipboard.writeText(r.install);
        vscode.window.showInformationMessage(`Hook ${r.name} inserted. The install line is in the clipboard: call it from ${entry}().${symMsg}`);
    } else {
        const warn = r.notes.length ? ` ⚠ ${r.notes[0]}` : "";
        vscode.window.setStatusBarMessage(`$(zap) ${r.name} → ${ix.q(id)} (${hex(d.bin![0].off)}), installed in ${installedIn}.${warn}`, 6000);
        if (r.notes.length) vscode.window.showWarningMessage(`${r.name}: ${r.notes.join(" · ")}${symMsg}`);
        else if (symMsg) vscode.window.showInformationMessage(symMsg.trim());
    }
}

/** Hakkun + sail: declares the hooked symbol in the base's syms/ (returns a message to show, or ""). */
function declareSymbol(sym: string | undefined, declPath: string | undefined): string {
    if (!sym || !usesSail() || !cfg<boolean>("hakkun.addSymbols", true)) return "";
    try {
        const rel = addSymbolToSyms(sym, declPath);
        return rel ? ` ${sym} declared in ${rel.split(path.sep).join("/")}.` : "";
    } catch (e) {
        return ` ⚠ could not write to syms/: ${e instanceof Error ? e.message : e}`;
    }
}

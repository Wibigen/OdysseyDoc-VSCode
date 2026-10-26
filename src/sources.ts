import * as vscode from "vscode";
import { Detail, hex, SiteIndex, STATUS_LABEL } from "./core/site";
import { cfg } from "./env";
import { DocState } from "./state";

export const GHIDRA_SCHEME = "odysseydoc-ghidra";
export const SRC_SCHEME = "odysseydoc-src";

/** Strips the header added by the Ghidra export (3 comment lines + the name comment). */
export function stripPseudoHeader(text: string): string {
    const lines = text.split("\n");
    let i = 0;
    while (i < lines.length && (lines[i].startsWith("//") || lines[i].trim() === "" || /^\/\*.*\*\/\s*$/.test(lines[i]))) i++;
    return lines.slice(i).join("\n");
}

/** Extracts lines [l, end] (1-based) of a site source file. */
export function sliceLines(text: string, l: number, end?: number, max = 400): string {
    const lines = text.split("\n");
    const a = Math.max(0, l - 1);
    const b = Math.min(lines.length, Math.max(a + 1, end ?? l), a + max);
    return lines.slice(a, b).join("\n");
}

/** The function's code in the decomp: definition (.cpp), else declaration. */
export async function decompSnippet(st: DocState, d: Detail): Promise<{ path: string; line: number; text: string; isDef: boolean } | undefined> {
    const loc = d.def ?? d.decl;
    if (!loc || loc.fi === undefined) return undefined;
    const text = await st.source(loc.fi);
    return { path: loc.f, line: loc.l, text: sliceLines(text, loc.l, loc.end), isDef: !!d.def };
}

/** Read-only virtual documents: odysseydoc-ghidra:/<id>/<n>/<name>.cpp and odysseydoc-src:/<fi>/<path> */
export class SiteDocProvider implements vscode.TextDocumentContentProvider {
    constructor(private st: DocState) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        try {
            const ix = await this.st.ix();
            if (uri.scheme === GHIDRA_SCHEME) {
                const [, idS, nS] = uri.path.split("/");
                const id = parseInt(idS, 10);
                const n = parseInt(nS, 10) || 0;
                const d = await this.st.detail(id);
                const gh = (d.bin || []).flatMap((b) => b.gh.map((g) => [b, g] as const))[n];
                if (!gh) return "// No Ghidra pseudo-code for this function.";
                const [b, [p]] = gh;
                const t = await this.st.ghidra(id, p);
                return (
                    `// ─── Ghidra pseudo-code (read-only, from OdysseyDoc) ───\n` +
                    `// ${d.dem ?? ix.q(id)}\n// offset ${hex(b.off)} · ${b.sz} bytes · ${b.st} · ${b.obj}\n` +
                    `// ${ix.meta.ghidra_repo}/${p}\n\n` +
                    t
                );
            }
            if (uri.scheme === SRC_SCHEME) {
                const fi = parseInt(uri.path.split("/")[1], 10);
                return await this.st.source(fi);
            }
        } catch (err) {
            return `// Could not fetch the file from OdysseyDoc:\n// ${String(err).replace(/\n/g, "\n// ")}`;
        }
        return "";
    }
}

export function ghidraUri(ix: SiteIndex, id: number, n = 0): vscode.Uri {
    const short = ix.name(id).replace(/[^\w~]+/g, "_").slice(0, 60) || "func";
    return vscode.Uri.from({ scheme: GHIDRA_SCHEME, path: `/${id}/${n}/${short}.cpp` });
}

export function srcUri(ix: SiteIndex, fi: number): vscode.Uri {
    return vscode.Uri.from({ scheme: SRC_SCHEME, path: `/${fi}/${ix.files[fi]?.[0] ?? "source"}` });
}

export async function openGhidra(st: DocState, id: number, beside = false) {
    const ix = await st.ix();
    const d = await st.detail(id);
    const has = (d.bin || []).some((b) => b.gh.length);
    if (!has) {
        vscode.window.showInformationMessage(`No Ghidra pseudo-code for ${ix.q(id)}.`);
        return;
    }
    const doc = await vscode.workspace.openTextDocument(ghidraUri(ix, id));
    await vscode.languages.setTextDocumentLanguage(doc, "cpp");
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: beside ? vscode.ViewColumn.Beside : undefined });
}

export async function openSource(st: DocState, id: number, beside = false) {
    const ix = await st.ix();
    const d = await st.detail(id);
    const loc = d.def ?? d.decl;
    if (!loc || loc.fi === undefined) {
        vscode.window.showInformationMessage(`${ix.q(id)} has no source in the decomp (inferred from the binary).`);
        return;
    }
    const doc = await vscode.workspace.openTextDocument(srcUri(ix, loc.fi));
    await vscode.languages.setTextDocumentLanguage(doc, "cpp");
    const pos = new vscode.Position(Math.max(0, loc.l - 1), 0);
    await vscode.window.showTextDocument(doc, { preview: true, selection: new vscode.Range(pos, pos), viewColumn: beside ? vscode.ViewColumn.Beside : undefined });
}

export async function openOnSite(st: DocState, id: number) {
    const ix = await st.ix();
    await vscode.env.openExternal(vscode.Uri.parse(st.pageUrl(ix, id)));
}

export function statusLabel(s: number) {
    return STATUS_LABEL[s] ?? "?";
}

export function besideDefault() {
    return cfg<boolean>("pseudo.openBeside", true);
}

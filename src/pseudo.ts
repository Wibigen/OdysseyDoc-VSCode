import * as vscode from "vscode";
import { GHIDRA_BASE } from "./core/site";
import { cfg } from "./env";
import { resolveAt } from "./resolver";
import { ghidraUri, GHIDRA_SCHEME, SRC_SCHEME, srcUri } from "./sources";
import { DocState } from "./state";

/**
 * F12 / Ctrl+click in Ghidra pseudo-code or in a decomp source:
 * opens the definition in the decomp if it exists, otherwise the pseudo-code of the called function.
 */
export class DocDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private st: DocState) {}

    async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Definition | undefined> {
        const own = doc.uri.scheme === GHIDRA_SCHEME || doc.uri.scheme === SRC_SCHEME;
        if (!own && !cfg<boolean>("navigation.definitionsInMyCode", false)) return undefined;
        const ix = await this.st.ix();
        const r = await resolveAt(doc, pos, this.st, { useClangd: false, allowShort: own, forceHex: own });
        if (!r || !r.ids.length) return undefined;
        const dm = await this.st.details(r.ids);
        const locs: vscode.Location[] = [];
        for (const i of r.ids) {
            const d = dm.get(i)!;
            const loc = d.def ?? d.decl;
            const preferGhidra = doc.uri.scheme === GHIDRA_SCHEME && cfg<string>("navigation.fromGhidra", "ghidra") === "ghidra";
            const hasGh = (d.bin || []).some((b) => b.gh.length);
            if (loc?.fi !== undefined && !(preferGhidra && hasGh)) locs.push(new vscode.Location(srcUri(ix, loc.fi), new vscode.Position(Math.max(0, loc.l - 1), 0)));
            else if (hasGh) locs.push(new vscode.Location(ghidraUri(ix, i), new vscode.Position(0, 0)));
        }
        return locs.length ? locs : undefined;
    }
}

/** .rodata string text next to pseudo-code addresses: (char *)0x192b1e5 "GetShine". */
export class GhidraInlayHints implements vscode.InlayHintsProvider {
    constructor(private st: DocState) {}

    async provideInlayHints(doc: vscode.TextDocument, range: vscode.Range): Promise<vscode.InlayHint[]> {
        if (!cfg<boolean>("pseudo.inlayStrings", true)) return [];
        const ix = await this.st.ix();
        const out: vscode.InlayHint[] = [];
        const text = doc.getText(range);
        const base = doc.offsetAt(range.start);
        const rx = /\b(0x[0-9a-fA-F]{6,10})\b|\b(?:thunk_)?FUN_([0-9a-fA-F]{6,10})\b/g;
        let m: RegExpExecArray | null;
        while ((m = rx.exec(text))) {
            const lineStart = text.lastIndexOf("\n", m.index) + 1;
            if (/^\s*(\/\/|\/\*)/.test(text.slice(lineStart, m.index))) continue;
            const off = parseInt(m[1] ?? m[2], 16) - GHIDRA_BASE;
            if (off <= 0) continue;
            const pos = doc.positionAt(base + m.index + m[0].length);
            let label: string | undefined;
            if (m[1]) {
                const s = ix.findString(off);
                if (s) {
                    let t = s.delta ? s.text.slice(s.delta) : s.text;
                    if (t.length > 48) t = t.slice(0, 47) + "…";
                    label = ` ${JSON.stringify(t)}`;
                } else {
                    const f = ix.findByOffset(off);
                    if (f && f.delta === 0) label = ` → ${ix.q(f.id)}`;
                    else {
                        const dsym = ix.findData(off);
                        if (dsym) label = ` ${dsym.dem}${dsym.delta ? `+0x${dsym.delta.toString(16)}` : ""}`;
                    }
                }
            } else {
                const f = ix.findByOffset(off);
                if (f) label = ` ${ix.q(f.id)}${f.delta ? `+0x${f.delta.toString(16)}` : ""}`;
            }
            if (label) {
                const h = new vscode.InlayHint(pos, label, vscode.InlayHintKind.Type);
                h.paddingLeft = true;
                out.push(h);
            }
        }
        return out;
    }
}

/** In pseudo-code, "this + 0x2e0": name of the field at that offset (from the class of this). */
export class FieldInlayHints implements vscode.InlayHintsProvider {
    constructor(private st: DocState) {}

    async provideInlayHints(doc: vscode.TextDocument, range: vscode.Range): Promise<vscode.InlayHint[]> {
        if (!cfg<boolean>("pseudo.inlayFields", true)) return [];
        const ix = await this.st.ix();
        const full = doc.getText();
        // class of this: "__thiscall Shine::exeGot(Shine *this"
        const tm = /__thiscall\s+([\w:<>]+)::~?\w+\s*\(\s*([\w:]+)\s*\*\s*this/.exec(full);
        if (!tm) return [];
        const cls = ix.findType(tm[1]) ?? ix.findType(tm[2]);
        if (cls === undefined) return [];
        const fields = await this.allFields(cls);
        if (!fields.length) return [];
        const out: vscode.InlayHint[] = [];
        const text = doc.getText(range);
        const base = doc.offsetAt(range.start);
        const rx = /\bthis\s*(?:\+\s*(0x[0-9a-fA-F]+|\d+)|\[\s*(0x[0-9a-fA-F]+|\d+)\s*\])/g;
        let m: RegExpExecArray | null;
        while ((m = rx.exec(text))) {
            const v = parseInt(m[1] ?? m[2], (m[1] ?? m[2]).startsWith("0x") ? 16 : 10);
            const f = fields.find((x) => v >= x.off && v < x.off + Math.max(1, x.sz));
            if (!f) continue;
            const h = new vscode.InlayHint(doc.positionAt(base + m.index + m[0].length), ` ${f.name}${v !== f.off ? `+${v - f.off}` : ""}`, vscode.InlayHintKind.Type);
            h.paddingLeft = true;
            h.tooltip = `${f.type} ${f.name} (offset 0x${f.off.toString(16)}, ${f.sz} bytes) — ${f.owner}`;
            out.push(h);
        }
        return out;
    }

    /** Fields of the class and its bases (absolute offsets, non-virtual primary base first). */
    private async allFields(cls: number, baseOff = 0, depth = 0): Promise<{ name: string; type: string; off: number; sz: number; owner: string }[]> {
        if (depth > 8) return [];
        const ix = await this.st.ix();
        const d = await this.st.detail(cls);
        const out: { name: string; type: string; off: number; sz: number; owner: string }[] = [];
        // bases: offsets are not in the data -> primary base at offset 0, the others are skipped
        const firstBase = (d.bases || []).find((b) => !b[2] && b[3] !== null);
        if (firstBase && firstBase[3] !== null) out.push(...(await this.allFields(firstBase[3], baseOff, depth + 1)));
        for (const f of d.fields || []) {
            if (f.off === null || f.off === undefined) continue;
            out.push({ name: f.n, type: f.t, off: baseOff + f.off, sz: f.sz ?? 1, owner: ix.q(cls) });
        }
        return out;
    }
}

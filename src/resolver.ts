import * as vscode from "vscode";
import { mangledNameParts } from "./core/scan";
import { Detail, GHIDRA_BASE, MAIN_BASE, SiteIndex, stripTpl } from "./core/site";
import { cfg } from "./env";
import { GHIDRA_SCHEME } from "./sources";
import { DocState } from "./state";

export interface Resolved {
    ids: number[];
    range: vscode.Range;
    how: "mangled" | "offset" | "qualified" | "clangd" | "context" | "short" | "definition" | "string" | "type" | "data";
    word: string;
    delta?: number;
    offset?: number;
    str?: { text: string; delta: number };
}

let insideClangdHover = false;
export function isResolvingViaClangd() {
    return insideClangdHover;
}

const HEX_CONTEXT = /InstallAt(Offset|Ptr)|installAt(MainOffset|Offset)|AtMainOffset|write(Ro|Rw)|GetTargetOffset|GetTargetStart|CodePatcher|RandomAccessPatcher|Patcher|patch|Offset|offset|0x71[0-9a-fA-F]{8}/;

export function splitParams(p: string): string[] {
    const out: string[] = [];
    let depth = 0,
        cur = "";
    for (const c of p) {
        if ("<([{".includes(c)) depth++;
        else if (">)]}".includes(c)) depth--;
        if (c === "," && depth === 0) {
            out.push(cur.trim());
            cur = "";
        } else cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

function baseTypeName(t: string): string {
    return (
        stripTpl(t)
            .replace(/\b(const|volatile|struct|class|enum|unsigned|signed)\b/g, "")
            .replace(/[*&\s]/g, "")
            .split("::")
            .pop() ?? ""
    ).toLowerCase();
}

function hoverText(h: vscode.Hover): string {
    return h.contents.map((c) => (typeof c === "string" ? c : "value" in c ? c.value : "")).join("\n");
}

/** Parses the clangd hover: "// In Shine" / "// In namespace al" + declaration. */
export function parseClangdHover(md: string, word: string): { qual: string; params: string[] | null; isType: boolean } | undefined {
    const title = /###\s+([\w-]+)\s+`([^`]+)`/.exec(md);
    const kind = title?.[1] ?? "";
    const isType = /^(class|struct|union|enum|type-alias|typedef)$/.test(kind);
    if (title && !isType && !/function|method|constructor|destructor|conversion/.test(kind)) return undefined;
    const code = /```cpp\n([\s\S]*?)```/.exec(md)?.[1] ?? "";
    const inM = /\/\/\s*In\s+(?:namespace\s+)?([^\n]+)/.exec(code);
    let scope = inM ? inM[1].trim().replace(/^namespace\s+/, "") : "";
    if (scope === "(anonymous)") scope = "";
    const declLine = code
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("//"))
        .join(" ")
        .replace(/^(public|private|protected):\s*/, "");
    let params: string[] | null = null;
    const i = declLine.indexOf(word + "(");
    if (i >= 0) {
        let depth = 0;
        for (let k = i + word.length; k < declLine.length; k++) {
            if (declLine[k] === "(") depth++;
            else if (declLine[k] === ")" && --depth === 0) {
                params = splitParams(declLine.slice(i + word.length + 1, k)).filter((p) => p && p !== "void");
                break;
            }
        }
    }
    const short = (title ? stripTpl(title[2]) : word).split("::").pop() ?? word;
    return { qual: scope ? `${scope}::${short}` : short, params, isType };
}

/** Overload disambiguation: argument count, then types (Ghidra casts "(LiveActor *)x" or clangd types). */
async function pickOverloads(st: DocState, ids: number[], argTypes: string[] | null, count: number | null): Promise<number[]> {
    if (ids.length <= 1 || (argTypes === null && count === null)) return ids;
    const dm = await st.details(ids);
    const n = argTypes ? argTypes.length : count!;
    const nParams = (d: Detail) => (d.params || []).length;
    const byCount = ids.filter((i) => nParams(dm.get(i)!) === n);
    let cands = byCount.length ? byCount : ids;
    if (argTypes && cands.length > 1) {
        let best = -Infinity;
        let bestList: number[] = [];
        for (const i of cands) {
            let score = 0;
            (dm.get(i)!.params || []).forEach((p, k) => {
                const want = argTypes[k];
                if (!want) return;
                score += baseTypeName(p[0]) === baseTypeName(want) ? 2 : -1;
            });
            if (score > best) {
                best = score;
                bestList = [i];
            } else if (score === best) bestList.push(i);
        }
        cands = bestList;
    }
    return cands;
}

/** Arguments of the call written after the name (null if no call / spans several lines). */
function callArgs(after: string, isPseudo: boolean): { count: number; types: string[] | null } | null {
    const m = /^\s*\(/.exec(after);
    if (!m) return null;
    let depth = 0;
    for (let i = m[0].length - 1; i < after.length; i++) {
        if (after[i] === "(") depth++;
        else if (after[i] === ")" && --depth === 0) {
            const inner = after.slice(m[0].length, i).trim();
            const args = inner ? splitParams(inner) : [];
            if (!isPseudo) return { count: args.length, types: null };
            const types = args.map((a) => /^\(\s*([\w:]+(?:\s*\*)*)\s*\)/.exec(a.trim())?.[1] ?? "");
            return { count: args.length, types: types.some(Boolean) ? types : null };
        }
    }
    return null;
}

function enclosingClass(doc: vscode.TextDocument, line: number): string | undefined {
    for (let i = line; i >= Math.max(0, line - 400); i--) {
        const t = doc.lineAt(i).text;
        let m = /^[\w:<>*&\s]*?\b([A-Za-z_][\w]*(?:::[A-Za-z_]\w*)*)::~?\w+\s*\([^;]*$/.exec(t);
        if (m && !/^\s/.test(t)) return m[1];
        m = /^\s*(?:class|struct)\s+(\w+)\b[^;]*$/.exec(t);
        if (m) return m[1];
    }
    return undefined;
}

const CANDIDATE_NAMESPACES = ["al", "rs", "sead", "nn", "agl", "eui"];

/** Function(s) matching a mangled symbol (via the qualified name, then checked against the details). */
export async function findByMangled(st: DocState, ix: SiteIndex, sym: string): Promise<number[]> {
    const data = ix.dataByMangledName(sym);
    if (data && data.id >= 0) return [data.id];
    const parts = mangledNameParts(sym);
    if (!parts.length) return [];
    const cands = ix.findFn(parts.join("::"));
    if (!cands.length) return [];
    const dm = await st.details(cands);
    return cands.filter((i) => {
        const d = dm.get(i)!;
        return d.mangled === sym || (d.bin || []).some((b) => b.lab.includes(sym));
    });
}

export async function resolveAt(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    st: DocState,
    opts: { useClangd?: boolean; allowShort?: boolean; forceHex?: boolean; types?: boolean } = {},
): Promise<Resolved | undefined> {
    const ix = await st.ix();
    const lineText = doc.lineAt(pos.line).text;

    // 1. mangled symbol inside a string (or bare, in a Hakkun .sym file)
    if (doc.languageId === "hakkun-sym") {
        const r = doc.getWordRangeAtPosition(pos, /_Z[\w.$]+/);
        if (r) {
            const w = doc.getText(r);
            return { ids: await findByMangled(st, ix, w), range: r, how: "mangled", word: w };
        }
    }
    for (const m of lineText.matchAll(/"(_Z[\w.$]+)"/g)) {
        const s = m.index! + 1;
        const e = s + m[1].length;
        if (pos.character >= s - 1 && pos.character <= e + 1) {
            return { ids: await findByMangled(st, ix, m[1]), range: new vscode.Range(pos.line, s, pos.line, e), how: "mangled", word: m[1] };
        }
    }

    const isPseudo = doc.uri.scheme === GHIDRA_SCHEME;
    const offsetResult = (off: number, range: vscode.Range, word: string, ghidraWord: boolean): Resolved | undefined => {
        const str = ix.findString(off);
        if (str && !/InstallAt/.test(lineText)) return { ids: [], range, how: "string", word, offset: off, str };
        const r = ix.findByOffset(off);
        if (r) return { ids: [r.id], range, how: "offset", word, delta: r.delta, offset: off };
        const d = ix.findData(off);
        if (d) return { ids: d.id >= 0 ? [d.id] : [], range, how: "data", word, delta: d.delta, offset: off };
        return ghidraWord || !isPseudo ? { ids: [], range, how: "offset", word, offset: off } : undefined;
    };

    // 2a. Ghidra pseudo-code: FUN_xxxxxxxx / DAT_ and addresses (= offset + 0x100000)
    if (isPseudo && !/^\s*(\/\/|\/\*)/.test(lineText)) {
        const gw = doc.getWordRangeAtPosition(pos, /\b(?:thunk_)?(?:FUN|DAT|PTR|LAB|PTR_FUN|PTR_DAT|s|u)_[0-9a-fA-F]{6,10}\b/);
        const hx = doc.getWordRangeAtPosition(pos, /0x[0-9a-fA-F]+/);
        const rg = gw ?? hx;
        if (rg) {
            const txt = doc.getText(rg);
            const addr = parseInt(gw ? txt.replace(/^.*_/, "") : txt, 16);
            if (addr < GHIDRA_BASE) return undefined;
            return offsetResult(addr - GHIDRA_BASE, rg, txt, !!gw);
        }
    }

    // 2. hexadecimal offset
    const hexRange = doc.getWordRangeAtPosition(pos, /0x[0-9a-fA-F]+/);
    if (hexRange) {
        const mode = cfg<string>("hover.hexOffsets", "contextual");
        const allowed = opts.forceHex || mode === "always" || (mode === "contextual" && HEX_CONTEXT.test(lineText));
        if (!allowed) return undefined;
        let v = parseInt(doc.getText(hexRange), 16);
        if (v >= MAIN_BASE) v -= MAIN_BASE;
        return offsetResult(v, hexRange, doc.getText(hexRange), true);
    }

    const wr = doc.getWordRangeAtPosition(pos, /~?[A-Za-z_]\w*/);
    if (!wr) return undefined;
    const word = doc.getText(wr);
    const before = lineText.slice(0, wr.start.character);
    const after = lineText.slice(wr.end.character);
    const call = callArgs(after, isPseudo);
    const isScope = /^::/.test(after);
    const looksCall = !!call || /&\s*(?:[\w:]+::)?$/.test(before) || /::$/.test(before);

    // 3. qualified name written in the code
    const qm = /((?:[A-Za-z_]\w*(?:<[^<>;()]*>)?::)+)$/.exec(before);
    const qual = qm ? qm[1] + word : word;
    if (!isScope) {
        const tryNs = (f: (q: string) => number[]): number[] => {
            let found = f(qual);
            if (!found.length) for (const ns of CANDIDATE_NAMESPACES) if ((found = f(`${ns}::${qual}`)).length) break;
            return found;
        };
        if (qm) {
            const range = new vscode.Range(pos.line, wr.start.character - qm[1].length, pos.line, wr.end.character);
            let found = tryNs((q) => ix.findFn(q));
            if (found.length) {
                const isDef = /^\S/.test(lineText) && /\)\s*(const)?\s*(override)?\s*\{?\s*$/.test(lineText);
                if (!isDef && call) found = await pickOverloads(st, found, call.types, call.count);
                return { ids: found, range, how: isDef ? "definition" : "qualified", word: qual };
            }
        }
    }

    // 4. clangd (knows exactly which entity it is)
    if (opts.useClangd !== false && !isPseudo && cfg<boolean>("hover.useClangd", true) && !insideClangdHover) {
        insideClangdHover = true;
        try {
            const hovers = (await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", doc.uri, pos)) ?? [];
            for (const h of hovers) {
                const parsed = parseClangdHover(hoverText(h), word.replace(/^~/, ""));
                if (!parsed) continue;
                if (parsed.isType) {
                    const t = ix.findType(parsed.qual);
                    if (t !== undefined && opts.types !== false) return { ids: [t], range: wr, how: "type", word: parsed.qual };
                    continue;
                }
                const found = ix.findFn(parsed.qual);
                if (found.length) return { ids: await pickOverloads(st, found, parsed.params, null), range: wr, how: "clangd", word: parsed.qual };
            }
        } catch {
            /* clangd missing or failed */
        } finally {
            insideClangdHover = false;
        }
    }

    // 5. types (class / struct / enum): "Shine", "al::LiveActor"
    if (opts.types !== false && !looksCall && /^[A-Z_]/.test(word.replace(/^~/, ""))) {
        const t = ix.findType(qual) ?? (qm ? undefined : ix.findType(word));
        if (t !== undefined) {
            const range = qm ? new vscode.Range(pos.line, wr.start.character - qm[1].length, pos.line, wr.end.character) : wr;
            return { ids: [t], range, how: "type", word: ix.q(t) };
        }
    }
    if (!looksCall || isScope) return undefined;

    // 6. method of the enclosing class
    const cls = enclosingClass(doc, pos.line);
    if (cls) {
        const found = ix.findFn(`${cls}::${word}`);
        if (found.length) return { ids: call ? await pickOverloads(st, found, call.types, call.count) : found, range: wr, how: "context", word: `${cls}::${word}` };
    }

    // 7. short name (if not too ambiguous)
    if (opts.allowShort !== false) {
        const max = cfg<number>("hover.maxCandidates", 4);
        let found = ix.fnShort.get(word) ?? [];
        if (found.length > 40) return undefined;
        if (call) found = await pickOverloads(st, found, call.types, call.count);
        if (found.length && found.length <= max) return { ids: found, range: wr, how: "short", word };
    }
    return undefined;
}

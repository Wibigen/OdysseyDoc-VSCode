/**
 * Model of the data published by the OdysseyDoc site (https://wibigen.github.io/OdysseyDoc/).
 * The site's data/*.js files call DOC.got(key, value): they are parsed, never executed.
 */

export const STATUS_LABEL = ["No symbol in the binary", "Matching", "NonMatching (minor)", "NonMatching (major)", "Not decompiled"];
export const STATUS_SHORT = ["no symbol", "Matching", "NonMatching minor", "NonMatching major", "Not decompiled"];
export const STATUS_EMOJI = ["◇", "🟢", "🟡", "🟠", "⚪"];
export const STATUS_FROM_BIN: Record<string, number> = { Matching: 1, NonMatchingMinor: 2, NonMatchingMajor: 3, NotDecompiled: 4 };

export const KIND_LABEL: Record<string, string> = {
    ns: "Namespace", xns: "Namespace (inferred from binary)", class: "Class", struct: "Struct", union: "Union",
    tclass: "Class template", xclass: "Class (inferred from binary)", enum: "Enum", typedef: "Typedef",
    alias: "Type alias (using)", func: "Function", method: "Method", ctor: "Constructor", dtor: "Destructor",
    conv: "Conversion operator", tfunc: "Function template", tmethod: "Method template",
    var: "Variable", macro: "Macro", unit: "File / unit", sym: "Binary symbol",
};

export const FN_KINDS = new Set(["func", "method", "ctor", "dtor", "conv", "tfunc", "tmethod", "sym"]);
export const TYPE_KINDS = new Set(["class", "struct", "union", "tclass", "xclass", "enum", "typedef", "alias"]);
export const CLASS_KINDS = new Set(["class", "struct", "union", "tclass", "xclass"]);

export const MAIN_BASE = 0x7100000000;
export const GHIDRA_BASE = 0x100000;

/** Reads `DOC.got("key", value);` without eval. The value is JSON, or JSON.parse("…") for the index. */
export function parseDocGot(text: string): { key: string; value: unknown } {
    const m = /^\s*DOC\.got\(\s*("(?:[^"\\]|\\.)*")\s*,/.exec(text);
    if (!m) throw new Error("Invalid OdysseyDoc data file");
    const key = JSON.parse(m[1]) as string;
    let body = text.slice(m[0].length).trimEnd();
    if (body.endsWith(";")) body = body.slice(0, -1).trimEnd();
    if (!body.endsWith(")")) throw new Error(`Truncated data (${key})`);
    body = body.slice(0, -1).trim();
    if (body.startsWith("JSON.parse(")) {
        const inner = body.slice("JSON.parse(".length, -1).trim();
        return { key, value: JSON.parse(JSON.parse(inner) as string) };
    }
    return { key, value: JSON.parse(body) };
}

export interface Bin {
    off: number;
    sz: number;
    st: string;
    obj: string;
    lab: string[];
    gh: [string, string][];
    guess?: number;
    thunk?: number;
    hk?: { i?: [string, string, number][]; loop?: number[]; into?: [number, number][] };
}

export interface Loc {
    f: string;
    l: number;
    end?: number;
    sig?: string;
    fi?: number;
}

export interface Field {
    n: string;
    t: string;
    off: number | null;
    sz: number | null;
    acc?: string;
    bits?: number | null;
    l?: number;
    cm?: string | null;
    ti?: number | null;
}

export interface Detail {
    q?: string;
    decl?: Loc;
    def?: Loc;
    ret?: string;
    ret_id?: number;
    params?: [string, string | null, string | null, number | null][];
    flags?: string[];
    acc?: string;
    mangled?: string;
    calls?: number[];
    callers?: number[];
    callsAmb?: number[][];
    /** flat list of ids (unlike callsAmb, which is a list of overload groups) */
    callersAmb?: number[];
    rsrc?: string;
    bin?: Bin[];
    gret?: string;
    dem?: string;
    binonly?: boolean;
    inferred?: boolean;
    obj?: string;
    size?: number;
    align?: number;
    bases?: [string, string, boolean, number | null][];
    derived?: number[];
    fields?: Field[];
    values?: { n: string; v: number; x: string; cm?: string | null }[];
    nerves?: { n: string; m: string; exe: string; f: string; l: number }[];
    overrides?: number[];
    overby?: number[];
    cm?: string;
    type?: string;
    underlying?: string;
    tp?: string[];
}

export interface RawIndex {
    meta: {
        decomp_rev: string;
        ghidra_rev: string;
        decomp_repo: string;
        ghidra_repo: string;
        kmap: string[];
        subs?: Record<string, [string, string]>;
        stats?: Record<string, number>;
        game?: string;
        [k: string]: unknown;
    };
    e: [string | 0, number, string, number, number, number, number, number][];
    files: [string, string, number][];
    addr: [number, number][];
    inh?: number[][];
    nerv?: number[][];
    ustats?: number[][];
}

export class SiteIndex {
    readonly E: RawIndex["e"];
    readonly K: string[];
    readonly files: RawIndex["files"];
    readonly addr: RawIndex["addr"];
    readonly meta: RawIndex["meta"];
    readonly kids: number[][];
    readonly fnByQ = new Map<string, number[]>();
    readonly typeByQ = new Map<string, number>();
    readonly typeShort = new Map<string, number>(); // -1 if ambiguous
    readonly anyByQ = new Map<string, number>();
    readonly fnShort = new Map<string, number[]>();
    readonly offsOf = new Map<number, number[]>();
    readonly fileByPath = new Map<string, number>();
    readonly units: number[] = [];
    private nameL: string[];
    private qL: string[];
    private strOff: number[] = [];
    private strTxt: string[] = [];
    private dataSyms: [number, string, string, number][] = [];
    private dataByMangled = new Map<string, [number, string, string, number]>();

    constructor(raw: RawIndex) {
        this.E = raw.e;
        this.K = raw.meta.kmap;
        this.files = raw.files;
        this.addr = raw.addr;
        this.meta = raw.meta;
        const n = this.E.length;
        const E = this.E;
        const strip = (s: string) => {
            const t = s.lastIndexOf("~");
            if (t > 0 && /^~\d+$/.test(s.slice(t))) s = s.slice(0, t);
            return s.startsWith("file:") ? s.slice(5) : s;
        };
        // slug = 0 when it is "<parent qname>::<name>" (iterative: no deep recursion)
        for (let i = 0; i < n; i++) {
            if (E[i][0] !== 0) continue;
            const chain: number[] = [];
            let j = i;
            while (j >= 0 && E[j][0] === 0) {
                chain.push(j);
                j = E[j][3];
            }
            for (let k = chain.length - 1; k >= 0; k--) {
                const r = E[chain[k]];
                r[0] = r[3] >= 0 ? strip(E[r[3]][0] as string) + "::" + r[2] : r[2];
            }
        }
        this.kids = new Array(n);
        this.nameL = new Array(n);
        this.qL = new Array(n);
        for (let i = 0; i < n; i++) {
            const r = E[i];
            const p = r[3];
            if (p >= 0) (this.kids[p] ||= []).push(i);
            const k = this.K[r[1]];
            const q = this.q(i);
            this.nameL[i] = r[2].toLowerCase();
            this.qL[i] = q.toLowerCase();
            if (TYPE_KINDS.has(k)) {
                if (!this.typeByQ.has(q)) this.typeByQ.set(q, i);
                const s = this.typeShort.get(r[2]);
                this.typeShort.set(r[2], s === undefined ? i : s === i ? i : -1);
            }
            if (FN_KINDS.has(k) || k === "var") {
                push(this.fnByQ, q, i);
                if (k !== "var") push(this.fnShort, r[2], i);
            }
            if (k === "unit") this.units.push(i);
            else if (!this.anyByQ.has(q)) this.anyByQ.set(q, i);
        }
        for (const [off, id] of this.addr) push(this.offsOf, id, off);
        this.files.forEach((f, i) => this.fileByPath.set(f[0], i));
    }

    get size() {
        return this.E.length;
    }
    kind(i: number) {
        return this.K[this.E[i][1]];
    }
    name(i: number) {
        return this.E[i][2];
    }
    parent(i: number): number | null {
        const p = this.E[i][3];
        return p >= 0 ? p : null;
    }
    status(i: number) {
        return this.E[i][4];
    }
    bundle(i: number) {
        return this.E[i][5];
    }
    flags(i: number) {
        return this.E[i][6];
    }
    unit(i: number): number | null {
        const u = this.E[i][7];
        return u >= 0 ? u : null;
    }
    slug(i: number) {
        return this.E[i][0] as string;
    }
    isBinOnly(i: number) {
        return (this.E[i][6] & 1) !== 0;
    }
    children(i: number): number[] {
        return this.kids[i] || [];
    }
    /** qualified name (slug without the ~n suffix or the file: prefix) */
    q(i: number): string {
        let s = this.E[i][0] as string;
        const t = s.lastIndexOf("~");
        if (t > 0 && /^~\d+$/.test(s.slice(t))) s = s.slice(0, t);
        return s.startsWith("file:") ? s.slice(5) : s;
    }
    /** overload index (0 if unique) */
    overloadIndex(i: number): number {
        const m = /~(\d+)$/.exec(this.slug(i));
        return m ? parseInt(m[1], 10) : 0;
    }
    isFn(i: number) {
        return FN_KINDS.has(this.kind(i));
    }
    isType(i: number) {
        return TYPE_KINDS.has(this.kind(i));
    }
    offsets(i: number): number[] {
        return this.offsOf.get(i) ?? [];
    }

    /** Function containing the offset (size approximated by the start of the next function). */
    findByOffset(off: number): { id: number; base: number; delta: number; size: number } | undefined {
        const a = this.addr;
        let lo = 0,
            hi = a.length - 1,
            best = -1;
        while (lo <= hi) {
            const m = (lo + hi) >> 1;
            if (a[m][0] <= off) {
                best = m;
                lo = m + 1;
            } else hi = m - 1;
        }
        if (best < 0) return undefined;
        const base = a[best][0];
        const next = best + 1 < a.length ? a[best + 1][0] : base + 0x1000;
        if (off >= next) return undefined;
        return { id: a[best][1], base, delta: off - base, size: next - base };
    }

    /** Functions with this qualified name (also tries without template arguments). */
    findFn(q: string): number[] {
        const k = q.replace(/^::/, "").trim();
        return this.fnByQ.get(k) ?? this.fnByQ.get(stripTpl(k)) ?? [];
    }

    findType(q: string): number | undefined {
        const k = q.replace(/^::/, "").trim();
        const t = this.typeByQ.get(k) ?? this.typeByQ.get(stripTpl(k));
        if (t !== undefined) return t;
        const s = this.typeShort.get(k);
        return s !== undefined && s >= 0 ? s : undefined;
    }

    // ---------------------------------------------------------------- strings / data symbols
    setStrings(list: [string, string][]) {
        const arr = list.map(([a, t]) => [parseInt(a, 16) - MAIN_BASE, t] as [number, string]).sort((x, y) => x[0] - y[0]);
        this.strOff = arr.map((x) => x[0]);
        this.strTxt = arr.map((x) => x[1]);
    }
    setSymbols(list: [string, string, string, number][]) {
        this.dataSyms = list.map(([a, m, d, id]) => [parseInt(a, 16) - MAIN_BASE, m, d, id] as [number, string, string, number]).sort((x, y) => x[0] - y[0]);
        for (const s of this.dataSyms) this.dataByMangled.set(s[1], s);
    }
    get stringCount() {
        return this.strOff.length;
    }
    findString(off: number): { text: string; delta: number } | undefined {
        const i = lowerIdx(this.strOff, off);
        if (i < 0) return undefined;
        const delta = off - this.strOff[i];
        const t = this.strTxt[i];
        if (delta === 0 || delta < utf8Len(t)) return { text: t, delta };
        return undefined;
    }
    findData(off: number): { off: number; mangled: string; dem: string; id: number; delta: number } | undefined {
        const offs = this.dataSyms.map((x) => x[0]);
        const i = lowerIdx(offs, off);
        if (i < 0) return undefined;
        const s = this.dataSyms[i];
        const delta = off - s[0];
        const next = this.dataSyms[i + 1]?.[0] ?? Infinity;
        if (delta === 0 || (delta < 0x100 && off < next)) return { off: s[0], mangled: s[1], dem: s[2], id: s[3], delta };
        return undefined;
    }
    dataByMangledName(m: string) {
        const s = this.dataByMangled.get(m);
        return s ? { off: s[0], mangled: s[1], dem: s[2], id: s[3] } : undefined;
    }

    // ---------------------------------------------------------------- search (same logic as the site)
    search(query: string, limit = 150, kinds?: Set<string>): { id: number; addr?: number; base?: number }[] {
        const q = query.trim();
        if (!q) return [];
        const res: { i: number; s: number; addr?: number; base?: number }[] = [];
        const off = parseAddr(q);
        if (off !== null) {
            const a = this.findByOffset(off);
            if (a) res.push({ i: a.id, s: 1e6, addr: off, base: a.base });
        }
        const ql = q.toLowerCase();
        const qual = ql.includes("::");
        const words = ql.split(/\s+/).filter(Boolean);
        const BONUS: Record<string, number> = { class: 60, struct: 55, tclass: 55, xclass: 40, union: 50, ns: 45, xns: 30, enum: 45, typedef: 30, alias: 30, func: 20, method: 15, ctor: 10, dtor: 5, unit: 25, macro: 10, var: 10 };
        for (let i = 0; i < this.E.length; i++) {
            const k = this.K[this.E[i][1]];
            if (kinds && !kinds.has(k)) continue;
            const n = this.nameL[i];
            const ql2 = this.qL[i];
            let s: number;
            if (words.length > 1) {
                if (!words.every((w) => ql2.includes(w))) continue;
                s = 150 - Math.min(ql2.length, 140) / 2;
            } else if (qual) {
                if (ql2 === ql) s = 1000;
                else if (ql2.endsWith(ql)) s = 800 - ql2.length / 4;
                else if (ql2.startsWith(ql)) s = 600 - ql2.length / 4;
                else if (ql2.includes(ql)) s = 300 - ql2.length / 4;
                else continue;
            } else {
                if (n === ql) s = 1000;
                else if (n.startsWith(ql)) s = 700 - (n.length - ql.length) * 2;
                else if (n.includes(ql)) s = 400 - (n.length - ql.length);
                else if (ql2.includes(ql)) s = 150 - ql2.length / 4;
                else continue;
            }
            s += BONUS[k] || 0;
            if (this.E[i][6] & 1) s -= 15;
            res.push({ i, s });
        }
        res.sort((a, b) => b.s - a.s);
        const seen = new Set<number>();
        const out: { id: number; addr?: number; base?: number }[] = [];
        for (const r of res) {
            if (seen.has(r.i)) continue;
            seen.add(r.i);
            out.push({ id: r.i, addr: r.addr, base: r.base });
            if (out.length >= limit) break;
        }
        return out;
    }

    /** Qualification context (enclosing scopes) of an entity, like the site's HL.ctxFromEntity. */
    ctxFromEntity(i: number): string[] {
        const out: string[] = [];
        let p: number | null = i;
        while (p !== null) {
            const k = this.kind(p);
            if (k === "ns" || k === "xns" || CLASS_KINDS.has(k)) out.push(this.q(p) + "::");
            p = this.parent(p);
        }
        out.push("");
        return out;
    }

    /** Qualifies type names in a string ("LiveActor *" inside al -> "al::LiveActor *"), like HL.qualify. */
    qualify(str: string, ctx: string[] = [""]): string {
        if (!str) return str;
        return str.replace(/(::\s*)?\b([A-Za-z_]\w*)\b/g, (m, pre: string | undefined, id: string) => {
            if (pre || KW.has(id) || BUILTIN_T.has(id)) return m;
            let t: number | undefined;
            for (const p of ctx) {
                t = this.typeByQ.get(p + id);
                if (t !== undefined) break;
            }
            if (t === undefined) {
                const s = this.typeShort.get(id);
                if (s !== undefined && s >= 0) t = s;
            }
            if (t === undefined) return m;
            const q = this.q(t);
            return q.endsWith(id) && !q.includes("(anonymous@") ? q : m;
        });
    }

    /** Include path: "src/Item/Shine.h" -> "Item/Shine.h"; "lib/al/Library/…" -> "Library/…" */
    includeFor(path: string | undefined): string | null {
        if (!path || !/\.(h|hpp)$/.test(path)) return null;
        if (path.startsWith("src/")) return `"${path.slice(4)}"`;
        if (path.startsWith("lib/al/")) return `"${path.slice(7)}"`;
        const m = /^lib\/(?:sead|agl|eui|NintendoSDK|NintendoSDK-NEX)\/(?:include|modules\/include)\/(.*)$/.exec(path);
        return m ? `<${m[1]}>` : null;
    }

    githubUrl(path: string, line?: number, end?: number): string {
        const m = this.meta;
        const frag = line ? `#L${line}${end && end !== line ? `-L${end}` : ""}` : "";
        for (const [pre, [repo, rev]] of Object.entries(m.subs || {})) {
            if (path.startsWith(pre + "/")) return `https://github.com/${repo}/blob/${rev}/${path.slice(pre.length + 1)}${frag}`;
        }
        return `https://github.com/${m.decomp_repo}/blob/${m.decomp_rev}/${path}${frag}`;
    }
}

const KW = new Set(
    "const volatile unsigned signed struct class enum union typename template static inline virtual explicit operator new delete sizeof this return if else for while do switch case default break continue nullptr true false auto decltype mutable friend public private protected using namespace typedef".split(
        " ",
    ),
);
const BUILTIN_T = new Set(
    "void bool char short int long float double wchar_t char16_t char32_t size_t s8 u8 s16 u16 s32 u32 s64 u64 f32 f64 uintptr_t intptr_t ptrdiff_t".split(" "),
);

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
    const a = m.get(k);
    if (a) a.push(v);
    else m.set(k, [v]);
}

function lowerIdx(a: number[], v: number): number {
    let lo = 0,
        hi = a.length - 1,
        best = -1;
    while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (a[m] <= v) {
            best = m;
            lo = m + 1;
        } else hi = m - 1;
    }
    return best;
}

function utf8Len(s: string) {
    let n = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0)!;
        n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
}

export function stripTpl(s: string): string {
    let out = "";
    let depth = 0;
    for (const c of s) {
        if (c === "<") depth++;
        else if (c === ">" && depth > 0) depth--;
        else if (depth === 0) out += c;
    }
    return out;
}

/** offset (0x1ccff4), main address (0x71001ccff4) or Ghidra address (.text::002ccff4 / gh:002ccff4 / 0x2ccff4 g) */
export function parseAddr(q: string): number | null {
    let s = q.trim().toLowerCase();
    let ghidra = false;
    if (s.startsWith(".text::")) {
        s = s.slice(7);
        ghidra = true;
    } else if (s.startsWith("gh:")) {
        s = s.slice(3);
        ghidra = true;
    } else if (/\s+g$/.test(s)) {
        s = s.replace(/\s+g$/, "");
        ghidra = true;
    }
    if (!/^(0x)?[0-9a-f]{4,12}$/.test(s)) return null;
    if (!s.startsWith("0x") && !ghidra && !/[a-f]/.test(s) && s.length < 6) return null;
    let v = parseInt(s.replace(/^0x/, ""), 16);
    if (v >= MAIN_BASE) v -= MAIN_BASE;
    else if (ghidra) v -= GHIDRA_BASE;
    return v;
}

export function hex(n: number, pad = 0): string {
    return "0x" + n.toString(16).toUpperCase().padStart(pad, "0");
}

// ---------------------------------------------------------------- hook safety (port of pages.js)
export type HookLevel = "ok" | "warn" | "bad" | "unknown";
export interface HookIssue {
    lvl: "info" | "warn" | "bad";
    mode: "near" | "far" | "both";
    t: string;
}

export function hookSafety(b: Bin): { issues: HookIssue[]; near: HookLevel; far: HookLevel; checked: boolean } {
    const issues: HookIssue[] = [];
    const hk = b.hk;
    if (b.thunk) issues.push({ lvl: "warn", mode: "both", t: "This entry is a non-virtual thunk (this-pointer adjustor): hooking it only catches calls made through this base-class view. Hook the main entry instead." });
    if (b.sz < 20) issues.push({ lvl: "bad", mode: "far", t: `The function is only ${b.sz} bytes: an absolute-jump patch (16–20 bytes) would overwrite the start of the next function.` });
    if (hk) {
        if (hk.loop?.length) issues.push({ lvl: "bad", mode: "both", t: `The function branches back to its own entry (from ${hk.loop.map((x) => hex(x)).join(", ")}): every iteration would re-enter your hook.` });
        if (hk.into?.length) issues.push({ lvl: "bad", mode: "far", t: `Code branches into the bytes an absolute-jump patch overwrites: ${hk.into.map(([t, f]) => `${hex(f)} → ${hex(t)}`).join(", ")}.` });
        const ins = hk.i || [];
        if (ins[0] && ins[0][2]) issues.push({ lvl: "warn", mode: "near", t: `The first instruction (${ins[0][0]} ${ins[0][1]}) is PC-relative: exlaunch relocates it, so it normally works.` });
        const farPc = ins.slice(1, 5).filter((x) => x[2]).map((x) => `${x[0]} ${x[1]}`);
        if (farPc.length) issues.push({ lvl: "warn", mode: "far", t: `PC-relative instruction(s) within the first 5: ${farPc.join(", ")}.` });
        if (ins[0] && /^b$/i.test(ins[0][0])) issues.push({ lvl: "info", mode: "both", t: "The function is a tail jump (b) to another function: consider hooking the target instead." });
    }
    const worst = (mode: "near" | "far"): HookLevel => {
        const l = issues.filter((x) => x.mode === mode || x.mode === "both").map((x) => x.lvl);
        if (l.includes("bad")) return "bad";
        if (l.includes("warn")) return "warn";
        return hk ? "ok" : "unknown";
    };
    return { issues, near: worst("near"), far: worst("far"), checked: !!hk };
}

export const HOOK_LABEL: Record<HookLevel, string> = { ok: "safe to hook", warn: "hook with care", bad: "unsafe to hook", unknown: "size checked only" };

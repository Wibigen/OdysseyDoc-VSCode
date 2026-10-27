import { CLASS_KINDS, Detail, hex, hookSafety, SiteIndex, STATUS_SHORT } from "./site";
import { Framework, hkVarName } from "./hakkun";

export type HookKind = "trampoline" | "replace" | "inline";
export type InstallMode = "symbol" | "offset";

export interface HookResult {
    framework: Framework;
    name: string;
    code: string;
    install: string;
    notes: string[];
    /** header of the hooked class (OdysseyHeaders) */
    include: string | null;
    /** framework headers the code needs ("hk/hook/Trampoline.h") */
    headers: string[];
    /** Hakkun: mangled symbol used by installAtSym<>, to declare in syms/ */
    symbol?: string;
    /** OdysseyDecomp path of the declaration (to pick the .sym file) */
    declPath?: string;
}

const GH_TYPES: Record<string, string> = {
    void: "void", undefined: "u8", undefined1: "u8", undefined2: "u16", undefined4: "u32", undefined8: "u64",
    bool: "bool", byte: "u8", uchar: "u8", char: "char", ushort: "u16", short: "s16", uint: "u32", int: "s32",
    ulong: "u64", long: "s64", ulonglong: "u64", longlong: "s64", float: "f32", double: "f64",
};

function ghidraTypeToCpp(ix: SiteIndex, t: string | undefined): string | null {
    t = (t || "").trim();
    if (!t) return null;
    if (GH_TYPES[t]) return GH_TYPES[t];
    const m = /^(.*?)\s*\*$/.exec(t);
    if (m) {
        const base = m[1].trim();
        if (GH_TYPES[base]) return GH_TYPES[base] + "*";
        const ti = ix.findType(base);
        return ti !== undefined ? ix.q(ti) + "*" : "void*";
    }
    return null;
}

/** "const al::ActorInitInfo &" -> "const al::ActorInitInfo&" */
export function tidyType(t: string): string {
    return t.replace(/\s+([*&])/g, "$1").replace(/\s+/g, " ").trim();
}

const OP_NAMES: Record<string, string> = {
    "operator()": "CallOp", "operator[]": "IndexOp", "operator=": "AssignOp", "operator==": "EqOp", "operator!=": "NeqOp",
    "operator<": "LtOp", "operator>": "GtOp", "operator+": "AddOp", "operator-": "SubOp", "operator*": "MulOp", "operator/": "DivOp",
};

export function hookName(ix: SiteIndex, i: number, kind: HookKind): string {
    const q = ix.q(i).replace(/\(anonymous@[^)]*\)::/g, "");
    const parts = q.split("::").map((p) => p.replace(/<.*>/, ""));
    const fn0 = parts.pop() ?? "Fn";
    const cls = parts[parts.length - 1] ?? "";
    let fn = fn0;
    if (fn === cls) fn = "Ctor";
    else if (fn === "~" + cls) fn = "Dtor";
    else if (fn.startsWith("operator")) fn = OP_NAMES[fn.replace(/\s+/g, "")] ?? "Op";
    else fn = fn.charAt(0).toUpperCase() + fn.slice(1);
    // keep classes (capitalised); lowercase namespaces only when there is no class
    const upper = parts.filter((p) => /^[A-Z]/.test(p));
    const scope = (upper.length ? upper : parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1))).join("");
    const ov = ix.overloadIndex(i);
    const suffix = kind === "inline" ? "Inline" : kind === "replace" ? "Replace" : "Hook";
    return (scope + fn).replace(/[^A-Za-z0-9_]/g, "") + (ov ? String(ov) : "") + suffix;
}

export interface GenOptions {
    kind: HookKind;
    install: InstallMode;
    /** index of the binary entry to hook (default: the first one that is not a thunk) */
    binIndex?: number;
    indent?: string;
    /** default: exlaunch */
    framework?: Framework;
}

/** Generates an exlaunch or Hakkun hook for a function from the site data (clang signature, Ghidra as a fallback). */
export function generateHook(ix: SiteIndex, i: number, d: Detail, opt: GenOptions): HookResult {
    const ind = opt.indent ?? "    ";
    const notes: string[] = [];
    const bins = d.bin || [];
    const b = opt.binIndex !== undefined ? bins[opt.binIndex] : bins.find((x) => !x.thunk) ?? bins[0];
    const k = ix.kind(i);
    const fl = d.flags || [];
    const q = ix.q(i);
    const name = ix.name(i);
    const owner = q.endsWith("::" + name) ? q.slice(0, q.length - name.length - 2) : null;
    const p = ix.parent(i);
    const isMember = !!owner && p !== null && CLASS_KINDS.has(ix.kind(p)) && !fl.includes("static") && k !== "sym";
    const ctx = ix.ctxFromEntity(i);

    let ret: string;
    if (k === "ctor" || k === "dtor") ret = "void";
    else if (d.ret) ret = tidyType(ix.qualify(d.ret, ctx));
    else {
        ret = ghidraTypeToCpp(ix, d.gret) || "u64";
        notes.push(`return type GUESSED${d.gret ? ` (Ghidra: ${d.gret})` : ""}: verify it`);
    }
    if (d.rsrc === "declared") notes.push("return type declared in the decomp but not verified (function not decompiled yet)");
    if (d.rsrc === "ghidra" && d.ret) notes.push(`return type taken from Ghidra: verify it`);

    const args: [string, string][] = [];
    if (isMember) args.push([(fl.includes("const") ? "const " : "") + owner + "*", "self"]);
    (d.params || []).forEach((x, n) => args.push([tidyType(ix.qualify(x[0], ctx)), (x[1] || "arg" + n).replace(/^(this|self|orig|result)$/, "$1_")]));
    if (fl.includes("variadic")) notes.push("variadic function: the original cannot be called with the \"...\" arguments");
    if (k === "sym") notes.push("no C++ signature known: fill in the parameters from the Ghidra pseudo-code");
    if (!b) notes.push("this function has no entry in the binary (inlined / uninstantiated template): it cannot be hooked");
    if (b) {
        const r = hookSafety(b);
        for (const x of r.issues) {
            if (x.lvl === "info" || (x.mode === "far" && x.lvl !== "bad")) continue;
            notes.push((x.mode === "far" ? "fallback (long jump): " : "") + x.t);
        }
    }
    if (opt.framework === "hakkun" && opt.kind === "inline")
        notes.push("Hakkun has no register-context (inline) hook: a trampoline was generated instead (for instruction-level patches see hk::hook::writeBranchLinkAtMainOffset / hk::hook::a64::assemble)");
    if (bins.length > 1) notes.push(`other entries: ${bins.filter((x) => x !== b).map((x) => hex(x.off) + (x.thunk ? " (thunk)" : "")).join(", ")}`);

    const hname = hookName(ix, i, opt.kind);
    const st = b ? STATUS_SHORT[{ Matching: 1, NonMatchingMinor: 2, NonMatchingMajor: 3, NotDecompiled: 4 }[b.st] ?? 0] : "";
    const lines: string[] = [`// ${d.dem ?? q} — ${b ? `${hex(b.off)} (${b.sz} bytes, ${st})` : "no address"}`];
    for (const n of notes) lines.push(`// ⚠ ${n}`);
    const sig = args.map((a) => `${a[0]} ${a[1]}`).join(", ");
    const callArgs = args.map((a) => a[1]).join(", ");
    const isVoid = ret === "void";
    const isRef = /&$/.test(ret);
    const off = b ? hex(b.off) : "0x0 /* unknown */";
    const sym = b?.lab.find((l) => l.startsWith("_Z")) ?? d.mangled;
    let install: string;
    const inc = ix.includeFor(d.decl?.f);

    if (opt.framework === "hakkun") {
        // Hakkun: a capture-less lambda in a global HkTrampoline / HkReplace, installed from hkMain()
        const v = hkVarName(hname);
        const lambdaArgs = args.map((a) => `${a[0]} ${a[1]}`);
        if (opt.kind === "replace") {
            const tpl = [ret, ...args.map((a) => a[0])].join(", ");
            lines.push(`${fl.includes("variadic") ? "HkReplaceVarArgs" : "HkReplace"}<${tpl}> ${v} = [](${lambdaArgs.join(", ")}) -> ${ret} {`);
            lines.push(`${ind}// TODO: fully replaces ${q}`);
            for (const a of args) lines.push(`${ind}(void)${a[1]};`);
            if (!isVoid) lines.push(isRef ? `${ind}// TODO: return a valid reference` : `${ind}return {};`);
        } else {
            lines.push(`HkTrampoline ${v} = [](${["TrampolineStatic()", ...lambdaArgs].join(", ")}) -> ${ret} {`);
            lines.push(`${ind}// before the original`);
            if (isVoid) lines.push(`${ind}orig(${callArgs});`, `${ind}// after the original`);
            else if (isRef) lines.push(`${ind}return orig(${callArgs});`);
            else lines.push(`${ind}${ret} result = orig(${callArgs});`, `${ind}// after the original`, `${ind}return result;`);
        }
        lines.push(`};`);
        const bySym = opt.install !== "offset" && !!sym;
        install = bySym ? `${v}.installAtSym<"${sym}">();` : `${v}.installAtMainOffset(${off}); // ${q} — SMO 1.0.0 only`;
        return {
            framework: "hakkun",
            name: v,
            code: lines.join("\n") + "\n",
            install,
            notes,
            include: inc,
            headers: [opt.kind === "replace" ? "hk/hook/Replace.h" : "hk/hook/Trampoline.h"],
            symbol: bySym ? sym : undefined,
            declPath: d.decl?.f ?? d.def?.f,
        };
    }

    if (opt.kind === "inline") {
        const anyFloat = args.some(([t]) => /^(const )?(f32|f64|float|double)$/.test(t));
        lines.push(`HOOK_DEFINE_INLINE(${hname}) {`, `${ind}static void Callback(exl::hook::${anyFloat ? "InlineFloatCtx" : "InlineCtx"}* ctx) {`, `${ind}${ind}// Registers at function entry (AAPCS64):`);
        let xi = 0,
            fi = 0;
        for (const [t, n] of args) {
            if (/^(const )?(f32|float)$/.test(t)) lines.push(`${ind}${ind}//   ctx->S[${fi++}] = ${t} ${n}`);
            else if (/^(const )?(f64|double)$/.test(t)) lines.push(`${ind}${ind}//   ctx->D[${fi++}] = ${t} ${n}`);
            else if (/^(const )?sead::(Vector|Quat|Matrix)/.test(t) && !/[*&]$/.test(t)) lines.push(`${ind}${ind}//   ${t} ${n}: passed by value (float registers / stack)`);
            else lines.push(`${ind}${ind}//   ctx->X[${xi++}] = ${t} ${n}`);
        }
        if (isMember) lines.push(`${ind}${ind}auto* self = reinterpret_cast<${args[0][0]}>(ctx->X[0]);`, `${ind}${ind}(void)self;`);
        lines.push(`${ind}}`, `};`);
        install = `${hname}::InstallAtOffset(${off}); // + offset of the target instruction`;
    } else {
        lines.push(`${opt.kind === "replace" ? "HOOK_DEFINE_REPLACE" : "HOOK_DEFINE_TRAMPOLINE"}(${hname}) {`, `${ind}static ${ret} Callback(${sig}) {`);
        if (opt.kind === "trampoline") {
            lines.push(`${ind}${ind}// before the original`);
            if (isVoid) lines.push(`${ind}${ind}Orig(${callArgs});`, `${ind}${ind}// after the original`);
            else if (isRef) lines.push(`${ind}${ind}return Orig(${callArgs});`);
            else lines.push(`${ind}${ind}${ret} result = Orig(${callArgs});`, `${ind}${ind}// after the original`, `${ind}${ind}return result;`);
        } else {
            lines.push(`${ind}${ind}// TODO: fully replaces ${q}`);
            if (args.length) lines.push(`${ind}${ind}EXL_UNUSED(${callArgs});`);
            if (!isVoid) lines.push(isRef ? `${ind}${ind}// TODO: return a valid reference` : `${ind}${ind}return {};`);
        }
        lines.push(`${ind}}`, `};`);
        install = opt.install === "offset" || !sym ? `${hname}::InstallAtOffset(${off}); // ${q}` : `${hname}::InstallAtSymbol("${sym}");`;
    }
    return { framework: "exlaunch", name: hname, code: lines.join("\n") + "\n", install, notes, include: inc, headers: [], declPath: d.decl?.f ?? d.def?.f };
}

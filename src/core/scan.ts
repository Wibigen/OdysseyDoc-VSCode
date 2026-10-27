/** Finds hooks / installs / patches in a source file (exlaunch and Hakkun syntax). */

export type RefKind = "symbol" | "offset" | "ptr" | "patch" | "write";

export interface HookRef {
    kind: RefKind;
    hookName: string; // "" for a patch
    method: string; // InstallAtSymbol, InstallAtOffset, CodePatcher, installAtSym, installAtMainOffset...
    /** Hakkun: the symbol goes through sail (it must be declared in syms/) */
    sail?: boolean;
    value: string; // raw text (symbol or number)
    num?: number; // numeric value (offset)
    start: number; // index of the value in the text
    end: number;
    stmtStart: number;
}

export interface HookDef {
    name: string;
    kind: "trampoline" | "replace" | "inline" | "legacy";
    framework: "exlaunch" | "hakkun";
    start: number;
    end: number;
}

const DEF_RX = /\bHOOK_DEFINE_(TRAMPOLINE|REPLACE|INLINE)\s*\(\s*(\w+)\s*\)/g;
const LEGACY_RX = /\bMAKE_HOOK(?:_T)?\s*\(\s*[^,]+,\s*(\w+)\s*,/g;
const SYM_RX = /\b(\w+)\s*::\s*(InstallAtSymbol)\s*\(\s*"([^"]*)"/g;
const OFF_RX = /\b(\w+)\s*::\s*(InstallAtOffset|InstallAtPtr)\s*\(\s*(0x[0-9a-fA-F']+|\d+)/g;
const PATCH_RX = /\b(CodePatcher|RandomAccessPatcher|StreamPatcher|GetTargetOffset|INJECT_HOOK(?:_T)?)\b\s*(?:\w+\s*)?[({]\s*(0x[0-9a-fA-F']+)/g;
const LOOKUP_RX = /\bLookupSymbol\s*\(\s*[^,]+,\s*"([^"]*)"/g;

// Hakkun
const NUM = "(0x[0-9a-fA-F']+|\\d+)";
const HK_DEF_RX = /\b(HkTrampoline|HkReplace(?:VarArgs)?|hk::hook::(?:Trampoline|Replace))\b(?:\s*<[^;{}=]*>)?\s+(\w+)\s*(?:=|\{|\()/g;
const HK_LEGACY_RX = /\b(?:static\s+)?(?:auto|const\s+auto)\s+(\w+)\s*=\s*(?:hk::)?hook::(trampoline|replace)\s*\(/g;
const HK_SYM_RX = /(\w+|\))\s*(?:\.|->)\s*installAtSym\s*<\s*"([^"]*)"\s*>/g;
const HK_SYMFN_RX = /\b(write(?:Branch|BranchLink)AtSym|lookupSymbol|InitializeGuard|writeVftHook)\s*<\s*"([^"]*)"/g;
const HK_OFF_RX = new RegExp(`(\\w+|\\))\\s*(?:\\.|->)\\s*(installAtMainOffset)\\s*\\(\\s*${NUM}`, "g");
const HK_MODOFF_RX = new RegExp(`(\\w+)\\s*(?:\\.|->)\\s*(installAtOffset)\\s*\\(\\s*(?:hk::)?ro::getMainModule\\s*\\(\\s*\\)\\s*,\\s*${NUM}`, "g");
const HK_BRANCH_RX = new RegExp(`\\b(write(?:Branch|BranchLink)AtMainOffset)\\s*\\(\\s*${NUM}`, "g");
const HK_WRITE_RX = new RegExp(`getMainModule\\s*\\(\\s*\\)\\s*->\\s*(writeRo|writeRw)\\b(?:\\s*<[^>]*>)?\\s*\\(\\s*${NUM}`, "g");

function stripComments(text: string): string {
    // replace comments with spaces (keeps indices)
    return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

export function scanSource(text: string): { refs: HookRef[]; defs: HookDef[] } {
    const t = stripComments(text);
    const refs: HookRef[] = [];
    const defs: HookDef[] = [];
    let m: RegExpExecArray | null;
    DEF_RX.lastIndex = 0;
    while ((m = DEF_RX.exec(t))) {
        defs.push({ name: m[2], kind: m[1].toLowerCase() as HookDef["kind"], framework: "exlaunch", start: m.index, end: m.index + m[0].length });
    }
    LEGACY_RX.lastIndex = 0;
    while ((m = LEGACY_RX.exec(t))) defs.push({ name: m[1], kind: "legacy", framework: "exlaunch", start: m.index, end: m.index + m[0].length });
    HK_DEF_RX.lastIndex = 0;
    while ((m = HK_DEF_RX.exec(t))) {
        if (/^(using|return|class|struct)$/.test(m[2])) continue;
        defs.push({ name: m[2], kind: /Replace/.test(m[1]) ? "replace" : "trampoline", framework: "hakkun", start: m.index, end: m.index + m[0].length });
    }
    HK_LEGACY_RX.lastIndex = 0;
    while ((m = HK_LEGACY_RX.exec(t))) defs.push({ name: m[1], kind: m[2] as "trampoline" | "replace", framework: "hakkun", start: m.index, end: m.index + m[0].length });
    const pushNum = (kind: RefKind, hookName: string, method: string, raw: string, mm: RegExpExecArray) => {
        const vStart = mm.index + mm[0].length - raw.length;
        const num = parseInt(raw.replace(/'/g, ""), /^0x/i.test(raw) ? 16 : 10);
        refs.push({ kind, hookName, method, value: raw, num, start: vStart, end: vStart + raw.length, stmtStart: mm.index });
    };
    HK_SYM_RX.lastIndex = 0;
    while ((m = HK_SYM_RX.exec(t))) {
        const vStart = m.index + m[0].indexOf('"') + 1;
        refs.push({ kind: "symbol", hookName: m[1] === ")" ? "" : m[1], method: "installAtSym", value: m[2], start: vStart, end: vStart + m[2].length, stmtStart: m.index + (m[1] === ")" ? 1 : 0), sail: true });
    }
    HK_SYMFN_RX.lastIndex = 0;
    while ((m = HK_SYMFN_RX.exec(t))) {
        const vStart = m.index + m[0].indexOf('"') + 1;
        refs.push({ kind: "symbol", hookName: "", method: m[1], value: m[2], start: vStart, end: vStart + m[2].length, stmtStart: m.index, sail: true });
    }
    HK_OFF_RX.lastIndex = 0;
    while ((m = HK_OFF_RX.exec(t))) pushNum(m[1] === ")" ? "patch" : "offset", m[1] === ")" ? "" : m[1], m[2], m[3], m);
    HK_MODOFF_RX.lastIndex = 0;
    while ((m = HK_MODOFF_RX.exec(t))) pushNum("offset", m[1], m[2], m[3], m);
    HK_BRANCH_RX.lastIndex = 0;
    while ((m = HK_BRANCH_RX.exec(t))) pushNum("patch", "", m[1], m[2], m);
    HK_WRITE_RX.lastIndex = 0;
    while ((m = HK_WRITE_RX.exec(t))) pushNum("write", "", m[1], m[2], m);
    SYM_RX.lastIndex = 0;
    while ((m = SYM_RX.exec(t))) {
        const vStart = m.index + m[0].length - m[3].length;
        refs.push({ kind: "symbol", hookName: m[1], method: m[2], value: m[3], start: vStart, end: vStart + m[3].length, stmtStart: m.index });
    }
    LOOKUP_RX.lastIndex = 0;
    while ((m = LOOKUP_RX.exec(t))) {
        const vStart = m.index + m[0].length - m[1].length;
        refs.push({ kind: "symbol", hookName: "", method: "LookupSymbol", value: m[1], start: vStart, end: vStart + m[1].length, stmtStart: m.index });
    }
    OFF_RX.lastIndex = 0;
    while ((m = OFF_RX.exec(t))) {
        const raw = m[3];
        const vStart = m.index + m[0].length - raw.length;
        const num = parseInt(raw.replace(/'/g, ""), raw.startsWith("0x") ? 16 : 10);
        refs.push({ kind: m[2] === "InstallAtPtr" ? "ptr" : "offset", hookName: m[1], method: m[2], value: raw, num, start: vStart, end: vStart + raw.length, stmtStart: m.index });
    }
    PATCH_RX.lastIndex = 0;
    while ((m = PATCH_RX.exec(t))) {
        const raw = m[2];
        const vStart = m.index + m[0].length - raw.length;
        refs.push({ kind: "patch", hookName: "", method: m[1], value: raw, num: parseInt(raw.replace(/'/g, ""), 16), start: vStart, end: vStart + raw.length, stmtStart: m.index });
    }
    refs.sort((a, b) => a.start - b.start);
    return { refs, defs };
}

/**
 * Extracts the name components of a simple Itanium symbol without fully demangling it:
 *   _ZN5Shine6exeGotEv -> ["Shine", "exeGot"] ; _ZN2al8setNerveEPNS_9IUseNerveEPKNS_5NerveE -> ["al","setNerve"]
 */
export function mangledNameParts(sym: string): string[] {
    let s = sym;
    if (!s.startsWith("_Z")) return [];
    s = s.slice(2);
    const parts: string[] = [];
    const readName = (): boolean => {
        const m = /^(\d+)/.exec(s);
        if (!m) return false;
        const n = parseInt(m[1], 10);
        const name = s.slice(m[1].length, m[1].length + n);
        if (name.length !== n) return false;
        parts.push(name);
        s = s.slice(m[1].length + n);
        return true;
    };
    if (s.startsWith("N")) {
        s = s.slice(1);
        while (/^[KVrRO]/.test(s)) s = s.slice(1);
        if (s.startsWith("St")) {
            parts.push("std");
            s = s.slice(2);
        }
        for (;;) {
            if (s.startsWith("E")) break;
            if (s.startsWith("C1") || s.startsWith("C2") || s.startsWith("C3")) {
                parts.push(parts[parts.length - 1] ?? "");
                s = s.slice(2);
                continue;
            }
            if (s.startsWith("D0") || s.startsWith("D1") || s.startsWith("D2")) {
                parts.push("~" + (parts[parts.length - 1] ?? ""));
                s = s.slice(2);
                continue;
            }
            if (s.startsWith("I")) {
                // template arguments: skip to the matching E
                let depth = 0;
                let i = 0;
                for (; i < s.length; i++) {
                    if (s[i] === "I") depth++;
                    else if (s[i] === "E") {
                        depth--;
                        if (depth === 0) break;
                    }
                }
                s = s.slice(i + 1);
                continue;
            }
            if (!readName()) break;
        }
    } else {
        readName();
    }
    return parts;
}

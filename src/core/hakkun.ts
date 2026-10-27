/**
 * Hakkun (github.com/fruityloops1/LibHakkun) support, pure part (no vscode):
 * framework detection, config/config.cmake, sail .sym files.
 */

export type Framework = "exlaunch" | "hakkun";

/** Framework used by a source file, from its text (undefined = no clue). */
export function frameworkOfText(text: string): Framework | undefined {
    const hk = /#\s*include\s*[<"]hk\/|\bHkTrampoline\b|\bHkReplace\b|\bhkMain\s*\(|\bhk::hook::|\.installAtSym\s*</.test(text);
    const exl = /#\s*include\s*[<"]exlaunch\.hpp|\bHOOK_DEFINE_(TRAMPOLINE|REPLACE|INLINE)\b|\bexl_main\s*\(|\bexl::/.test(text);
    if (hk && !exl) return "hakkun";
    if (exl && !hk) return "exlaunch";
    return undefined;
}

/** Framework of a base folder, from the files it contains. */
export function frameworkOfBase(exists: (rel: string) => boolean): Framework | undefined {
    if (exists("sys/cmake/toolchain.cmake") || exists("sys/hakkun") || exists("config/VersionList.sym")) return "hakkun";
    if (exists("lib/exlaunch") || exists("module/subsdk.json.template") || exists("source/program/main.cpp")) return "exlaunch";
    return undefined;
}

/** set(NAME value...) of a CMake file (last one wins). */
export function parseCMakeSets(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    const t = text.replace(/#[^\n]*/g, "");
    for (const m of t.matchAll(/\bset\s*\(\s*(\w+)\s+([^)]*)\)/gi)) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
    return out;
}

/** project(Name ...) of a CMakeLists.txt */
export function cmakeProjectName(text: string): string | undefined {
    return /\bproject\s*\(\s*([\w.-]+)/i.exec(text.replace(/#[^\n]*/g, ""))?.[1];
}

export interface HakkunConfig {
    moduleName?: string;
    titleId: string; // 16 hex digits, upper case
    moduleBinary: string; // subsdk4...
    useSail: boolean;
    projectName?: string;
}

export function hakkunConfig(configCmake: string, cmakeLists: string): HakkunConfig {
    const s = parseCMakeSets(configCmake);
    const tid = (s.TITLE_ID || "0x0100000000010000").replace(/^0x/i, "").toUpperCase().padStart(16, "0");
    return {
        moduleName: s.MODULE_NAME,
        titleId: tid,
        moduleBinary: s.MODULE_BINARY || "subsdk4",
        useSail: !/^(FALSE|OFF|0|NO)$/i.test(s.USE_SAIL ?? "TRUE"),
        projectName: cmakeProjectName(cmakeLists),
    };
}

// ------------------------------------------------------------------ sail .sym files

export interface SymEntry {
    name: string;
    /** "", or the right-hand side after "=" */
    value: string;
    line: number; // 0-based
    start: number; // column of the name
    end: number;
}

export interface SymBlock {
    module: string;
    /** empty = any version */
    versions: string[];
    line: number;
    entries: SymEntry[];
}

const HEADER_RX = /^\s*@([\w.-]+)\s*(?::\s*([\w\s,]+?))?\s*$/;
const ENTRY_RX = /^(\s*)(\$?[A-Za-z_.$][\w.$@]*)\s*(?:=\s*(.*?))?\s*$/;

function stripLineComment(l: string): string {
    // "//" outside of a string
    let q = false;
    for (let i = 0; i < l.length - 1; i++) {
        if (l[i] === '"') q = !q;
        else if (!q && l[i] === "/" && l[i + 1] === "/") return l.slice(0, i);
    }
    return l;
}

export function parseSym(text: string): SymBlock[] {
    const blocks: SymBlock[] = [];
    let cur: SymBlock | undefined;
    const lines = text.split(/\r?\n/);
    let inBlockComment = false;
    lines.forEach((raw, i) => {
        let l = raw;
        if (inBlockComment) {
            const e = l.indexOf("*/");
            if (e < 0) return;
            l = " ".repeat(e + 2) + l.slice(e + 2);
            inBlockComment = false;
        }
        l = l.replace(/\/\*.*?\*\//g, (m) => " ".repeat(m.length));
        const bc = l.indexOf("/*");
        if (bc >= 0) {
            inBlockComment = true;
            l = l.slice(0, bc);
        }
        l = stripLineComment(l);
        if (!l.trim()) return;
        let m = HEADER_RX.exec(l);
        if (m) {
            cur = { module: m[1], versions: (m[2] ?? "").split(/[\s,]+/).filter(Boolean), line: i, entries: [] };
            blocks.push(cur);
            return;
        }
        m = ENTRY_RX.exec(l);
        if (m) {
            if (!cur) {
                cur = { module: "", versions: [], line: -1, entries: [] };
                blocks.push(cur);
            }
            const start = m[1].length;
            cur.entries.push({ name: m[2], value: (m[3] ?? "").trim(), line: i, start, end: start + m[2].length });
        }
    });
    return blocks;
}

/** All symbol names declared in a set of .sym texts. */
export function declaredSymbols(texts: string[]): Set<string> {
    const out = new Set<string>();
    for (const t of texts) for (const b of parseSym(t)) for (const e of b.entries) if (!e.name.startsWith("$")) out.add(e.name);
    return out;
}

/** Alias of the game module in VersionList.sym ("@smo = RedStar.nss" -> "smo"). */
export function gameModuleAlias(versionList: string | undefined): string {
    if (!versionList) return "smo";
    let first: string | undefined;
    let cur: { alias: string; value: string; versions: number } | undefined;
    const mods: { alias: string; value: string; versions: number }[] = [];
    for (const raw of versionList.split(/\r?\n/)) {
        const l = stripLineComment(raw).trim();
        if (!l) continue;
        const m = /^@([\w.-]+)\s*(?:=\s*(\S+))?/.exec(l);
        if (m) {
            cur = { alias: m[1], value: m[2] ?? "", versions: 0 };
            mods.push(cur);
            first ??= m[1];
        } else if (cur && /^\w+\s*=/.test(l)) cur.versions++;
    }
    const game = mods.find((x) => x.versions > 0 && !/^(nnrtld|nnSdk|rtld|sdk)$/i.test(x.value) && !/^(rtld|sdk)$/i.test(x.alias));
    return game?.alias ?? (mods.some((x) => x.alias === "smo") ? "smo" : first ?? "smo");
}

/**
 * .sym file for a function declared in `declPath` (OdysseyDecomp path), mirroring the header tree like
 * Hakkun-Example: src/Item/Shine.h -> game/Item/Shine.sym ; lib/al/Library/X.h -> al/Library/X.sym ;
 * lib/sead/include/prim/seadSafeString.h -> sead/prim/seadSafeString.sym ; .../include/nn/hid.h -> nn/hid.sym
 */
export function symFileFor(declPath: string | undefined): string {
    const p = (declPath || "").replace(/\\/g, "/");
    let rel: string | undefined;
    let m: RegExpExecArray | null;
    if ((m = /^src\/(.+)\.(h|hpp|cpp)$/.exec(p))) rel = "game/" + m[1];
    else if ((m = /^lib\/al\/(.+)\.(h|hpp|cpp)$/.exec(p))) rel = "al/" + m[1];
    else if ((m = /^lib\/sead\/(?:include|modules\/include|modules\/src|src)\/(.+)\.(h|hpp|cpp)$/.exec(p))) rel = "sead/" + m[1];
    else if ((m = /^lib\/(?:NintendoSDK|NintendoSDK-NEX)\/(?:include|modules\/include)\/(.+)\.(h|hpp)$/.exec(p))) rel = m[1];
    else if ((m = /^lib\/(\w+)\/(?:include\/)?(.+)\.(h|hpp|cpp)$/.exec(p))) rel = `${m[1]}/${m[2]}`;
    return (rel ?? "odysseydoc") + ".sym";
}

export function sameVersions(a: string[], b: string[]): boolean {
    const x = [...a].sort().join(",");
    const y = [...b].sort().join(",");
    return x === y;
}

/**
 * Adds a dynamic symbol (bare name, looked up by name at runtime) to a .sym text, under
 * "@<module>:<versions>". Returns the new text, or undefined if the symbol is already there.
 */
export function addSymbolToSymText(text: string, sym: string, module: string, versions: string[]): string | undefined {
    const blocks = parseSym(text);
    if (blocks.some((b) => b.entries.some((e) => e.name === sym))) return undefined;
    const lines = text.length ? text.split(/\r?\n/) : [];
    const eol = /\r\n/.test(text) ? "\r\n" : "\n";
    const target = blocks.find((b) => b.module === module && sameVersions(b.versions, versions) && b.entries.every((e) => !e.value || /^"/.test(e.value)));
    if (target) {
        const after = target.entries.length ? target.entries[target.entries.length - 1].line : target.line;
        lines.splice(after + 1, 0, sym);
        return lines.join(eol);
    }
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    const header = `@${module}${versions.length ? ":" + versions.join(",") : ""}`;
    if (lines.length) lines.push("");
    lines.push(header, "", sym, "");
    return lines.join(eol);
}

/** "shineIsGotHook" style variable name from an exlaunch-style hook name ("ShineIsGotHook"). */
export function hkVarName(hookName: string): string {
    return hookName.charAt(0).toLowerCase() + hookName.slice(1);
}

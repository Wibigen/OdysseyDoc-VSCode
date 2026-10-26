/** Rewrites compile_commands.json (devkitA64 gcc, WSL paths) for clangd. */

export interface CompileEntry {
    directory: string;
    file: string;
    command?: string;
    arguments?: string[];
    output?: string;
}

export function shellSplit(cmd: string): string[] {
    const out: string[] = [];
    let cur = "";
    let has = false;
    let q: string | null = null;
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (q) {
            if (c === q) q = null;
            else if (c === "\\" && q === '"' && i + 1 < cmd.length && /["\\$`]/.test(cmd[i + 1])) cur += cmd[++i];
            else cur += c;
        } else if (c === "'" || c === '"') {
            q = c;
            has = true;
        } else if (c === "\\" && i + 1 < cmd.length) {
            cur += cmd[++i];
            has = true;
        } else if (/\s/.test(c)) {
            if (has || cur) out.push(cur);
            cur = "";
            has = false;
        } else {
            cur += c;
            has = true;
        }
    }
    if (has || cur) out.push(cur);
    return out;
}

/** Parses the output of `g++ -xc++ -E -v -`: the "#include <...> search starts here" list. */
export function parseGccIncludeDirs(out: string): string[] {
    const lines = out.split(/\r?\n/);
    const s = lines.findIndex((l) => l.includes("#include <...> search starts here"));
    if (s < 0) return [];
    const dirs: string[] = [];
    for (let i = s + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith("End of search list")) break;
        const d = l.trim();
        if (d) dirs.push(d.replace(/\s+\(framework directory\)$/, ""));
    }
    return dirs;
}

const DROP_EXACT = new Set(["-fdiagnostics-color", "-fdiagnostics-color=always", "-mtp=soft", "-fno-allow-store-data-races"]);
const DROP_PREFIX = ["-mtp=", "-specs", "--specs", "-fdiagnostics-color", "-fplugin", "-fdump"];
const PATH_FLAGS_JOINED = ["-I", "-isystem", "-iquote", "-idirafter", "-include", "-imacros", "--sysroot=", "-isysroot", "-L"];
const PATH_FLAGS_SEPARATE = new Set(["-I", "-isystem", "-iquote", "-idirafter", "-include", "-imacros", "-isysroot", "-o", "-MF", "-MT", "-MQ", "--sysroot", "-L"]);

export interface TransformOptions {
    mapPath: (p: string) => string;
    /** gcc system include dirs (build-side paths) */
    gccIncludes: string[];
    readFile?: (hostPath: string) => string | undefined;
}

/** Keeps only the "library" header dirs (libstdc++ / newlib): clang ships its own stddef.h, arm_neon.h... */
export function normPosix(p: string): string {
    const out: string[] = [];
    for (const part of p.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") out.pop();
        else out.push(part);
    }
    return (p.startsWith("/") ? "/" : "") + out.join("/");
}

export function selectSystemDirs(dirs: string[]): string[] {
    return dirs.map(normPosix).filter((d) => !/\/lib\/gcc\/[^/]+\/[^/]+\/include(-fixed)?\/?$/.test(d));
}

export function transformEntry(e: CompileEntry, o: TransformOptions): CompileEntry {
    let args = e.arguments ? [...e.arguments] : shellSplit(e.command ?? "");
    // @file response files
    const expanded: string[] = [];
    for (const a of args) {
        if (a.startsWith("@") && o.readFile) {
            const p = a.slice(1);
            const abs = p.startsWith("/") ? p : `${e.directory.replace(/\/$/, "")}/${p}`;
            const txt = o.readFile(o.mapPath(abs));
            if (txt !== undefined) {
                expanded.push(...shellSplit(txt));
                continue;
            }
        }
        expanded.push(a);
    }
    args = expanded;
    const out: string[] = ["clang++"];
    for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (DROP_EXACT.has(a) || DROP_PREFIX.some((p) => a.startsWith(p))) {
            if ((a === "-specs" || a === "--specs") && i + 1 < args.length) i++;
            continue;
        }
        if (a === "-o" || a === "-MF" || a === "-MT" || a === "-MQ") {
            i++; // not needed by clangd
            continue;
        }
        if (a === "-MD" || a === "-MMD" || a === "-MP") continue;
        if (PATH_FLAGS_SEPARATE.has(a) && i + 1 < args.length) {
            out.push(a, args[i + 1].startsWith("/") ? o.mapPath(args[i + 1]) : args[i + 1]);
            i++;
            continue;
        }
        const jf = PATH_FLAGS_JOINED.find((f) => a.startsWith(f) && a.length > f.length && a[f.length] === "/");
        if (jf) {
            out.push(jf + o.mapPath(a.slice(jf.length)));
            continue;
        }
        if (a.startsWith("/")) {
            out.push(o.mapPath(a));
            continue;
        }
        out.push(a);
    }
    const sys = selectSystemDirs(o.gccIncludes);
    const extra = ["--target=aarch64-none-elf", "-nostdlibinc", "-nostdinc++", "-Wno-unknown-warning-option", "-Wno-unused-command-line-argument", "-Wno-gnu-string-literal-operator-template"];
    for (const d of sys) extra.push("-isystem", o.mapPath(d));
    // insert the options right after the compiler (before -c file)
    out.splice(1, 0, ...extra);
    return { directory: o.mapPath(e.directory), file: e.file.startsWith("/") ? o.mapPath(e.file) : e.file, arguments: out };
}

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { addSymbolToSymText, declaredSymbols, Framework, gameModuleAlias, symFileFor } from "./core/hakkun";
import { baseFramework, buildDir, cfg, projectRoot, readHakkunConfig, subsdkName } from "./env";

/** Name of the mod entry point for a framework. */
export function entryName(fw: Framework): string {
    return fw === "hakkun" ? "hkMain" : "exl_main";
}

export const ENTRY_RX = /\b(exl_main|hkMain)\s*\(/;

// ---------------------------------------------------------------- sail symbol database (syms/*.sym)

function walkSyms(dir: string, out: string[], depth = 0) {
    if (depth > 12) return;
    let list: fs.Dirent[];
    try {
        list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of list) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkSyms(p, out, depth + 1);
        else if (e.name.endsWith(".sym")) out.push(p);
    }
}

/** .sym files read by sail: <base>/syms/**, <base>/sys/addons/<addon>/syms/** */
export function symFiles(root: vscode.Uri): string[] {
    const out: string[] = [];
    walkSyms(path.join(root.fsPath, "syms"), out);
    try {
        for (const a of fs.readdirSync(path.join(root.fsPath, "sys", "addons"))) walkSyms(path.join(root.fsPath, "sys", "addons", a, "syms"), out);
    } catch {
        /* no addons */
    }
    return out;
}

class SymDb {
    private key = "";
    private names = new Set<string>();
    private readonly _onChange = new vscode.EventEmitter<void>();
    readonly onChange = this._onChange.event;

    /** Symbols declared in the base's .sym files (cached on file list + mtimes). */
    declared(root: vscode.Uri): Set<string> {
        const files = symFiles(root);
        const sig = files.map((f) => {
            try {
                return f + ":" + fs.statSync(f).mtimeMs;
            } catch {
                return f;
            }
        });
        const k = root.fsPath + "|" + sig.join("|");
        if (k !== this.key) {
            const texts: string[] = [];
            for (const f of files) {
                try {
                    texts.push(fs.readFileSync(f, "utf8"));
                } catch {
                    /* ignore */
                }
            }
            this.names = declaredSymbols(texts);
            this.key = k;
        }
        return this.names;
    }

    changed() {
        this.key = "";
        this._onChange.fire();
    }
}

export const symDb = new SymDb();

/** true when the base is a Hakkun base that uses sail (symbols must be declared in syms/). */
export function usesSail(root?: vscode.Uri): boolean {
    const r = root ?? projectRoot();
    if (!r || baseFramework(r) !== "hakkun") return false;
    return readHakkunConfig(r).useSail;
}

export function symbolVersions(): string[] {
    return cfg<string>("hakkun.symbolVersions", "100,101,110,120")
        .split(/[\s,]+/)
        .filter(Boolean);
}

/**
 * Declares a game symbol in the base's syms/ (dynamic symbol, looked up by name in the game module).
 * Returns the .sym file written (relative to the base), "" if it was already declared, undefined without a Hakkun base.
 */
export function addSymbolToSyms(sym: string, declPath: string | undefined): string | undefined {
    const root = projectRoot();
    if (!root || baseFramework(root) !== "hakkun") return undefined;
    if (symDb.declared(root).has(sym)) return "";
    let versionList: string | undefined;
    try {
        versionList = fs.readFileSync(path.join(root.fsPath, "config", "VersionList.sym"), "utf8");
    } catch {
        /* default module "smo" */
    }
    const rel = path.join("syms", ...symFileFor(declPath).split("/"));
    const file = path.join(root.fsPath, rel);
    let text = "";
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        /* new file */
    }
    const next = addSymbolToSymText(text, sym, gameModuleAlias(versionList), symbolVersions());
    if (next === undefined) return "";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
    symDb.changed();
    return rel;
}

// ---------------------------------------------------------------- build outputs

export interface OutputFile {
    local: string;
    /** name in exefs */
    name: string;
}

/** Files to copy next to the .cpp / to deploy into exefs. */
export function buildOutputs(root: vscode.Uri): { files: OutputFile[]; missing: string[] } {
    const bd = buildDir(root);
    const files: OutputFile[] = [];
    const missing: string[] = [];
    const want = (local: string, name: string) => (fs.existsSync(local) ? files.push({ local, name }) : missing.push(local));
    if (baseFramework(root) === "hakkun") {
        const c = readHakkunConfig(root);
        // Hakkun's deploy.py lays the files out in build/sd/atmosphere/contents/<TID>/exefs
        const exefs = path.join(bd, "sd", "atmosphere", "contents", c.titleId, "exefs");
        const nso = path.join(bd, `${c.projectName ?? c.moduleName ?? "main"}.nso`);
        const fromExefs = path.join(exefs, c.moduleBinary);
        if (fs.existsSync(nso) || !fs.existsSync(fromExefs)) want(nso, c.moduleBinary);
        else want(fromExefs, c.moduleBinary);
        const npdm = path.join(bd, "main.npdm");
        if (fs.existsSync(npdm) || !fs.existsSync(path.join(exefs, "main.npdm"))) want(npdm, "main.npdm");
        else want(path.join(exefs, "main.npdm"), "main.npdm");
        const rtld = path.join(bd, "rtld.nso");
        if (fs.existsSync(rtld) && fs.existsSync(path.join(exefs, "rtld"))) files.push({ local: rtld, name: "rtld" });
    } else {
        const sub = subsdkName(root);
        want(path.join(bd, sub), sub);
        want(path.join(bd, "main.npdm"), "main.npdm");
    }
    return { files, missing };
}

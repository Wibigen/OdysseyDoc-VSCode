import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { cfg, ensureBase } from "./env";
import { DocState } from "./state";

/** File copied into the base: path in the base -> original file (to remap errors). */
export interface SyncedFile {
    inBase: string;
    origin: string;
    written: boolean;
}

export interface SyncResult {
    root: vscode.Uri;
    files: SyncedFile[];
    backupDir?: string;
    /** the .cpp is already inside the base: nothing was copied */
    insideBase: boolean;
}

const HASHES_KEY = "odysseydoc.syncedHashes";

function sha(buf: Buffer | string) {
    return crypto.createHash("sha1").update(buf).digest("hex");
}

export function samePath(a: string, b: string): boolean {
    const n = (p: string) => {
        const r = path.resolve(p);
        return process.platform === "win32" ? r.toLowerCase() : r;
    };
    return n(a) === n(b);
}

export function isInside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Local #include "..." files (next to the .cpp), recursively. */
function localIncludes(file: string, srcRoot: string, seen = new Set<string>(), depth = 0): string[] {
    if (depth > 6) return [];
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return [];
    }
    const out: string[] = [];
    for (const m of text.matchAll(/^\s*#\s*include\s*"([^"]+)"/gm)) {
        const cand = path.resolve(path.dirname(file), m[1]);
        if (!isInside(cand, srcRoot) || seen.has(cand) || !fs.existsSync(cand)) continue;
        seen.add(cand);
        out.push(cand);
        out.push(...localIncludes(cand, srcRoot, seen, depth + 1));
    }
    return out;
}

function backupRoot(st: DocState) {
    return path.join(st.storage, "backups");
}

function pruneBackups(st: DocState, keep = 15) {
    try {
        const dirs = fs.readdirSync(backupRoot(st)).sort();
        for (const d of dirs.slice(0, Math.max(0, dirs.length - keep))) fs.rmSync(path.join(backupRoot(st), d), { recursive: true, force: true });
    } catch {
        /* ignore */
    }
}

/**
 * Copies the .cpp to <base>/src/main.cpp (replacing the old one) and, if enabled, the local headers
 * it includes. Any overwritten base file that was not written by the extension is backed up first.
 */
export async function syncToBase(st: DocState, src: vscode.Uri): Promise<SyncResult | undefined> {
    const root = await ensureBase("to copy your .cpp into it");
    if (!root) return undefined;
    const srcPath = src.fsPath;
    if (isInside(srcPath, root.fsPath)) return { root, files: [], insideBase: true };

    const hashes = st.ctx.globalState.get<Record<string, string>>(HASHES_KEY, {});
    const plan: { from: string; to: string }[] = [{ from: srcPath, to: path.join(root.fsPath, "src", "main.cpp") }];
    if (cfg<boolean>("base.copyLocalIncludes", true)) {
        const dir = path.dirname(srcPath);
        for (const inc of localIncludes(srcPath, dir)) plan.push({ from: inc, to: path.join(root.fsPath, "src", path.relative(dir, inc)) });
    }

    let backupDir: string | undefined;
    const files: SyncedFile[] = [];
    for (const { from, to } of plan) {
        const data = fs.readFileSync(from);
        const h = sha(data);
        let cur: Buffer | undefined;
        try {
            cur = fs.readFileSync(to);
        } catch {
            cur = undefined;
        }
        if (cur && sha(cur) === h) {
            files.push({ inBase: to, origin: from, written: false });
            continue;
        }
        // back up the old file if it was not written by the extension
        if (cur && hashes[to] !== sha(cur)) {
            if (!backupDir) {
                const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..*$/, "");
                backupDir = path.join(backupRoot(st), stamp);
            }
            const dst = path.join(backupDir, path.relative(root.fsPath, to));
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.writeFileSync(dst, cur);
            fs.writeFileSync(path.join(backupDir, ".origin"), root.fsPath);
        }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, data);
        hashes[to] = h;
        files.push({ inBase: to, origin: from, written: true });
    }
    await st.ctx.globalState.update(HASHES_KEY, hashes);
    if (backupDir) pruneBackups(st);
    const n = files.filter((f) => f.written).length;
    st.log(`Copied to the base: ${n} file(s) written (${files.map((f) => path.relative(root.fsPath, f.inBase)).join(", ")})${backupDir ? `, previous version backed up in ${backupDir}` : ""}`);
    return { root, files, backupDir, insideBase: false };
}

export async function copyToBaseCommand(st: DocState, uri?: vscode.Uri) {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== "file" || !/\.(cpp|cc|cxx|c)$/i.test(target.fsPath)) {
        vscode.window.showWarningMessage("Open your mod's .cpp to copy it into the base.");
        return;
    }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target.toString());
    if (doc?.isDirty) await doc.save();
    const r = await syncToBase(st, target);
    if (!r) return;
    if (r.insideBase) {
        vscode.window.showInformationMessage("This file is already part of the exlaunch base: nothing to copy.");
        return;
    }
    const extra = r.files.length > 1 ? ` (+ ${r.files.length - 1} local header(s))` : "";
    vscode.window.showInformationMessage(
        `${path.basename(target.fsPath)} copied to ${path.join(path.basename(r.root.fsPath), "src", "main.cpp")}${extra}.${r.backupDir ? " The previous main.cpp was backed up." : ""}`,
    );
}

export async function restoreBackupCommand(st: DocState) {
    let dirs: string[] = [];
    try {
        dirs = fs.readdirSync(backupRoot(st)).sort().reverse();
    } catch {
        /* aucune */
    }
    if (!dirs.length) {
        vscode.window.showInformationMessage("No backup of the base yet.");
        return;
    }
    const items = dirs.map((d) => {
        const full = path.join(backupRoot(st), d);
        const list: string[] = [];
        const walk = (p: string, rel = "") => {
            for (const e of fs.readdirSync(p, { withFileTypes: true })) {
                if (e.name === ".origin") continue;
                if (e.isDirectory()) walk(path.join(p, e.name), path.join(rel, e.name));
                else list.push(path.join(rel, e.name));
            }
        };
        walk(full);
        let origin = "";
        try {
            origin = fs.readFileSync(path.join(full, ".origin"), "utf8");
        } catch {
            /* ignore */
        }
        return { label: d.replace(/^(\d{4}-\d\d-\d\d)-(\d\d)-(\d\d)-(\d\d)$/, "$1 $2:$3:$4 UTC"), description: list.join(", "), detail: origin, full, list, origin };
    });
    const pick = await vscode.window.showQuickPick(items, { title: "Restore files of the exlaunch base" });
    if (!pick || !pick.origin) return;
    for (const rel of pick.list) {
        const dst = path.join(pick.origin, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(pick.full, rel), dst);
    }
    vscode.window.showInformationMessage(`Restored in the base: ${pick.list.join(", ")}`);
}

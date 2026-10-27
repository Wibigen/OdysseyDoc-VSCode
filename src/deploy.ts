import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FtpClient } from "./core/ftp";
import { cfg, ensureBase, projectRoot, titleId } from "./env";
import { buildOutputs } from "./framework";
import { DocState } from "./state";

export type Layout = "atmosphere" | "ryujinx" | "yuzu" | "exefs";

export interface DeployTarget {
    name?: string;
    type: "folder" | "ftp";
    enabled?: boolean;
    /** folder: SD card root / emulator mods folder / exefs folder */
    path?: string;
    layout?: Layout;
    modName?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    /** ftp: remote root (default "/", the SD root) */
    remoteRoot?: string;
}

interface FilePlan {
    local: string;
    rel: string; // relative to the layout root
}

function layoutDirs(layout: Layout, tid: string, modName: string): { exefs: string; romfs: string } {
    switch (layout) {
        case "ryujinx":
            return { exefs: `mods/contents/${tid.toLowerCase()}/${modName}/exefs`, romfs: `mods/contents/${tid.toLowerCase()}/${modName}/romfs` };
        case "yuzu":
            return { exefs: `${tid}/${modName}/exefs`, romfs: `${tid}/${modName}/romfs` };
        case "exefs":
            return { exefs: ``, romfs: `../romfs` };
        default:
            return { exefs: `atmosphere/contents/${tid}/exefs`, romfs: `atmosphere/contents/${tid}/romfs` };
    }
}

function walkFiles(dir: string, base = dir, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkFiles(p, base, out);
        else out.push(path.relative(base, p).split(path.sep).join("/"));
    }
    return out;
}

function plan(root: vscode.Uri, layout: Layout, modName: string): { files: FilePlan[]; missing: string[] } {
    const tid = titleId(root);
    const dirs = layoutDirs(layout, tid, modName);
    const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
    const out = buildOutputs(root);
    const files: FilePlan[] = out.files.map((f) => ({ local: f.local, rel: join(dirs.exefs, f.name) }));
    const missing = out.missing;
    const romfs = cfg<string>("deploy.romfsDir", "");
    if (romfs) {
        const rd = path.isAbsolute(romfs) ? romfs : path.join(root.fsPath, romfs);
        if (fs.existsSync(rd)) for (const rel of walkFiles(rd)) files.push({ local: path.join(rd, rel), rel: path.posix.normalize(join(dirs.romfs, rel)) });
    }
    return { files, missing };
}

function expandHome(p: string): string {
    if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
    return p.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`);
}

export async function deployAll(st: DocState, log: (s: string) => void): Promise<boolean> {
    const root = await ensureBase("to deploy");
    if (!root) return false;
    const targets = cfg<DeployTarget[]>("deploy.targets", []).filter((t) => t.enabled !== false);
    if (!targets.length) {
        log("No deploy target: command \"OdysseyDoc: Add a deploy target\".");
        const pick = await vscode.window.showInformationMessage("No deploy target configured.", "Add a target");
        if (pick) await vscode.commands.executeCommand("odysseydoc.addDeployTarget");
        return false;
    }
    let allOk = true;
    for (const t of targets) {
        const layout = t.layout ?? (t.type === "ftp" ? "atmosphere" : "atmosphere");
        const modName = t.modName || cfg<string>("deploy.modName", "") || path.basename(root.fsPath);
        const { files, missing } = plan(root, layout, modName);
        const label = t.name || (t.type === "ftp" ? `FTP ${t.host}` : t.path ?? "?");
        if (missing.length) {
            log(`✘ ${label}: build outputs missing (${missing.map((m) => path.basename(m)).join(", ")}). Build first.`);
            allOk = false;
            continue;
        }
        try {
            if (t.type === "folder") {
                if (!t.path) throw new Error("path missing");
                const base = expandHome(t.path);
                if (!fs.existsSync(base)) throw new Error(`folder not found: ${base} (SD card not plugged in?)`);
                for (const f of files) {
                    const dst = path.join(base, ...f.rel.split("/"));
                    fs.mkdirSync(path.dirname(dst), { recursive: true });
                    fs.copyFileSync(f.local, dst);
                }
                log(`✔ ${label}: ${files.length} file(s) copied → ${path.join(base, ...layoutDirs(layout, titleId(root), modName).exefs.split("/"))}`);
            } else {
                if (!t.host) throw new Error("console IP address missing");
                const client = new FtpClient({
                    host: t.host,
                    port: t.port ?? 5000,
                    user: t.user,
                    password: t.password,
                    log: cfg<boolean>("deploy.ftpVerbose", false) ? (s) => st.log(s) : undefined,
                });
                await client.connect();
                const rroot = (t.remoteRoot ?? "/").replace(/\/+$/, "");
                const made = new Set<string>();
                let bytes = 0;
                for (const f of files) {
                    const remote = `${rroot}/${f.rel}`.replace(/\/+/g, "/");
                    const dir = path.posix.dirname(remote);
                    if (!made.has(dir)) {
                        await client.mkdirp(dir);
                        made.add(dir);
                    }
                    bytes += await client.upload(f.local, remote);
                }
                await client.quit();
                log(`✔ ${label}: ${files.length} file(s) uploaded (${(bytes / 1024).toFixed(0)} KiB)`);
            }
        } catch (e) {
            allOk = false;
            log(`✘ ${label}: ${e instanceof Error ? e.message : e}`);
        }
    }
    return allOk;
}

export async function addDeployTargetWizard() {
    const type = await vscode.window.showQuickPick(
        [
            { label: "$(folder) Folder", description: "SD card, emulator mods folder…", v: "folder" as const },
            { label: "$(remote) FTP (Switch)", description: "ftpd / sys-ftpd on the console", v: "ftp" as const },
        ],
        { title: "New deploy target" },
    );
    if (!type) return;
    const t: DeployTarget = { type: type.v };
    if (type.v === "folder") {
        const layout = await vscode.window.showQuickPick(
            [
                { label: "Atmosphère (SD card)", description: "<root>/atmosphere/contents/<TID>/exefs", v: "atmosphere" as Layout },
                { label: "Ryujinx", description: "<Ryujinx folder>/mods/contents/<tid>/<mod>/exefs", v: "ryujinx" as Layout },
                { label: "yuzu and forks (Eden, Citron, Sudachi…)", description: "<load folder>/<TID>/<mod>/exefs", v: "yuzu" as Layout },
                { label: "Plain exefs folder", description: "copies subsdk + main.npdm straight into the chosen folder", v: "exefs" as Layout },
            ],
            { title: "File layout" },
        );
        if (!layout) return;
        t.layout = layout.v;
        const hint =
            layout.v === "ryujinx"
                ? "Pick the Ryujinx folder (containing \"mods\"), e.g. %APPDATA%\\Ryujinx"
                : layout.v === "yuzu"
                  ? "Pick the emulator's \"load\" folder"
                  : layout.v === "atmosphere"
                    ? "Pick the SD card root"
                    : "Pick the exefs folder";
        const dir = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: hint, openLabel: "Select" });
        if (!dir?.[0]) return;
        t.path = dir[0].fsPath;
        if (layout.v === "ryujinx" || layout.v === "yuzu") {
            const mod = await vscode.window.showInputBox({ title: "Mod name (folder)", value: path.basename(projectRoot()?.fsPath ?? "MyMod") });
            if (mod === undefined) return;
            t.modName = mod;
        }
        t.name = `${layout.label.split(" (")[0]} — ${t.path}`;
    } else {
        const host = await vscode.window.showInputBox({ title: "Switch IP address", placeHolder: "192.168.1.42", validateInput: (v) => (/^[\w.-]+$/.test(v) ? undefined : "Invalid address") });
        if (!host) return;
        const port = await vscode.window.showInputBox({ title: "FTP port", value: "5000" });
        if (port === undefined) return;
        const user = await vscode.window.showInputBox({ title: "User (empty = anonymous)", value: "" });
        if (user === undefined) return;
        const password = user ? await vscode.window.showInputBox({ title: "Password", password: true }) : "";
        if (password === undefined) return;
        Object.assign(t, { host, port: parseInt(port, 10) || 5000, user: user || undefined, password: password || undefined, layout: "atmosphere", remoteRoot: "/", name: `Switch FTP ${host}` });
    }
    const conf = vscode.workspace.getConfiguration("odysseydoc");
    const list = conf.get<DeployTarget[]>("deploy.targets", []);
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await conf.update("deploy.targets", [...list, t], target);
    vscode.window.showInformationMessage(`Target added: ${t.name}. Saved in the ${target === vscode.ConfigurationTarget.Workspace ? "workspace" : "user"} settings.`);
}

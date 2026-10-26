import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { identityMapper, makeWslMapper, PathMapper, shQuote, uncDistro, winToWsl, wslToWin } from "./core/paths";

export function cfg<T>(key: string, def: T): T {
    return vscode.workspace.getConfiguration("odysseydoc").get<T>(key, def);
}

/** Does a folder look like an exlaunch base (SMO-Exlaunch-Base)? */
export function isExlaunchBase(dir: string): boolean {
    try {
        return (
            fs.existsSync(path.join(dir, "CMakeLists.txt")) &&
            (fs.existsSync(path.join(dir, "lib", "exlaunch")) || fs.existsSync(path.join(dir, "module", "subsdk.json.template")))
        );
    } catch {
        return false;
    }
}

/** Path typed in the setting -> path usable by VS Code ("/home/x" on Windows -> \\wsl.localhost\<distro>\home\x). */
export function resolveBasePath(p: string): string {
    let s = p.trim().replace(/^["']|["']$/g, "");
    if (s.startsWith("~") && process.platform !== "win32") s = path.join(os.homedir(), s.slice(1));
    if (process.platform === "win32" && s.startsWith("/")) {
        const mount = cfg<string>("build.wslMountRoot", "/mnt/");
        s = wslToWin(s, cfg<string>("build.wslDistro", "") || defaultWslDistro(), mount);
    }
    return s.replace(/[\\/]+$/, "");
}

/**
 * exlaunch base used for building. Order: the odysseydoc.exlaunchBase setting (located once and for all),
 * then a folder open in VS Code that is itself a base.
 */
export function projectRoot(): vscode.Uri | undefined {
    const setting = cfg<string>("exlaunchBase", "");
    if (setting) {
        const p = resolveBasePath(setting);
        if (fs.existsSync(p)) return vscode.Uri.file(p);
    }
    for (const f of vscode.workspace.workspaceFolders ?? []) {
        if (isExlaunchBase(f.uri.fsPath)) return f.uri;
    }
    return undefined;
}

/** Asks the user where their exlaunch base is and saves it (user setting). */
export async function locateBase(reason?: string): Promise<vscode.Uri | undefined> {
    const pick = await vscode.window.showQuickPick(
        [
            { label: "$(folder-opened) Pick the folder…", description: "file dialog (\\\\wsl.localhost\\… works)", v: "dialog" },
            { label: "$(terminal-linux) Type a path", description: "e.g. /home/me/SMO-Exlaunch-Base or C:\\Mods\\SMO-Exlaunch-Base", v: "type" },
        ],
        { title: reason ? `Locate the exlaunch base — ${reason}` : "Locate the exlaunch base", placeHolder: "Folder containing CMakeLists.txt, Makefile, lib/exlaunch, src/…" },
    );
    if (!pick) return undefined;
    let chosen: string | undefined;
    if (pick.v === "dialog") {
        const r = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: "Base exlaunch (SMO-Exlaunch-Base)", openLabel: "Use this base" });
        chosen = r?.[0]?.fsPath;
    } else {
        chosen = await vscode.window.showInputBox({ title: "Path of the exlaunch base", prompt: "Windows path, UNC path or WSL Linux path", value: cfg<string>("exlaunchBase", "") });
    }
    if (!chosen) return undefined;
    const resolved = resolveBasePath(chosen);
    if (!fs.existsSync(resolved)) {
        vscode.window.showErrorMessage(`Folder not found: ${resolved}`);
        return undefined;
    }
    if (!isExlaunchBase(resolved)) {
        const ok = await vscode.window.showWarningMessage(
            `${resolved} does not look like an exlaunch base (expected CMakeLists.txt + lib/exlaunch).`,
            "Use it anyway",
            "Cancel",
        );
        if (ok !== "Use it anyway") return undefined;
    }
    await vscode.workspace.getConfiguration("odysseydoc").update("exlaunchBase", chosen.trim(), vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`exlaunch base: ${resolved}`);
    return vscode.Uri.file(resolved);
}

/** The exlaunch base, asking for it if it is not known yet. */
export async function ensureBase(reason?: string): Promise<vscode.Uri | undefined> {
    return projectRoot() ?? (await locateBase(reason));
}

export type ExecKind = "native" | "wsl" | "windows";

export interface ExecEnv {
    kind: ExecKind;
    distro?: string;
    mapper: PathMapper;
    /** project root as seen by the build tool */
    buildRoot: string;
}

let cachedDistro: string | undefined;

/** Name of the default WSL distribution (to build \\wsl.localhost\<distro>\...). */
export function defaultWslDistro(): string | undefined {
    if (cachedDistro !== undefined) return cachedDistro || undefined;
    try {
        const out = cp.execFileSync("wsl.exe", ["-e", "sh", "-c", "echo $WSL_DISTRO_NAME"], { timeout: 8000, windowsHide: true });
        cachedDistro = out.toString("utf8").replace(/\0/g, "").trim();
    } catch {
        cachedDistro = "";
    }
    return cachedDistro || undefined;
}

export function getExecEnv(root?: vscode.Uri): ExecEnv {
    const r = root ?? projectRoot();
    const hostRoot = r?.fsPath ?? process.cwd();
    const mode = cfg<string>("build.useWsl", "auto");
    const onWindows = process.platform === "win32";
    if (!onWindows || mode === "never") {
        return { kind: onWindows ? "windows" : "native", mapper: identityMapper, buildRoot: hostRoot };
    }
    const mountRoot = cfg<string>("build.wslMountRoot", "/mnt/");
    let distro = cfg<string>("build.wslDistro", "") || uncDistro(hostRoot);
    if (!distro) distro = defaultWslDistro();
    return { kind: "wsl", distro, mapper: makeWslMapper(hostRoot, distro, mountRoot), buildRoot: winToWsl(hostRoot, mountRoot) };
}

/** Shell prefix that guarantees DEVKITPRO / PATH even when ~/.bashrc is not read. */
export function envPrefix(): string {
    const extra = cfg<Record<string, string>>("build.env", {});
    const parts = [
        // no double quotes: the line goes through wsl.exe (Windows quoting rules)
        "export DEVKITPRO=${DEVKITPRO:-/opt/devkitpro}",
        "export DEVKITA64=${DEVKITA64:-$DEVKITPRO/devkitA64}",
        "export PATH=$DEVKITPRO/tools/bin:$DEVKITA64/bin:$PATH",
    ];
    for (const [k, v] of Object.entries(extra)) {
        if (/^\w+$/.test(k)) parts.push(`export ${k}=${shQuote(v)}`);
    }
    return parts.join("; ") + "; ";
}

export interface SpawnSpec {
    file: string;
    args: string[];
    options: cp.SpawnOptions;
    display: string;
}

/** Builds the command to run (bash -lc in WSL, or native). */
export function shellSpawn(command: string, env: ExecEnv, cwdHost: string): SpawnSpec {
    const cwdBuild = env.mapper.toBuild(cwdHost);
    if (env.kind === "wsl") {
        const script = `${envPrefix()}cd ${shQuote(cwdBuild)} && ${command}`;
        const args = [...(env.distro ? ["-d", env.distro] : []), "-e", "bash", "-lc", script];
        return { file: "wsl.exe", args, options: { windowsHide: true }, display: `wsl ${env.distro ? "-d " + env.distro + " " : ""}» ${command}` };
    }
    if (env.kind === "native") {
        const script = `${envPrefix()}cd ${shQuote(cwdBuild)} && ${command}`;
        return { file: "bash", args: ["-lc", script], options: {}, display: command };
    }
    return { file: command, args: [], options: { cwd: cwdHost, shell: true, windowsHide: true }, display: command };
}

/** Runs a command and returns stdout (for small queries: c++filt, g++ -v...). */
export function runCapture(command: string, env: ExecEnv, cwdHost: string, input?: string, timeoutMs = 60000): Promise<{ code: number; out: string; err: string }> {
    const spec = shellSpawn(command, env, cwdHost);
    return new Promise((resolve) => {
        const p = cp.spawn(spec.file, spec.args, { ...spec.options, stdio: ["pipe", "pipe", "pipe"] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        const t = setTimeout(() => p.kill(), timeoutMs);
        p.stdout?.on("data", (d) => out.push(d));
        p.stderr?.on("data", (d) => err.push(d));
        p.on("error", (e) => {
            clearTimeout(t);
            resolve({ code: -1, out: "", err: String(e) });
        });
        p.on("close", (code) => {
            clearTimeout(t);
            resolve({ code: code ?? -1, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") });
        });
        if (input !== undefined) p.stdin?.end(input);
        else p.stdin?.end();
    });
}

/** subsdk name defined in CMakeLists.txt (set(SUBSDKX subsdk9)). */
export function subsdkName(root: vscode.Uri): string {
    const s = cfg<string>("build.subsdkName", "");
    if (s) return s;
    try {
        const txt = fs.readFileSync(path.join(root.fsPath, "CMakeLists.txt"), "utf8");
        const m = /set\s*\(\s*SUBSDKX\s+(\w+)\s*\)/.exec(txt);
        if (m) return m[1];
    } catch {
        /* ignore */
    }
    return "subsdk9";
}

export function titleId(root: vscode.Uri): string {
    const s = cfg<string>("deploy.titleId", "");
    if (s) return s.replace(/^0x/i, "").toUpperCase();
    try {
        const txt = fs.readFileSync(path.join(root.fsPath, "CMakeLists.txt"), "utf8");
        const m = /set\s*\(\s*CONFIG_TITLE_ID\s+0x([0-9a-fA-F]+)\s*\)/.exec(txt);
        if (m) return m[1].toUpperCase().padStart(16, "0");
    } catch {
        /* ignore */
    }
    return "0100000000010000";
}

export function buildDir(root: vscode.Uri): string {
    return path.join(root.fsPath, cfg<string>("build.outputDir", "build"));
}

import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { GccOutputParser, ParsedDiag } from "./core/gccparse";
import { baseFramework, buildDir, cfg, ensureBase, getExecEnv, projectRoot, shellSpawn } from "./env";
import { syncToBase } from "./base";
import { buildOutputs } from "./framework";
import { shQuote } from "./core/paths";
import { DocState } from "./state";

export type BuildAction = "build" | "clean" | "rebuild" | "configure" | "buildDeploy" | "quick";

/** Quick build: the edited .cpp was copied into the base; its errors are mapped back to the original file. */
interface QuickContext {
    source: string;
    overrides: Map<string, string>;
    outDir: string;
}

function normKey(p: string) {
    const r = path.normalize(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
}

const LABELS: Record<BuildAction, string> = {
    build: "Build",
    clean: "Clean",
    rebuild: "Rebuild all",
    configure: "Configure (CMake)",
    buildDeploy: "Build and deploy",
    quick: "Quick build",
};

/** Hakkun has no Makefile wrapper: plain CMake in the build folder (configured on the first build). */
function hakkunCommands(): { build: string; clean: string; configure: string } {
    const out = shQuote(cfg<string>("build.outputDir", "build"));
    const type = cfg<string>("hakkun.buildType", "Release");
    const configure = cfg<string>("hakkun.configureCommand", "") || `cmake -S . -B ${out} -DCMAKE_BUILD_TYPE=${type}`;
    const build = cfg<string>("hakkun.buildCommand", "") || `{ [ -f ${out}/CMakeCache.txt ] || ${configure}; } && cmake --build ${out} --parallel $(nproc)`;
    const clean = cfg<string>("hakkun.cleanCommand", "") || `cmake --build ${out} --target clean`;
    return { build, clean, configure };
}

function commandFor(action: BuildAction): string {
    const hk = baseFramework() === "hakkun" ? hakkunCommands() : undefined;
    const build = hk?.build ?? cfg<string>("build.command", "make");
    const clean = hk?.clean ?? cfg<string>("build.cleanCommand", "make clean");
    const configure = hk?.configure ?? cfg<string>("build.configureCommand", "make configure");
    switch (action) {
        case "clean":
            return clean;
        case "rebuild":
            return `${clean} && ${build}`;
        case "configure":
            return configure;
        default:
            return build;
    }
}

const C = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    green: "\x1b[32m",
    cyan: "\x1b[36m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
};

export class BuildRunner {
    readonly diagnostics = vscode.languages.createDiagnosticCollection("odysseydoc-build");
    private readonly status: vscode.StatusBarItem;
    running = false;
    private readonly _onBuildDone = new vscode.EventEmitter<{ action: BuildAction; ok: boolean }>();
    readonly onBuildDone = this._onBuildDone.event;
    deployHook: ((log: (s: string) => void) => Promise<boolean>) | undefined;
    private quick: QuickContext | undefined;

    constructor(private st: DocState) {
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
        this.status.command = "odysseydoc.build";
        this.idle();
        this.status.show();
    }

    private idle(text = "$(tools) OdysseyDoc", tooltip = "Build the mod (in the exlaunch / Hakkun base)") {
        this.status.text = text;
        this.status.tooltip = tooltip;
        this.status.backgroundColor = undefined;
    }

    dispose() {
        this.status.dispose();
        this.diagnostics.dispose();
    }

    makeTask(action: BuildAction): vscode.Task {
        const root = projectRoot();
        const def: vscode.TaskDefinition = { type: "odysseydoc", action };
        const task = new vscode.Task(
            def,
            vscode.workspace.workspaceFolders?.find((f) => root && f.uri.fsPath === root.fsPath) ??
                (vscode.workspace.workspaceFolders?.length ? vscode.TaskScope.Workspace : vscode.TaskScope.Global),
            LABELS[action],
            "OdysseyDoc",
            new vscode.CustomExecution(async () => this.terminal(action)),
            [],
        );
        if (action === "build" || action === "rebuild" || action === "buildDeploy") task.group = vscode.TaskGroup.Build;
        if (action === "clean") task.group = vscode.TaskGroup.Clean;
        const reveal = action === "quick" || cfg<boolean>("build.revealTerminal", true);
        task.presentationOptions = { reveal: reveal ? vscode.TaskRevealKind.Always : vscode.TaskRevealKind.Silent, clear: true, showReuseMessage: false };
        return task;
    }

    async run(action: BuildAction) {
        if (this.running) {
            vscode.window.showWarningMessage("A build is already running.");
            return;
        }
        if (!(await ensureBase("to build"))) return;
        if (action !== "quick") this.quick = undefined;
        await vscode.workspace.saveAll(false);
        await vscode.tasks.executeTask(this.makeTask(action));
    }

    /**
     * Quick-build key: copies the active .cpp to <base>/src/main.cpp, runs make, then
     * - success: copies subsdk + main.npdm next to the .cpp;
     * - failure: the full log stays in the console (OdysseyDoc terminal) and errors point at the .cpp.
     */
    async quickBuild(uri?: vscode.Uri) {
        if (this.running) {
            vscode.window.showWarningMessage("A build is already running.");
            return;
        }
        const ed = vscode.window.activeTextEditor;
        const target = uri ?? ed?.document.uri;
        if (!target || target.scheme !== "file" || !/\.(cpp|cc|cxx|c)$/i.test(target.fsPath)) {
            vscode.window.showWarningMessage("Quick build: open your mod's .cpp first.");
            return;
        }
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target.toString());
        if (doc?.isDirty) await doc.save();
        const sync = await syncToBase(this.st, target);
        if (!sync) return;
        const overrides = new Map<string, string>();
        for (const f of sync.files) overrides.set(normKey(f.inBase), f.origin);
        const sub = cfg<string>("quickBuild.outputSubfolder", "");
        this.quick = { source: target.fsPath, overrides, outDir: path.join(path.dirname(target.fsPath), sub) };
        await vscode.workspace.saveAll(false);
        await vscode.tasks.executeTask(this.makeTask("quick"));
    }

    /** Copies the build outputs next to the .cpp (named as in exefs: subsdk9 / subsdk4, main.npdm). */
    private copyOutputs(root: vscode.Uri, q: QuickContext): string[] {
        const bd = buildDir(root);
        const list = buildOutputs(root).files.map((f) => ({ src: f.local, name: f.name }));
        for (const n of cfg<string[]>("quickBuild.extraFiles", [])) list.push({ src: path.join(bd, n), name: path.basename(n) });
        fs.mkdirSync(q.outDir, { recursive: true });
        const done: string[] = [];
        for (const f of list) {
            if (!fs.existsSync(f.src)) continue;
            fs.copyFileSync(f.src, path.join(q.outDir, f.name));
            done.push(f.name);
        }
        return done;
    }

    /** Pseudo-terminal: runs make (in WSL if needed), colourises it and turns the output into diagnostics. */
    private terminal(action: BuildAction): vscode.Pseudoterminal {
        const writeEmitter = new vscode.EventEmitter<string>();
        const closeEmitter = new vscode.EventEmitter<number>();
        let child: cp.ChildProcess | undefined;
        const write = (s: string) => writeEmitter.fire(s.replace(/\r?\n/g, "\r\n"));

        const start = async () => {
            const root = projectRoot();
            if (!root) {
                write(`${C.red}Mod base not located (command "OdysseyDoc: Locate the mod base").${C.reset}\n`);
                closeEmitter.fire(1);
                return;
            }
            this.running = true;
            const env = getExecEnv(root);
            const quick = action === "quick" ? this.quick : undefined;
            const fw = baseFramework(root);
            const parser = new GccOutputParser(
                (p) => {
                    const mapped = env.mapper.toHost(p);
                    const abs = path.isAbsolute(mapped) || /^\\\\/.test(mapped) ? mapped : path.join(root.fsPath, cfg("build.outputDir", "build"), mapped);
                    return quick?.overrides.get(normKey(abs)) ?? abs;
                },
                { hakkun: fw === "hakkun" },
            );
            this.diagnostics.clear();
            const command = commandFor(action);
            const needsConfigure = action !== "clean" && action !== "configure" && !fs.existsSync(path.join(root.fsPath, cfg("build.outputDir", "build"), "CMakeCache.txt"));
            const spec = shellSpawn(command, env, root.fsPath);
            const t0 = Date.now();
            this.status.text = `$(sync~spin) OdysseyDoc: ${LABELS[action].toLowerCase()}…`;
            this.status.tooltip = "Building…";
            write(`${C.cyan}${C.bold}▶ ${LABELS[action]}${C.reset}${C.dim}  (${spec.display})${C.reset}\n`);
            if (quick) write(`${C.dim}  ${path.basename(quick.source)} → ${path.join("src", "main.cpp")} in the base${C.reset}\n`);
            if (env.kind === "wsl") write(`${C.dim}  WSL ${env.distro ?? "(default distribution)"} · ${env.buildRoot}${C.reset}\n`);
            else write(`${C.dim}  base: ${root.fsPath}${C.reset}\n`);
            write(`${C.dim}  ${fw === "hakkun" ? "Hakkun" : "exlaunch"} base${C.reset}\n`);
            if (needsConfigure && fw === "hakkun") write(`${C.dim}  (first build: CMake configures build/ — Hakkun may download its stdlib and compile sail first, this takes a while)${C.reset}\n`);
            else if (needsConfigure && /\bmake\b/.test(command)) write(`${C.dim}  (first build: CMake will configure the build/ folder first)${C.reset}\n`);
            write("\n");

            let buf = "";
            const onData = (d: Buffer) => {
                buf += d.toString("utf8");
                let i: number;
                while ((i = buf.indexOf("\n")) >= 0) {
                    const line = buf.slice(0, i).replace(/\r$/, "");
                    buf = buf.slice(i + 1);
                    parser.feedLine(line);
                    write(colorize(line) + "\n");
                }
            };
            try {
                child = cp.spawn(spec.file, spec.args, { ...spec.options, stdio: ["ignore", "pipe", "pipe"] });
            } catch (e) {
                write(`${C.red}Could not start the command: ${e}${C.reset}\n`);
                this.finish(action, false);
                closeEmitter.fire(1);
                return;
            }
            child.stdout?.on("data", onData);
            child.stderr?.on("data", onData);
            child.on("error", (e) => {
                write(`${C.red}Error: ${e.message}${C.reset}\n`);
                if (env.kind === "wsl") write(`${C.yellow}Is WSL installed? (wsl.exe not found)${C.reset}\n`);
            });
            child.on("close", async (code) => {
                if (buf) {
                    parser.feedLine(buf);
                    write(colorize(buf) + "\n");
                }
                parser.finish();
                this.publish(parser.diags, root);
                const secs = ((Date.now() - t0) / 1000).toFixed(1);
                const ok = code === 0;
                write("\n");
                if (ok) write(`${C.green}${C.bold}✔ ${LABELS[action]}: done in ${secs} s${C.reset}${parser.warningCount ? `${C.yellow} (${parser.warningCount} warning(s))${C.reset}` : ""}\n`);
                else {
                    write(`${C.red}${C.bold}✘ ${LABELS[action]}: failed (code ${code}) in ${secs} s — ${parser.errorCount} error(s)${C.reset}\n`);
                    if (/command not found|No such file/.test(parser.diags.map((d) => d.message).join("\n")) || code === 127) {
                        write(
                            fw === "hakkun"
                                ? `${C.yellow}Tip: Hakkun needs CMake, make or ninja, Clang/LLVM/LLD 19+, and Python 3 with pyelftools, mmh3 and lz4, and a "python" command (python-is-python3) — in WSL on Windows.${C.reset}\n`
                                : `${C.yellow}Tip: check DEVKITPRO in WSL (setting odysseydoc.build.env) and that cmake/make are installed.${C.reset}\n`,
                        );
                    }
                    if (parser.diags.some((d) => d.code === "odysseydoc-undefined-symbol")) {
                        write(`${C.yellow}Undefined game symbols: use the quick fix on the error (or the command "OdysseyDoc: Declare a symbol in the Hakkun syms/") to declare them in syms/.${C.reset}\n`);
                    }
                }
                if (ok && quick) {
                    try {
                        const copied = this.copyOutputs(root, quick);
                        if (copied.length) write(`${C.green}✔ Copied to ${quick.outDir}: ${copied.join(", ")}${C.reset}\n`);
                        else write(`${C.yellow}⚠ No build output found in ${buildDir(root)}${C.reset}\n`);
                    } catch (e) {
                        write(`${C.red}✘ Copy failed: ${e}${C.reset}\n`);
                    }
                }
                let deployed = true;
                if (ok && (action === "buildDeploy" || (cfg<boolean>("deploy.afterBuild", false) && (action === "build" || action === "rebuild")))) {
                    if (this.deployHook) {
                        write(`\n${C.cyan}${C.bold}▶ Deploy${C.reset}\n`);
                        deployed = await this.deployHook((s) => write(s + "\n"));
                    }
                }
                this.finish(action, ok && deployed, parser.errorCount, parser.warningCount, secs);
                closeEmitter.fire(ok && deployed ? 0 : 1);
            });
        };

        return {
            onDidWrite: writeEmitter.event,
            onDidClose: closeEmitter.event,
            open: () => void start(),
            close: () => {
                child?.kill();
            },
            handleInput: (data: string) => {
                if (data === "\x03") child?.kill();
            },
        };
    }

    private finish(action: BuildAction, ok: boolean, errors = 0, warnings = 0, secs = "") {
        this.running = false;
        if (ok) {
            this.idle(`$(check) OdysseyDoc`, `${LABELS[action]} succeeded${secs ? ` in ${secs} s` : ""}${warnings ? ` · ${warnings} warning(s)` : ""} — click to rebuild`);
        } else {
            this.idle(`$(error) OdysseyDoc ${errors || ""}`.trim(), `${LABELS[action]}: failed — click to rebuild`);
            this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        }
        this._onBuildDone.fire({ action, ok });
        // quick build: keep the console (the log) in front on failure
        if (!ok && errors && action !== "quick" && cfg<boolean>("build.focusProblems", true)) vscode.commands.executeCommand("workbench.actions.view.problems");
    }

    private publish(diags: ParsedDiag[], root: vscode.Uri) {
        const map = new Map<string, vscode.Diagnostic[]>();
        for (const d of diags) {
            const file = d.file || path.join(root.fsPath, "CMakeLists.txt");
            const line = Math.max(0, d.line - 1);
            const col = Math.max(0, d.col - 1);
            const range = new vscode.Range(line, col, line, d.col ? col + 1 : 1000);
            const sev = d.severity === "error" ? vscode.DiagnosticSeverity.Error : d.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
            const diag = new vscode.Diagnostic(range, d.message, sev);
            diag.source = d.source;
            if (d.code) diag.code = d.code;
            if (d.notes.length) {
                diag.relatedInformation = d.notes.map(
                    (n) => new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(n.file), new vscode.Position(Math.max(0, n.line - 1), Math.max(0, n.col - 1))), n.message),
                );
            }
            const k = file;
            if (!map.has(k)) map.set(k, []);
            map.get(k)!.push(diag);
        }
        for (const [f, list] of map) this.diagnostics.set(vscode.Uri.file(f), list);
        void this.st;
    }
}

function colorize(line: string): string {
    if (/\b(error|erreur)\b:|\*\*\*|undefined reference|fatal error/i.test(line)) return C.red + line + C.reset;
    if (/\bwarning\b:|attention:/i.test(line)) return C.yellow + line + C.reset;
    if (/\bnote\b:/.test(line)) return C.cyan + line + C.reset;
    if (/^\[\s*\d+%\]/.test(line)) return C.dim + line + C.reset;
    return line;
}

export class DocTaskProvider implements vscode.TaskProvider {
    constructor(private runner: BuildRunner) {}
    provideTasks(): vscode.Task[] {
        return (["build", "rebuild", "clean", "configure", "buildDeploy"] as BuildAction[]).map((a) => this.runner.makeTask(a));
    }
    resolveTask(task: vscode.Task): vscode.Task | undefined {
        const a = task.definition.action as BuildAction;
        if (!a || !LABELS[a] || a === "quick") return undefined;
        const t = this.runner.makeTask(a);
        t.definition = task.definition;
        return t;
    }
}

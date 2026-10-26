import * as vscode from "vscode";
import * as path from "path";
import { copyToBaseCommand, restoreBackupCommand } from "./base";
import { BuildAction, BuildRunner, DocTaskProvider } from "./build";
import { setupClangd } from "./clangd";
import { hex, parseAddr } from "./core/site";
import { addDeployTargetWizard, deployAll } from "./deploy";
import { cfg, locateBase, projectRoot } from "./env";
import { FichePanel } from "./fiche";
import { generateHookCommand, insertInclude, trackCppEditors } from "./hooks";
import { DocHoverProvider } from "./hover";
import { registerLens } from "./lens";
import { DocDefinitionProvider, FieldInlayHints, GhidraInlayHints } from "./pseudo";
import { resolveAt } from "./resolver";
import { pickEntity } from "./search";
import { besideDefault, GHIDRA_SCHEME, openGhidra, openOnSite, openSource, SiteDocProvider, SRC_SCHEME } from "./sources";
import { DocState } from "./state";
import { EntityTree, HooksTree } from "./views";

const CPP: vscode.DocumentSelector = [
    { language: "cpp", scheme: "file" },
    { language: "c", scheme: "file" },
    { scheme: GHIDRA_SCHEME },
    { scheme: SRC_SCHEME },
];

export function activate(ctx: vscode.ExtensionContext) {
    const st = new DocState(ctx);
    const runner = new BuildRunner(st);
    runner.deployHook = (log) => deployAll(st, log);
    ctx.subscriptions.push(st.output, runner);
    trackCppEditors(ctx);

    // site index: cache first, then background revalidation
    st.ix().catch((e) => {
        st.log(String(e));
        vscode.window.showErrorMessage(`OdysseyDoc: ${e instanceof Error ? e.message : e}`, "Retry", "Settings").then((a) => {
            if (a === "Retry") vscode.commands.executeCommand("odysseydoc.refreshData");
            if (a === "Settings") vscode.commands.executeCommand("workbench.action.openSettings", "odysseydoc.siteUrl");
        });
    });

    const docs = new SiteDocProvider(st);
    ctx.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(GHIDRA_SCHEME, docs),
        vscode.workspace.registerTextDocumentContentProvider(SRC_SCHEME, docs),
        vscode.languages.registerHoverProvider(CPP, new DocHoverProvider(st)),
        vscode.languages.registerDefinitionProvider(CPP, new DocDefinitionProvider(st)),
        vscode.languages.registerInlayHintsProvider([{ scheme: GHIDRA_SCHEME }], new GhidraInlayHints(st)),
        vscode.languages.registerInlayHintsProvider([{ scheme: GHIDRA_SCHEME }], new FieldInlayHints(st)),
        vscode.tasks.registerTaskProvider("odysseydoc", new DocTaskProvider(runner)),
    );
    registerLens(ctx, st);

    // vues
    const tree = new EntityTree(st);
    const hooksTree = new HooksTree(st);
    const treeView = vscode.window.createTreeView("odysseydoc.entities", { treeDataProvider: tree, showCollapseAll: true });
    ctx.subscriptions.push(treeView, vscode.window.createTreeView("odysseydoc.hooks", { treeDataProvider: hooksTree }));
    const describe = () =>
        st.ix().then((ix) => {
            const s = ix.meta.stats ?? {};
            const total = Object.values(s).reduce((a, b) => a + b, 0) || 1;
            treeView.description = `${(((s.Matching ?? 0) / total) * 100).toFixed(1)} % matching`;
        });
    describe().catch(() => undefined);
    st.onIndexChanged(() => describe().catch(() => undefined));

    /** Command argument -> entity id (number, tree node, entity under the cursor, otherwise a search). */
    const entityArg = async (arg: unknown, fnOnly = false): Promise<number | undefined> => {
        if (typeof arg === "number") return arg;
        if (arg && typeof arg === "object" && "id" in arg && typeof (arg as { id: unknown }).id === "number") return (arg as { id: number }).id;
        const ed = vscode.window.activeTextEditor;
        if (ed) {
            const r = await resolveAt(ed.document, ed.selection.active, st, { forceHex: true, types: !fnOnly });
            if (r?.ids.length === 1) return r.ids[0];
            if (r && r.ids.length > 1) {
                const ix = await st.ix();
                const p = await vscode.window.showQuickPick(
                    r.ids.map((i) => ({ label: ix.q(i), description: ix.offsets(i).map((o) => hex(o)).join(" "), i })),
                    { title: "Several entities match" },
                );
                return p?.i;
            }
        }
        return pickEntity(st, "", fnOnly ? "Pick a function" : "Search OdysseyDoc", fnOnly);
    };

    const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

    // build / base / deploy
    const build = (a: BuildAction) => () => runner.run(a);
    reg("odysseydoc.build", build("build"));
    reg("odysseydoc.rebuild", build("rebuild"));
    reg("odysseydoc.clean", build("clean"));
    reg("odysseydoc.configure", build("configure"));
    reg("odysseydoc.buildDeploy", build("buildDeploy"));
    reg("odysseydoc.quickBuild", (uri?: vscode.Uri) => runner.quickBuild(uri instanceof vscode.Uri ? uri : undefined));
    reg("odysseydoc.copyToBase", (uri?: vscode.Uri) => copyToBaseCommand(st, uri instanceof vscode.Uri ? uri : undefined));
    reg("odysseydoc.locateBase", () => locateBase());
    reg("odysseydoc.restoreBackup", () => restoreBackupCommand(st));
    reg("odysseydoc.openBaseMain", async () => {
        const r = projectRoot() ?? (await locateBase());
        if (r) await vscode.window.showTextDocument(vscode.Uri.joinPath(r, "src", "main.cpp"));
    });
    reg("odysseydoc.deploy", async () => {
        const out: string[] = [];
        const ok = await deployAll(st, (s) => {
            out.push(s);
            st.log(s);
        });
        if (out.length) (ok ? vscode.window.showInformationMessage : vscode.window.showErrorMessage)(out.join("  •  "));
    });
    reg("odysseydoc.addDeployTarget", () => addDeployTargetWizard());
    reg("odysseydoc.setupClangd", () => setupClangd(st, runner).catch((e) => vscode.window.showErrorMessage(`clangd: ${e}`)));

    // documentation
    reg("odysseydoc.searchFunction", async (initial?: string) => {
        const id = await pickEntity(st, typeof initial === "string" ? initial : "");
        if (id !== undefined) await FichePanel.show(st, id);
    });
    reg("odysseydoc.searchAndHook", async () => {
        const id = await pickEntity(st, "", "Generate a hook for…", true);
        if (id !== undefined) await generateHookCommand(st, id);
    });
    reg("odysseydoc.showFiche", async (arg?: unknown) => {
        const id = await entityArg(arg);
        if (id !== undefined) await FichePanel.show(st, id);
    });
    reg("odysseydoc.openGhidra", async (arg?: unknown) => {
        const id = await entityArg(arg, true);
        if (id !== undefined) await openGhidra(st, id, besideDefault());
    });
    reg("odysseydoc.openSource", async (arg?: unknown) => {
        const id = await entityArg(arg);
        if (id !== undefined) await openSource(st, id, besideDefault());
    });
    reg("odysseydoc.openOnSite", async (arg?: unknown) => {
        const id = await entityArg(arg);
        if (id !== undefined) await openOnSite(st, id);
    });
    reg("odysseydoc.openSite", () => vscode.env.openExternal(vscode.Uri.parse(st.siteUrl())));
    const hook = async (arg?: unknown) => {
        const id = await entityArg(arg, true);
        if (id !== undefined) await generateHookCommand(st, id);
    };
    reg("odysseydoc.generateHook", hook);
    reg("odysseydoc.generateHookFor", hook);
    const copyFrom = async (arg: unknown, what: "symbol" | "offset") => {
        const id = await entityArg(arg, true);
        if (id === undefined) return;
        const ix = await st.ix();
        const d = await st.detail(id);
        const text = what === "symbol" ? (d.bin?.[0]?.lab.find((l) => l.startsWith("_Z")) ?? d.mangled) : ix.offsets(id).length ? hex(ix.offsets(id)[0]) : undefined;
        if (!text) {
            vscode.window.showInformationMessage(`${ix.q(id)}: no ${what === "symbol" ? "symbol" : "address"} in the binary.`);
            return;
        }
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage(`Copied: ${text}`, 2500);
    };
    reg("odysseydoc.copySymbol", (arg?: unknown) => copyFrom(arg, "symbol"));
    reg("odysseydoc.copyOffset", (arg?: unknown) => copyFrom(arg, "offset"));
    reg("odysseydoc.copyText", async (t: string) => {
        await vscode.env.clipboard.writeText(String(t));
        vscode.window.setStatusBarMessage(`Copied: ${t}`, 2500);
    });
    reg("odysseydoc.insertInclude", (inc: string) => insertInclude(inc));
    reg("odysseydoc.goToOffset", async () => {
        const v = await vscode.window.showInputBox({
            title: "Go to an offset / address",
            placeHolder: "0x1D2D48 (main offset), 0x71001D2D48, .text::002d2d48 or 0x2D2D48 g (Ghidra)",
            validateInput: (s) => (parseAddr(s) !== null ? undefined : "Hexadecimal address expected"),
        });
        if (!v) return;
        const ix = await st.ix();
        const off = parseAddr(v)!;
        const r = ix.findByOffset(off);
        if (!r) {
            vscode.window.showWarningMessage(`No known function at ${hex(off)}.`);
            return;
        }
        if (r.delta) vscode.window.setStatusBarMessage(`${hex(off)} = ${ix.q(r.id)} + ${hex(r.delta)}`, 6000);
        await FichePanel.show(st, r.id);
    });
    reg("odysseydoc.refreshData", async () => {
        try {
            const ix = await st.refresh();
            vscode.window.showInformationMessage(`OdysseyDoc: index reloaded (${ix.size} entities, decomp ${String(ix.meta.decomp_rev).slice(0, 8)}).`);
        } catch (e) {
            vscode.window.showErrorMessage(`OdysseyDoc: ${e instanceof Error ? e.message : e}`);
        }
    });
    reg("odysseydoc.clearCache", async () => {
        st.clearDiskCache();
        await st.refresh().catch(() => undefined);
        vscode.window.showInformationMessage("OdysseyDoc: cache cleared and index downloaded again.");
    });
    reg("odysseydoc.filterTree", async () => {
        const p = await vscode.window.showQuickPick(
            [
                { label: "All", v: "all" as const },
                { label: "🟢 Matching", v: 1 },
                { label: "🟡 NonMatching (minor)", v: 2 },
                { label: "🟠 NonMatching (major)", v: 3 },
                { label: "⚪ Not decompiled", v: 4 },
            ],
            { title: "Filter the tree by status" },
        );
        if (p) {
            tree.setFilter(p.v);
            treeView.message = p.v === "all" ? undefined : `Filter: ${p.label}`;
        }
    });
    reg("odysseydoc.refreshHooks", () => hooksTree.refresh());
    reg("odysseydoc.showOutput", () => st.output.show());

    ctx.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((d) => {
            if (/\.(cpp|cc|h|hpp)$/.test(d.fileName)) hooksTree.refresh();
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            hooksTree.refresh();
            updateBaseContext();
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("odysseydoc.exlaunchBase")) {
                hooksTree.refresh();
                updateBaseContext();
            }
            if (e.affectsConfiguration("odysseydoc.siteUrl") || e.affectsConfiguration("odysseydoc.localSitePath")) vscode.commands.executeCommand("odysseydoc.refreshData");
        }),
        vscode.workspace.onDidOpenTextDocument((d) => {
            if (d.uri.scheme === "file" && /^(cpp|c)$/.test(d.languageId)) hooksTree.refresh();
        }),
    );

    // "Build .cpp" button (F7)
    const quickItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
    quickItem.command = "odysseydoc.quickBuild";
    ctx.subscriptions.push(quickItem);
    function updateBaseContext() {
        const r = projectRoot();
        vscode.commands.executeCommand("setContext", "odysseydoc.hasBase", !!r);
        quickItem.text = "$(play) Build .cpp";
        quickItem.tooltip = r
            ? `Quick build (F7): copies the active .cpp to ${path.join(r.fsPath, "src", "main.cpp")}, runs make, then copies the build next to the .cpp`
            : "Quick build (F7) — you will be asked for the exlaunch base";
        const ed = vscode.window.activeTextEditor;
        if (ed && ed.document.uri.scheme === "file" && /^(cpp|c)$/.test(ed.document.languageId)) quickItem.show();
        else quickItem.hide();
    }
    ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => updateBaseContext()));
    updateBaseContext();

    const root = projectRoot();
    if (root && cfg<boolean>("clangd.suggestSetup", true) && !ctx.globalState.get("odysseydoc.clangdSuggested")) {
        ctx.globalState.update("odysseydoc.clangdSuggested", true);
        vscode.window
            .showInformationMessage("OdysseyDoc: set up code completion (clangd) for the game headers?", "Set up", "Later")
            .then((a) => a === "Set up" && vscode.commands.executeCommand("odysseydoc.setupClangd"));
    }
}

export function deactivate() {
    /* rien */
}

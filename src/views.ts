import * as vscode from "vscode";
import * as fs from "fs";
import { scanSource } from "./core/scan";
import { CLASS_KINDS, hex, KIND_LABEL, SiteIndex, STATUS_LABEL } from "./core/site";
import { projectRoot } from "./env";
import { findByMangled } from "./resolver";
import { DocState } from "./state";

const STATUS_ICON = [
    new vscode.ThemeIcon("circle-small"),
    new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed")),
    new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground")),
    new vscode.ThemeIcon("error", new vscode.ThemeColor("list.errorForeground")),
    new vscode.ThemeIcon("circle-outline"),
];
const KIND_ICON: Record<string, string> = {
    ns: "symbol-namespace", xns: "symbol-namespace", class: "symbol-class", struct: "symbol-structure", union: "symbol-structure",
    tclass: "symbol-class", xclass: "symbol-class", enum: "symbol-enum", typedef: "symbol-type-parameter", alias: "symbol-type-parameter",
    var: "symbol-variable", macro: "symbol-constant", unit: "file-code",
};

type TNode = { t: "folder"; path: string; label: string } | { t: "ent"; id: number };

/** Site tree: folders -> files (units) -> classes / functions -> members. */
export class EntityTree implements vscode.TreeDataProvider<TNode> {
    private _onChange = new vscode.EventEmitter<TNode | undefined>();
    readonly onDidChangeTreeData = this._onChange.event;
    private ix: SiteIndex | undefined;
    private folders = new Map<string, { folders: Set<string>; units: number[] }>();
    private unitKids = new Map<number, number[]>();
    filter: number | "all" = "all";

    constructor(private st: DocState) {
        st.onIndexChanged(() => this.reload());
    }

    async reload() {
        const ix = await this.st.ix();
        this.ix = ix;
        this.folders.clear();
        this.unitKids.clear();
        const ensure = (p: string) => {
            let n = this.folders.get(p);
            if (!n) this.folders.set(p, (n = { folders: new Set(), units: [] }));
            return n;
        };
        ensure("");
        for (const u of ix.units) {
            const parts = ix.q(u).split("/");
            let cur = "";
            for (let k = 0; k < parts.length - 1; k++) {
                const next = cur ? `${cur}/${parts[k]}` : parts[k];
                ensure(cur).folders.add(next);
                cur = next;
            }
            ensure(cur).units.push(u);
        }
        // top-level children of each unit (like the site's IX.buildUnitKids)
        const anon = (n: number) => ix.slug(n).startsWith("(anonymous@") && !ix.slug(n).includes("::");
        for (let i = 0; i < ix.size; i++) {
            const u = ix.unit(i);
            if (u === null) continue;
            const k = ix.kind(i);
            if (k === "unit" || ((k === "ns" || k === "xns") && !anon(i))) continue;
            const p = ix.parent(i);
            if (p !== null && CLASS_KINDS.has(ix.kind(p)) && ix.unit(p) === u) continue;
            if (p !== null && (ix.kind(p) === "ns" || ix.kind(p) === "xns") && anon(p)) continue;
            let a = this.unitKids.get(u);
            if (!a) this.unitKids.set(u, (a = []));
            a.push(i);
        }
        this._onChange.fire(undefined);
    }

    setFilter(f: number | "all") {
        this.filter = f;
        this._onChange.fire(undefined);
    }

    private visible(i: number): boolean {
        if (this.filter === "all") return true;
        const ix = this.ix!;
        if (ix.isFn(i)) return ix.status(i) === this.filter;
        return ix.children(i).some((c) => this.visible(c)) || (this.unitKids.get(i) ?? []).some((c) => this.visible(c));
    }

    private folderVisible(p: string): boolean {
        if (this.filter === "all") return true;
        const n = this.folders.get(p);
        return !!n && (n.units.some((u) => this.visible(u)) || [...n.folders].some((f) => this.folderVisible(f)));
    }

    async getChildren(node?: TNode): Promise<TNode[]> {
        if (!this.ix) await this.reload();
        const ix = this.ix!;
        if (!node || node.t === "folder") {
            const n = this.folders.get(node ? node.path : "");
            if (!n) return [];
            const f = [...n.folders].filter((x) => this.folderVisible(x)).sort((a, b) => a.localeCompare(b)).map((x) => ({ t: "folder" as const, path: x, label: x.split("/").pop()! }));
            const u = n.units.filter((x) => this.visible(x)).sort((a, b) => ix.name(a).localeCompare(ix.name(b))).map((id) => ({ t: "ent" as const, id }));
            return [...f, ...u];
        }
        const kids = ix.kind(node.id) === "unit" ? this.unitKids.get(node.id) ?? [] : ix.children(node.id);
        return kids
            .filter((c) => this.visible(c))
            .sort((a, b) => Number(ix.isFn(a)) - Number(ix.isFn(b)) || ix.name(a).localeCompare(ix.name(b)))
            .map((id) => ({ t: "ent" as const, id }));
    }

    getTreeItem(node: TNode): vscode.TreeItem {
        const ix = this.ix!;
        if (node.t === "folder") {
            const it = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
            it.iconPath = vscode.ThemeIcon.Folder;
            it.id = "d:" + node.path;
            return it;
        }
        const i = node.id;
        const k = ix.kind(i);
        const hasKids = k === "unit" ? (this.unitKids.get(i) ?? []).length > 0 : ix.children(i).length > 0;
        const it = new vscode.TreeItem(ix.name(i), hasKids ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        it.id = "e:" + i;
        const offs = ix.offsets(i);
        if (ix.isFn(i)) {
            it.iconPath = STATUS_ICON[ix.status(i)] ?? STATUS_ICON[0];
            it.description = offs.length ? hex(offs[0]) : "inline";
            it.contextValue = offs.length ? "docFnBin" : "docFn";
        } else {
            it.iconPath = new vscode.ThemeIcon(KIND_ICON[k] ?? "symbol-misc");
            it.description = KIND_LABEL[k];
            it.contextValue = "docEnt";
        }
        it.tooltip = `${ix.q(i)}\n${KIND_LABEL[k] ?? k}${ix.isFn(i) ? ` · ${STATUS_LABEL[ix.status(i)]}` : ""}${offs.length ? ` · ${offs.map((o) => hex(o)).join(", ")}` : ""}`;
        if (k !== "unit") it.command = { command: "odysseydoc.showFiche", title: "Details", arguments: [i] };
        return it;
    }
}

interface HookItem {
    name: string;
    kind: string;
    file: vscode.Uri;
    line: number;
    installs: { method: string; value: string; file: vscode.Uri; line: number; target?: number; tq?: string; delta?: number }[];
}

type HNode = { t: "hook"; h: HookItem } | { t: "install"; i: HookItem["installs"][number] } | { t: "patch"; i: HookItem["installs"][number] } | { t: "empty"; msg: string };

export class HooksTree implements vscode.TreeDataProvider<HNode> {
    private _onChange = new vscode.EventEmitter<HNode | undefined>();
    readonly onDidChangeTreeData = this._onChange.event;
    private cache: HNode[] | undefined;

    constructor(private st: DocState) {
        st.onIndexChanged(() => this.refresh());
    }

    refresh() {
        this.cache = undefined;
        this._onChange.fire(undefined);
    }

    private async scan(): Promise<HNode[]> {
        const root = projectRoot();
        const ix = await this.st.ix();
        // scanned files: the base's src/, open .cpp files (wherever they are) and those of the open folder
        const seen = new Set<string>();
        const files: vscode.Uri[] = [];
        const add = (u: vscode.Uri) => {
            const k = u.fsPath.toLowerCase();
            if (!seen.has(k)) {
                seen.add(k);
                files.push(u);
            }
        };
        if (root) (await vscode.workspace.findFiles(new vscode.RelativePattern(root, "src/**/*.{cpp,cc,cxx,h,hpp}"), "**/build/**", 2000)).forEach(add);
        for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === "file" && /^(cpp|c)$/.test(d.languageId)) add(d.uri);
        for (const f of vscode.workspace.workspaceFolders ?? []) {
            if (root && f.uri.fsPath === root.fsPath) continue;
            (await vscode.workspace.findFiles(new vscode.RelativePattern(f, "**/*.{cpp,cc,cxx}"), "{**/build/**,**/node_modules/**,**/.git/**}", 300)).forEach(add);
        }
        if (!files.length) return [{ t: "empty", msg: "No .cpp open and no exlaunch base located" }];
        const hooks = new Map<string, HookItem>();
        const installs: HookItem["installs"] = [];
        const patches: HookItem["installs"] = [];
        for (const f of files) {
            let text: string;
            const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === f.toString());
            if (open) text = open.getText();
            else
                try {
                    text = fs.readFileSync(f.fsPath, "utf8");
                } catch {
                    continue;
                }
            const lineOf = (idx: number) => text.slice(0, idx).split("\n").length - 1;
            const { refs, defs } = scanSource(text);
            for (const d of defs) hooks.set(d.name, { name: d.name, kind: d.kind, file: f, line: lineOf(d.start), installs: [] });
            for (const r of refs) {
                let target: number | undefined;
                let delta: number | undefined;
                if (r.kind === "symbol") target = (await findByMangled(this.st, ix, r.value))[0];
                else if (r.num !== undefined) {
                    const x = ix.findByOffset(r.num);
                    target = x?.id;
                    delta = x?.delta;
                }
                const it = { method: r.method, value: r.value, file: f, line: lineOf(r.start), target, tq: target !== undefined ? ix.q(target) : undefined, delta, hook: r.hookName };
                if (r.hookName) installs.push(it as HookItem["installs"][number] & { hook: string });
                else patches.push(it);
            }
        }
        for (const i of installs as (HookItem["installs"][number] & { hook: string })[]) {
            const h = hooks.get(i.hook);
            if (h) h.installs.push(i);
            else hooks.set(i.hook, { name: i.hook, kind: "?", file: i.file, line: i.line, installs: [i] });
        }
        const out: HNode[] = [...hooks.values()].sort((a, b) => a.name.localeCompare(b.name)).map((h) => ({ t: "hook" as const, h }));
        for (const p of patches) out.push({ t: "patch", i: p });
        if (!out.length) out.push({ t: "empty", msg: "No hook found (base + open .cpp files)" });
        return out;
    }

    async getChildren(node?: HNode): Promise<HNode[]> {
        if (!node) {
            if (!this.cache) this.cache = await this.scan();
            return this.cache;
        }
        if (node.t === "hook") return node.h.installs.map((i) => ({ t: "install" as const, i }));
        return [];
    }

    getTreeItem(node: HNode): vscode.TreeItem {
        if (node.t === "empty") return new vscode.TreeItem(node.msg);
        if (node.t === "hook") {
            const h = node.h;
            const target = h.installs.find((i) => i.tq)?.tq;
            const it = new vscode.TreeItem(h.name, h.installs.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
            it.description = target ? target : h.installs.length ? "unknown target" : "never installed";
            it.iconPath = new vscode.ThemeIcon(
                !h.installs.length ? "warning" : h.installs.every((i) => i.target !== undefined) ? "zap" : "error",
                !h.installs.length ? new vscode.ThemeColor("list.warningForeground") : undefined,
            );
            it.tooltip = `${h.kind} — ${h.installs.length} installation(s)${!h.installs.length ? "\nNo InstallAt… call found" : ""}`;
            it.command = { command: "vscode.open", title: "", arguments: [h.file, { selection: new vscode.Range(h.line, 0, h.line, 0) }] };
            it.contextValue = "docHook";
            return it;
        }
        const i = node.i;
        const label = node.t === "patch" ? `${i.method} ${i.value}` : `${i.method}(${i.value.length > 40 ? i.value.slice(0, 40) + "…" : i.value})`;
        const it = new vscode.TreeItem(label);
        it.description = i.tq ? `${i.tq}${i.delta ? ` +${hex(i.delta)}` : ""}` : "⚠ not found";
        it.iconPath = new vscode.ThemeIcon(node.t === "patch" ? "wrench" : i.tq ? "link" : "warning");
        it.command = { command: "vscode.open", title: "", arguments: [i.file, { selection: new vscode.Range(i.line, 0, i.line, 0) }] };
        return it;
    }
}

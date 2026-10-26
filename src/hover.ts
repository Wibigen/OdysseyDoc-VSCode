import * as vscode from "vscode";
import { CLASS_KINDS, Detail, hex, HOOK_LABEL, hookSafety, KIND_LABEL, SiteIndex, STATUS_EMOJI, STATUS_LABEL } from "./core/site";
import { cfg } from "./env";
import { isResolvingViaClangd, Resolved, resolveAt } from "./resolver";
import { decompSnippet, stripPseudoHeader } from "./sources";
import { DocState } from "./state";

export const TRUSTED_COMMANDS = [
    "odysseydoc.openGhidra",
    "odysseydoc.openSource",
    "odysseydoc.showFiche",
    "odysseydoc.generateHookFor",
    "odysseydoc.copyText",
    "odysseydoc.insertInclude",
    "odysseydoc.searchFunction",
    "odysseydoc.openOnSite",
];

export function cmdLink(label: string, command: string, ...args: unknown[]): string {
    return `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
}

const esc = (s: string) => s.replace(/[`\\]/g, "'");

/** Readable signature: "bool Shine::receiveMsg(const al::SensorMsg* message, …) const" */
export function signature(ix: SiteIndex, i: number, d: Detail): string {
    const k = ix.kind(i);
    if (!ix.isFn(i)) return ix.q(i);
    const ret = k === "ctor" || k === "dtor" ? "" : (d.ret ? ix.qualify(d.ret, ix.ctxFromEntity(i)) : d.gret ? `/*${d.gret}*/` : "?") + " ";
    const ctx = ix.ctxFromEntity(i);
    const params = d.params ? d.params.map((p) => (p[1] ? `${ix.qualify(p[0], ctx)} ${p[1]}` : ix.qualify(p[0], ctx))).join(", ") : d.dem ? (/\((.*)\)/.exec(d.dem)?.[1] ?? "?") : "?";
    const fl = d.flags || [];
    return `${fl.includes("static") ? "static " : ""}${fl.includes("virtual") ? "virtual " : ""}${ret}${ix.q(i)}(${params})${fl.includes("const") ? " const" : ""}`.replace(/\s+([*&])/g, "$1");
}

export function entityMarkdown(st: DocState, ix: SiteIndex, i: number, d: Detail, md: vscode.MarkdownString, opts: { delta?: number; compact?: boolean } = {}) {
    const k = ix.kind(i);
    md.appendMarkdown(`**\`${esc(signature(ix, i, d))}\`**`);
    if (opts.delta) md.appendMarkdown(` &nbsp;+${hex(opts.delta)}`);
    md.appendMarkdown("  \n");
    const parts: string[] = [KIND_LABEL[k] ?? k];
    const bins = d.bin || [];
    if (ix.isFn(i) || bins.length) {
        parts.push(`${STATUS_EMOJI[ix.status(i)]} ${STATUS_LABEL[ix.status(i)]}`);
        if (bins.length) parts.push(bins.map((b) => `\`${hex(b.off)}\`${b.thunk ? " (thunk)" : ""}`).join(" "), `${bins[0].sz} bytes`);
        const main = bins.find((b) => !b.thunk) ?? bins[0];
        if (main) parts.push(`hook: ${HOOK_LABEL[hookSafety(main).near]}`);
        if (d.rsrc === "ghidra" || d.rsrc === "unknown") parts.push("return type guessed");
    } else if (CLASS_KINDS.has(k)) {
        if (d.size) parts.push(`${hex(d.size)} bytes`);
        if (d.bases?.length) parts.push(`inherits ${d.bases.map((b) => b[0]).join(", ")}`);
    }
    md.appendMarkdown(parts.join(" · ") + "  \n");
    if (d.cm && !opts.compact) md.appendMarkdown(`_${d.cm.replace(/^\/\/\/?\s*|\/\*+|\*+\//g, "").trim().slice(0, 300)}_  \n`);
    const mangled = bins[0]?.lab.find((l) => l.startsWith("_Z")) ?? d.mangled;
    if (mangled) md.appendMarkdown(`\`${mangled}\`  \n`);
    const links: string[] = [];
    const loc = d.def ?? d.decl;
    if (loc?.fi !== undefined) links.push(cmdLink("$(source-control) Decomp", "odysseydoc.openSource", i));
    if (bins.some((b) => b.gh.length)) links.push(cmdLink("$(file-code) Ghidra", "odysseydoc.openGhidra", i));
    if (bins.length) links.push(cmdLink("$(zap) Hook", "odysseydoc.generateHookFor", i));
    links.push(cmdLink("$(info) Details", "odysseydoc.showFiche", i));
    links.push(cmdLink("$(globe) Site", "odysseydoc.openOnSite", i));
    if (mangled) links.push(cmdLink("$(copy) Symbol", "odysseydoc.copyText", mangled));
    if (bins.length) links.push(cmdLink("$(copy) Offset", "odysseydoc.copyText", hex(bins[0].off + (opts.delta ?? 0))));
    md.appendMarkdown(links.join(" &nbsp; ") + "  \n");
    const inc = ix.includeFor(d.decl?.f);
    if (inc && !opts.compact) md.appendMarkdown(cmdLink(`$(file-add) #include ${inc}`, "odysseydoc.insertInclude", inc) + "  \n");
    void st;
}

export class DocHoverProvider implements vscode.HoverProvider {
    constructor(private st: DocState) {}

    async provideHover(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
        if (isResolvingViaClangd() || !cfg<boolean>("hover.enabled", true)) return undefined;
        let r: Resolved | undefined;
        try {
            r = await resolveAt(doc, pos, this.st);
        } catch {
            return undefined;
        }
        if (!r || token.isCancellationRequested) return undefined;
        const ix = await this.st.ix();
        const md = new vscode.MarkdownString(undefined, true);
        md.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
        md.appendMarkdown(`$(book) **OdysseyDoc** — `);
        if (r.how === "string" && r.str) {
            const t = (r.str.delta ? r.str.text.slice(r.str.delta) : r.str.text).slice(0, 400);
            md.appendMarkdown(`_.rodata string_ \`${hex(r.offset ?? 0)}\`${r.str.delta ? ` (+${r.str.delta})` : ""}\n\n`);
            md.appendCodeblock(JSON.stringify(t), "cpp");
            md.appendMarkdown(cmdLink("$(copy) Copy", "odysseydoc.copyText", t));
            return new vscode.Hover(md, r.range);
        }
        if (!r.ids.length) {
            if (r.how === "mangled") md.appendMarkdown("⚠ symbol **not found** in the binary: check the mangling (const, types, namespace).");
            else if (r.how === "offset") md.appendMarkdown(`no known function at \`${hex(r.offset ?? 0)}\`.`);
            else return undefined;
            return new vscode.Hover(md, r.range);
        }
        const HOW: Record<Resolved["how"], string> = {
            mangled: "symbol", offset: "offset", qualified: "qualified name", definition: "definition", clangd: "via clangd",
            context: "method of the enclosing class", short: r.ids.length > 1 ? `${r.ids.length} functions have this name` : "short name",
            string: "string", type: "type", data: "data",
        };
        md.appendMarkdown(`_${HOW[r.how]}_\n\n`);
        const max = cfg<number>("hover.maxCandidates", 4);
        const list = r.ids.slice(0, Math.max(1, max));
        const dm = await this.st.details(list);
        if (token.isCancellationRequested) return undefined;
        list.forEach((i, n) => {
            if (n) md.appendMarkdown("\n\n---\n\n");
            entityMarkdown(this.st, ix, i, dm.get(i)!, md, { delta: r!.delta, compact: list.length > 1 });
        });
        if (r.ids.length > list.length) md.appendMarkdown(`\n\n…and ${r.ids.length - list.length} more — ${cmdLink("search", "odysseydoc.searchFunction", r.word)}`);

        // preview: OdysseyDecomp first, then Ghidra
        const n = cfg<number>("hover.previewLines", 14);
        if (n > 0 && list.length === 1) {
            const i = list[0];
            const d = dm.get(i)!;
            const to = <T>(p: Promise<T>, def: T) => Promise.race([p.catch(() => def), new Promise<T>((res) => setTimeout(() => res(def), 2000))]);
            const gh = (d.bin || []).flatMap((b) => b.gh)[0];
            const [dec, pse] = await Promise.all([
                to(decompSnippet(this.st, d), undefined),
                gh && ix.isFn(i) ? to(this.st.ghidra(i, gh[0]), "") : Promise.resolve(""),
            ]);
            if (token.isCancellationRequested) return new vscode.Hover(md, r.range);
            const block = (title: string, text: string) => {
                const body = text.replace(/\s+$/, "").split("\n");
                md.appendMarkdown(`\n\n**${title}**\n`);
                md.appendCodeblock(body.slice(0, n).join("\n") + (body.length > n ? "\n  /* … */" : ""), "cpp");
            };
            if (dec && (dec.isDef || !ix.isFn(i))) block(`OdysseyDecomp — ${dec.path}:${dec.line}`, dec.text);
            if (pse) block("Ghidra", stripPseudoHeader(pse));
        }
        return new vscode.Hover(md, r.range);
    }
}

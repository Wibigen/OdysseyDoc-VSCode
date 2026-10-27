import * as vscode from "vscode";
import { parseSym } from "./core/hakkun";
import { findByMangled } from "./resolver";
import { DocState } from "./state";

/** .sym files (Hakkun / sail): the OdysseyDoc name of each mangled symbol, as an inlay hint. */
export class SymInlayHints implements vscode.InlayHintsProvider {
    constructor(private st: DocState) {}

    async provideInlayHints(doc: vscode.TextDocument, range: vscode.Range): Promise<vscode.InlayHint[]> {
        const ix = await this.st.ix();
        const out: vscode.InlayHint[] = [];
        for (const b of parseSym(doc.getText())) {
            for (const e of b.entries) {
                if (e.line < range.start.line || e.line > range.end.line) continue;
                const target = !e.value ? e.name : (/^"(_Z[^"]*)"$/.exec(e.value)?.[1] ?? (e.name.startsWith("_Z") ? e.name : undefined));
                if (!target?.startsWith("_Z")) continue;
                const ids = await findByMangled(this.st, ix, target);
                let label: string | undefined;
                if (ids.length) label = ` ${ix.q(ids[0])}${ix.offsets(ids[0])[0] !== undefined ? ` · 1.0.0 ${"0x" + ix.offsets(ids[0])[0].toString(16).toUpperCase()}` : ""}`;
                else {
                    const dsym = ix.dataByMangledName(target);
                    if (dsym) label = ` ${dsym.dem} (data)`;
                }
                if (!label) continue;
                const pos = new vscode.Position(e.line, doc.lineAt(e.line).text.replace(/\s*(\/\/.*)?$/, "").length);
                const h = new vscode.InlayHint(pos, label, vscode.InlayHintKind.Type);
                h.paddingLeft = true;
                if (ids.length) h.tooltip = "Open the OdysseyDoc details";
                if (ids.length) h.label = [{ value: label, command: { command: "odysseydoc.showFiche", title: "", arguments: [ids[0]] } }];
                out.push(h);
            }
        }
        return out;
    }
}

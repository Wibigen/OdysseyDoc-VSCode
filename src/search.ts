import * as vscode from "vscode";
import { hex, KIND_LABEL } from "./core/site";
import { DocState } from "./state";

const ST_ICON = ["$(symbol-misc)", "$(pass-filled)", "$(warning)", "$(error)", "$(circle-outline)"];
const KIND_ICON: Record<string, string> = {
    ns: "$(symbol-namespace)", xns: "$(symbol-namespace)", class: "$(symbol-class)", struct: "$(symbol-structure)", union: "$(symbol-structure)",
    tclass: "$(symbol-class)", xclass: "$(symbol-class)", enum: "$(symbol-enum)", typedef: "$(symbol-type-parameter)", alias: "$(symbol-type-parameter)",
    var: "$(symbol-variable)", macro: "$(symbol-constant)", unit: "$(file-code)",
};

interface Item extends vscode.QuickPickItem {
    id: number;
}

/** Searches the whole site index (names, qualified names, offsets, Ghidra addresses). */
export async function pickEntity(st: DocState, initial = "", title = "Search OdysseyDoc", fnOnly = false): Promise<number | undefined> {
    const ix = await st.ix();
    const kinds = fnOnly ? new Set(["func", "method", "ctor", "dtor", "conv", "tfunc", "tmethod", "sym"]) : undefined;
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = title;
    qp.placeholder = "name (\"shine exeGot\"), qualified name (al::setNerve), offset (0x1D2D48) or Ghidra address (.text::002d2d48)";
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.value = initial;
    const toItem = (r: { id: number; addr?: number; base?: number }): Item => {
        const i = r.id;
        const k = ix.kind(i);
        const offs = ix.offsets(i);
        const fn = ix.isFn(i);
        return {
            id: i,
            label: `${fn ? ST_ICON[ix.status(i)] : KIND_ICON[k] ?? "$(symbol-misc)"} ${ix.q(i)}`,
            description: [KIND_LABEL[k] ?? k, offs.length ? hex(offs[0]) : "", r.addr !== undefined && r.base !== undefined && r.addr !== r.base ? `(${hex(r.addr)} = +${hex(r.addr - r.base)})` : ""].filter(Boolean).join(" · "),
            alwaysShow: true,
        };
    };
    let timer: NodeJS.Timeout | undefined;
    const update = (v: string) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            qp.busy = true;
            qp.items = ix.search(v, 150, kinds).map(toItem);
            qp.busy = false;
        }, 80);
    };
    qp.onDidChangeValue(update);
    update(initial);
    return await new Promise<number | undefined>((resolve) => {
        qp.onDidAccept(() => {
            resolve(qp.selectedItems[0]?.id);
            qp.hide();
        });
        qp.onDidHide(() => {
            resolve(undefined);
            qp.dispose();
        });
        qp.show();
    });
}

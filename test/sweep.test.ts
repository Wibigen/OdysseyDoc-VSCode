// Runs the details-panel data builder, the hover signature, hook generation and the webview renderer
// on every entity of a local site clone, to catch data-shape errors (e.g. "x.map is not a function").
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { Detail, hookSafety, parseDocGot, RawIndex, SiteIndex } from "../src/core/site";
import { generateHook } from "../src/core/hookgen";
import { signature } from "../src/hover";
import { FichePanel } from "../src/fiche";

const D = path.join(process.argv[2], "data");
const ix = new SiteIndex(parseDocGot(fs.readFileSync(path.join(D, "index.js"), "utf8")).value as RawIndex);

// webview renderer with a tiny DOM stub
const els = new Map<string, any>();
const el = (id: string) => els.get(id) ?? (els.set(id, { id, innerHTML: "", textContent: "", disabled: false, classList: { toggle() {} }, dataset: {} }), els.get(id));
let onMsg: (ev: { data: unknown }) => void = () => undefined;
const ctx = vm.createContext({
    acquireVsCodeApi: () => ({ postMessage() {} }),
    document: { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    window: { addEventListener: (_: string, f: typeof onMsg) => (onMsg = f) },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "media", "fiche.js"), "utf8"), ctx);

const entityData = (FichePanel as any).entityData.bind(FichePanel);
let n = 0;
const errs = new Map<string, { n: number; ex: string }>();
const fail = (where: string, id: number, e: unknown) => {
    const k = where + ": " + String(e).slice(0, 120);
    const r = errs.get(k) ?? { n: 0, ex: `${id} ${ix.q(id)}` };
    r.n++;
    errs.set(k, r);
};
for (const f of fs.readdirSync(path.join(D, "e"))) {
    const bundle = parseDocGot(fs.readFileSync(path.join(D, "e", f), "utf8")).value as Record<string, Detail>;
    for (const [k, d] of Object.entries(bundle)) {
        const id = Number(k);
        n++;
        let data: unknown;
        try { data = entityData({}, ix, id, d); } catch (e) { fail("entityData", id, e); continue; }
        try { signature(ix, id, d); } catch (e) { fail("signature", id, e); }
        try { for (const b of d.bin || []) hookSafety(b); } catch (e) { fail("hookSafety", id, e); }
        if (d.bin?.length) for (const kind of ["trampoline", "replace", "inline"] as const) {
            try { generateHook(ix, id, d, { kind, install: "symbol" }); } catch (e) { fail("hook " + kind, id, e); }
        }
        try { onMsg({ data: { type: "entity", data: JSON.parse(JSON.stringify(data)), canBack: false } }); } catch (e) { fail("webview", id, e); }
    }
}
console.log(`swept ${n} entities, ${errs.size} distinct error(s)`);
for (const [k, v] of errs) console.log(`FAIL x${v.n}  ${k}   e.g. ${v.ex}`);
if (errs.size) process.exit(1);

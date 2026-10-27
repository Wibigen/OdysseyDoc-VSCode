// Dev check: generates Hakkun hooks for a sample of functions, one .cpp per hook, to be syntax-checked
// with clang++ against LibHakkun + OdysseyHeaders (see README "Tests").
import * as fs from "fs";
import * as path from "path";
import { Detail, parseDocGot, RawIndex, SiteIndex } from "../src/core/site";
import { generateHook } from "../src/core/hookgen";

const D = path.join(process.argv[2], "data");
const out = process.argv[3];
const want = Number(process.argv[4] ?? 300);
const ix = new SiteIndex(parseDocGot(fs.readFileSync(path.join(D, "index.js"), "utf8")).value as RawIndex);
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(path.join(D, "e")).sort();
let n = 0;
const step = Math.max(1, Math.floor(files.length / want));
for (let fi = 0; fi < files.length && n < want; fi += step) {
    const bundle = parseDocGot(fs.readFileSync(path.join(D, "e", files[fi]), "utf8")).value as Record<string, Detail>;
    for (const [k, d] of Object.entries(bundle)) {
        const id = Number(k);
        if (!d.bin?.length || !d.decl || !d.ret || ix.status(id) !== 1 || !["func", "method", "ctor", "dtor"].includes(ix.kind(id))) continue;
        if (!/^(src|lib\/al)\//.test(d.decl.f) || (d.flags || []).includes("variadic") || /operator|anonymous|</.test(ix.q(id))) continue;
        const inc = ix.includeFor(d.decl.f);
        if (!inc) continue;
        for (const kind of ["trampoline", "replace"] as const) {
            const r = generateHook(ix, id, d, { kind, install: "symbol", framework: "hakkun" });
            const src = [`#include "${r.headers[0]}"`, `#include ${inc}`, "", r.code, 'extern "C" void hkMain() {', "    " + r.install, "}", ""].join("\n");
            fs.writeFileSync(path.join(out, `h${id}_${kind}.cpp`), `// ${ix.q(id)}\n` + src);
        }
        n++;
        break;
    }
}
console.log(`wrote ${n * 2} hook files to ${out}`);

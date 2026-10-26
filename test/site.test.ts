import * as fs from "fs";
import * as path from "path";
import { parseDocGot, SiteIndex, RawIndex, Detail, hex } from "../src/core/site";
import { generateHook } from "../src/core/hookgen";
const SITE = process.argv[2];
const rd = (p: string) => parseDocGot(fs.readFileSync(path.join(SITE, "data", p), "utf8")).value;
let t = Date.now();
const ix = new SiteIndex(rd("index.js") as RawIndex);
console.log("index ms", Date.now() - t, ix.size);
ix.setStrings(rd("strings.js") as [string, string][]);
ix.setSymbols(rd("symbols.js") as [string, string, string, number][]);
const det = (i: number) => (rd(`e/${ix.bundle(i)}.js`) as Record<string, Detail>)[i];
for (const q of ["Shine::exeGot", "al::setNerve", "Shine::receiveMsg", "Shine::Shine", "al::getTrans", "GameDataFunction::getCurrentStageName", "StageScene::exePlay", "al::LiveActor::kill"]) {
  for (const i of ix.findFn(q).slice(0, 2)) {
    const d = det(i);
    console.log(`--- ${ix.slug(i)} [${ix.kind(i)}] offs=${ix.offsets(i).map(o=>hex(o))}`);
    const r = generateHook(ix, i, d, { kind: "trampoline", install: "symbol" });
    console.log(r.code + r.install + "  include=" + r.include);
  }
}
const f = ix.findByOffset(0x1d2d50); console.log(f && ix.q(f.id), f);
console.log(ix.findString(0x182b1e5), ix.findData(0x18ff0e4 ), ix.search("shine exegot").slice(0,3).map(x=>ix.q(x.id)), ix.search("0x2d2d48 g").map(x=>ix.q(x.id)));
console.log(ix.findType("Shine"), ix.kind(ix.findType("Shine")!), ix.qualify("LiveActor *", ix.ctxFromEntity(ix.findFn("al::setNerve")[0])));

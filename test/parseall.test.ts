import * as fs from "fs"; import * as path from "path"; import { parseDocGot } from "../src/core/site";
const D = path.join(process.argv[2], "data"); let n = 0, bad = 0;
for (const sub of ["e", "gh", "src"]) { const fs_ = fs.readdirSync(path.join(D, sub)); for (let k = 0; k < fs_.length; k += Math.max(1, Math.floor(fs_.length / 400))) { n++; try { parseDocGot(fs.readFileSync(path.join(D, sub, fs_[k]), "utf8")); } catch (e) { bad++; if (bad < 5) console.log(sub, fs_[k], String(e).slice(0, 200)); } } }
for (const f of ["factories.js"]) { n++; try { parseDocGot(fs.readFileSync(path.join(D, f), "utf8")); } catch (e) { bad++; console.log(f, e); } }
console.log("parsed", n, "bad", bad);

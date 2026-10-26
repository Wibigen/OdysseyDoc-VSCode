import { mangledNameParts, scanSource } from "../src/core/scan";
import { shellSplit, parseGccIncludeDirs, transformEntry } from "../src/core/compdb";
import { GccOutputParser } from "../src/core/gccparse";
import { makeWslMapper, winToWsl, wslToWin } from "../src/core/paths";
import { parseDocGot, parseAddr, stripTpl } from "../src/core/site";
const eq = (a: unknown, b: unknown, msg: string) => { const ok = JSON.stringify(a) === JSON.stringify(b); console.log(ok ? "OK  " : "FAIL", msg, ok ? "" : `\n   got ${JSON.stringify(a)}\n   exp ${JSON.stringify(b)}`); if (!ok) process.exitCode = 1; };
eq(mangledNameParts("_ZN5Shine6exeGotEv"), ["Shine","exeGot"], "mangled parts simple");
eq(mangledNameParts("_ZNK5Shine5isGotEv"), ["Shine","isGot"], "mangled parts const");
eq(mangledNameParts("_ZN2al8setNerveEPNS_9IUseNerveEPKNS_5NerveE"), ["al","setNerve"], "mangled parts ns");
eq(mangledNameParts("_ZN5ShineC1EPKc"), ["Shine","Shine"], "ctor");
eq(mangledNameParts("_ZN4sead7Vector3IfE4zeroE"), ["sead","Vector3","zero"], "template");
const src = `HOOK_DEFINE_TRAMPOLINE(A) {};\n// B::InstallAtSymbol("_Zcomment");\nA::InstallAtSymbol("_ZN5Shine6exeGotEv");\nA::InstallAtOffset(0x1D2D48);\nexl::patch::CodePatcher p(0x10);\nX::InstallAtPtr(0x7100000000);`;
const r = scanSource(src);
eq(r.defs.map(d=>[d.name,d.kind]), [["A","trampoline"]], "scan defs");
eq(r.refs.map(x=>[x.kind,x.hookName,x.value]), [["symbol","A","_ZN5Shine6exeGotEv"],["offset","A","0x1D2D48"],["patch","","0x10"],["ptr","X","0x7100000000"]], "scan refs (comment ignored)");
eq(shellSplit(`g++ -DX="a b" -I/x\\ y 'q r' -c f.cpp`), ["g++","-DX=a b","-I/x y","q r","-c","f.cpp"], "shellSplit");
eq(winToWsl("C:\\Users\\Wibi\\mod"), "/mnt/c/Users/Wibi/mod", "winToWsl drive");
eq(winToWsl("\\\\wsl.localhost\\Ubuntu\\home\\wibi\\mod"), "/home/wibi/mod", "winToWsl unc");
eq(winToWsl("\\\\wsl$\\Ubuntu-22.04\\home\\w"), "/home/w", "winToWsl wsl$");
eq(wslToWin("/mnt/d/x/y.cpp", "Ubuntu"), "D:\\x\\y.cpp", "wslToWin drive");
eq(wslToWin("/opt/devkitpro/x.h", "Ubuntu"), "\\\\wsl.localhost\\Ubuntu\\opt\\devkitpro\\x.h", "wslToWin linux");
const m = makeWslMapper("\\\\wsl$\\Ubuntu\\home\\w\\mod", "Ubuntu");
eq(m.toHost("/home/w/mod/src/main.cpp"), "\\\\wsl$\\Ubuntu\\home\\w\\mod\\src\\main.cpp", "mapper keeps workspace UNC form");
const p = new GccOutputParser((x) => x);
for (const l of [
 "/h/src/main.cpp: In function 'void f()':",
 "/h/src/main.cpp:12:5: error: 'Foo' was not declared in this scope",
 "/h/src/main.cpp:3:1: note: previous here",
 "C:/x/y.cpp:7:2: warning: unused [-Wunused]",
 "/h/src/main.cpp:26:(.text+0x10): undefined reference to `al::x()'",
 "/opt/devkitpro/devkitA64/bin/../lib/gcc/aarch64-none-elf/14.2.0/../../../../aarch64-none-elf/bin/ld: cannot find -lfoo",
 "CMake Error at CMakeLists.txt:10 (message):", "  Not targeting switch", "",
 "make[2]: *** [x] Error 1",
]) p.feedLine(l);
p.finish();
eq(p.diags.map(d=>[d.file,d.line,d.col,d.severity,d.notes.length]), [["/h/src/main.cpp",12,5,"error",1],["C:/x/y.cpp",7,2,"warning",0],["/h/src/main.cpp",26,0,"error",0],["",0,0,"error",0],["CMakeLists.txt",10,0,"error",0]], "gcc parser");
eq(p.diags[4].message, "Not targeting switch", "cmake message");
eq(p.makeFailed, true, "make failed");
eq(parseDocGot('DOC.got("e/0",{"1":{"q":"A::b"}});').value, {"1":{"q":"A::b"}}, "DOC.got object");
eq(parseDocGot('DOC.got("index",JSON.parse("{\\"a\\":[1,2]}"));').value, {a:[1,2]}, "DOC.got JSON.parse");
eq(parseDocGot('DOC.got("src/3","// x\\n");').value, "// x\n", "DOC.got string");
eq([parseAddr("0x1d2d48"), parseAddr("0x71001d2d48"), parseAddr(".text::002d2d48"), parseAddr("0x2d2d48 g"), parseAddr("main")], [0x1d2d48,0x1d2d48,0x1d2d48,0x1d2d48,null], "parseAddr");
eq(stripTpl("sead::Vector3<float>::zero"), "sead::Vector3::zero", "stripTpl");
eq(parseGccIncludeDirs("x\n#include <...> search starts here:\n /a/b\n /c\nEnd of search list.\n"), ["/a/b","/c"], "gcc dirs");
const t = transformEntry({directory:"/h/build", file:"/h/src/m.cpp", command:"/opt/x/g++ -I/h/inc -isystem /opt/i -mtp=soft -specs=/x.specs -o a.o -c /h/src/m.cpp"}, {mapPath:(x)=>"W"+x, gccIncludes:["/opt/x/lib/gcc/aarch64-none-elf/14.2.0/include","/opt/x/aarch64-none-elf/include"]});
eq(t.arguments!.filter(a=>!a.startsWith("-W")&&!a.startsWith("--target")&&!a.startsWith("-nostd")), ["clang++","-isystem","W/opt/x/aarch64-none-elf/include","-IW/h/inc","-isystem","W/opt/i","-c","W/h/src/m.cpp"], "compdb transform");

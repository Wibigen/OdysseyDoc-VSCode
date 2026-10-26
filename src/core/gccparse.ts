/** Parses gcc / ld / cmake / make output. */

export type Severity = "error" | "warning" | "info";

export interface ParsedDiag {
    file: string;
    line: number; // 1-based, 0 = inconnu
    col: number; // 1-based, 0 = inconnu
    severity: Severity;
    message: string;
    source: "gcc" | "ld" | "cmake" | "make";
    notes: { file: string; line: number; col: number; message: string }[];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const GCC_RX = /^((?:[A-Za-z]:)?[^:\n]+?):(\d+):(?:(\d+):)?\s+(fatal error|error|warning|note|remarque|erreur|attention|avertissement):\s+(.*)$/;
const LD_REF_RX = /^((?:[A-Za-z]:)?[^:\n]+?):(\d+):\(([^)]*)\):\s+(.*)$/;
const LD_GENERIC_RX = /^(?:.*[\\/])?(?:aarch64-none-elf-)?ld(?:\.exe)?:\s+(.*)$/;
const CMAKE_RX = /^CMake (Error|Warning)(?: \(dev\))? at ([^:]+):(\d+)/;
const MAKE_ERR_RX = /^(?:g?make)(?:\[\d+\])?: \*\*\* (.*)$/;

export class GccOutputParser {
    readonly diags: ParsedDiag[] = [];
    private last: ParsedDiag | undefined;
    private cmakePending: ParsedDiag | undefined;
    errorCount = 0;
    warningCount = 0;
    makeFailed = false;

    constructor(private mapPath: (p: string) => string) {}

    feedLine(rawLine: string) {
        const line = rawLine.replace(ANSI, "").replace(/\r$/, "");
        if (this.cmakePending) {
            if (/^\s+\S/.test(line)) {
                this.cmakePending.message += (this.cmakePending.message ? " " : "") + line.trim();
                return;
            }
            if (line.trim() === "" && !this.cmakePending.message) return;
            this.push(this.cmakePending);
            this.cmakePending = undefined;
        }
        let m: RegExpExecArray | null;
        if ((m = GCC_RX.exec(line))) {
            const file = this.mapPath(m[1].trim());
            const sevRaw = m[4];
            const lineNo = parseInt(m[2], 10);
            const col = m[3] ? parseInt(m[3], 10) : 0;
            if (sevRaw === "note" || sevRaw === "remarque") {
                if (this.last) {
                    this.last.notes.push({ file, line: lineNo, col, message: m[5] });
                    return;
                }
                this.push({ file, line: lineNo, col, severity: "info", message: m[5], source: "gcc", notes: [] });
                return;
            }
            const severity: Severity = /warning|attention|avertissement/.test(sevRaw) ? "warning" : "error";
            this.push({ file, line: lineNo, col, severity, message: m[5], source: "gcc", notes: [] });
            return;
        }
        if ((m = LD_REF_RX.exec(line)) && /undefined reference|multiple definition|relocation/.test(m[4])) {
            this.push({
                file: this.mapPath(m[1].trim()),
                line: parseInt(m[2], 10),
                col: 0,
                severity: "error",
                message: m[4] + this.symbolHint(m[4]),
                source: "ld",
                notes: [],
            });
            return;
        }
        if ((m = LD_GENERIC_RX.exec(line))) {
            const msg = m[1];
            if (/warning/i.test(msg)) {
                this.warningCount++;
                return;
            }
            if (/error|undefined|cannot find|multiple definition/i.test(msg) && !/in function/.test(msg)) {
                this.push({ file: "", line: 0, col: 0, severity: "error", message: msg, source: "ld", notes: [] });
            }
            return;
        }
        if ((m = CMAKE_RX.exec(line))) {
            this.cmakePending = {
                file: this.mapPath(m[2].trim()),
                line: parseInt(m[3], 10),
                col: 0,
                severity: m[1] === "Error" ? "error" : "warning",
                message: "",
                source: "cmake",
                notes: [],
            };
            return;
        }
        if ((m = MAKE_ERR_RX.exec(line))) {
            this.makeFailed = true;
            return;
        }
        // context lines ("In member function", "required from here"): ignored
    }

    /** "undefined reference to `al::foo()'": hints that the symbol must exist in the game. */
    private symbolHint(msg: string): string {
        return /undefined reference to/.test(msg)
            ? " — if it is a game function, check that it exists in OdysseyDoc with this exact signature (const, parameter types)."
            : "";
    }

    finish() {
        if (this.cmakePending) {
            this.push(this.cmakePending);
            this.cmakePending = undefined;
        }
    }

    private push(d: ParsedDiag) {
        // de-duplicate (gcc sometimes repeats the same error for each TU)
        if (this.diags.some((x) => x.file === d.file && x.line === d.line && x.col === d.col && x.message === d.message)) {
            this.last = undefined;
            return;
        }
        this.diags.push(d);
        this.last = d.severity === "info" ? undefined : d;
        if (d.severity === "error") this.errorCount++;
        else if (d.severity === "warning") this.warningCount++;
    }
}

/** Where generated code goes in a source file (pure helpers). */

/**
 * Matches the file's include style: Hakkun-Example writes "al/Library/…" and "game/…",
 * SMO-Exlaunch-Base "Library/…" (both work, include/al and include/game are on the include path).
 */
export function adaptIncludeStyle(text: string, spec: string): string {
    const m = /^"(.*)"$/.exec(spec);
    if (!m || m[1].startsWith("hk/")) return spec;
    const bare = m[1];
    if (bare.startsWith("Library/") || bare.startsWith("Project/")) {
        if (/#\s*include\s*"al\/(Library|Project)\//.test(text)) return `"al/${bare}"`;
    } else if (!/^(al|game|sead|nn|agl|eui)\//.test(bare) && /#\s*include\s*"game\//.test(text)) return `"game/${bare}"`;
    return spec;
}

/** Index of the top-level line where a declaration can go, if `line` is inside a function / class body. */
export function topLevelLine(text: string, line: number): number {
    const lines = text.split("\n");
    const upto = lines.slice(0, line).join("\n");
    const clean = upto.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (s) => s.replace(/[^\n]/g, " "));
    const stack: { off: number; scope: boolean }[] = [];
    let lastStmt = 0;
    for (let i = 0; i < clean.length; i++) {
        const c = clean[i];
        if (c === "{") {
            stack.push({ off: i, scope: /\b(namespace(\s+[\w:]+)?|extern\s+"C")\s*$/.test(upto.slice(lastStmt, i)) });
            lastStmt = i + 1;
        } else if (c === "}") {
            stack.pop();
            lastStmt = i + 1;
        } else if (c === ";") lastStmt = i + 1;
    }
    const body = stack.find((s) => !s.scope);
    if (!body) return line;
    let l = upto.slice(0, body.off).split("\n").length - 1;
    while (l > 0) {
        const prev = lines[l - 1].trim();
        if (!prev || /[;}]$/.test(prev) || prev.startsWith("#") || prev.endsWith("{")) break;
        l--;
    }
    return l;
}

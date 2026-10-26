/**
 * Parses a demangled name produced by c++filt (Itanium):
 *   "al::setNerve(al::IUseNerve*, al::Nerve const*)"
 *   "Shine::exeGot()"
 *   "al::FunctorV0M<BombTail*, void (BombTail::*)()>::operator()() const"
 *   "void al::foo<int>(int)"           (template: return type first)
 *   "sead::Vector3<float>::zero"        (data)
 */

export interface ParsedName {
    /** Full qualified name, with template arguments: "al::FunctorV0M<A>::operator()" */
    qual: string;
    /** Qualified name without template arguments: "al::FunctorV0M::operator()" */
    qualNoTpl: string;
    /** Scope (class or namespace): "al::FunctorV0M<A>"; empty if global */
    scope: string;
    /** Last component: "operator()" / "exeGot" */
    short: string;
    /** Raw parameter list (without parentheses), or null if it is not a function */
    params: string | null;
    /** Parameters split at nesting level 0 */
    paramList: string[];
    isConst: boolean;
    /** Special prefix: "vtable for", "non-virtual thunk to", ... */
    special: string;
    /** Explicit return type (template functions only) */
    explicitRet: string;
}

const SPECIAL_PREFIXES = [
    "construction vtable for ",
    "typeinfo name for ",
    "typeinfo for ",
    "vtable for ",
    "VTT for ",
    "guard variable for ",
    "non-virtual thunk to ",
    "virtual thunk to ",
    "covariant return thunk to ",
    "reference temporary #0 for ",
    "transaction clone for ",
];

const OP_RX = /^operator\s*(<<=|>>=|<<|>>|<=>|<=|>=|->\*|->|<|>|\(\)|\[\])/;

/** Length of an "operator<<"-like token starting at i (0 if none). */
function opLen(s: string, i: number): number {
    if (s.charCodeAt(i) !== 111 /* o */ || !s.startsWith("operator", i)) return 0;
    const m = OP_RX.exec(s.slice(i, i + 14));
    return m ? m[0].length : 0;
}

/** Splits on `sep` at nesting level 0 (<>, (), []). Tolerates "operator<" etc. */
export function splitTopLevel(s: string, sep: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    const sc = sep.charCodeAt(0);
    for (let i = 0; i < s.length; i++) {
        const ol = opLen(s, i);
        if (ol) {
            i += ol - 1;
            continue;
        }
        const c = s.charCodeAt(i);
        if (c === 60 || c === 40 || c === 91) depth++;
        else if (c === 62 || c === 41 || c === 93) depth = depth > 0 ? depth - 1 : 0;
        else if (depth === 0 && c === sc && s.startsWith(sep, i)) {
            out.push(s.slice(start, i));
            start = i + sep.length;
            i += sep.length - 1;
        }
    }
    out.push(s.slice(start));
    return out;
}

export function stripTemplateArgs(s: string): string {
    if (s.indexOf("<") < 0) return s;
    let out = "";
    let depth = 0;
    let runStart = 0;
    for (let i = 0; i < s.length; i++) {
        if (depth === 0) {
            const ol = opLen(s, i);
            if (ol) {
                i += ol - 1;
                continue;
            }
        }
        const c = s.charCodeAt(i);
        if (c === 60) {
            if (depth === 0) out += s.slice(runStart, i);
            depth++;
        } else if (c === 62 && depth > 0) {
            depth--;
            if (depth === 0) runStart = i + 1;
        }
    }
    if (depth === 0) out += s.slice(runStart);
    return out;
}

/** Finds the index of the '(' matching the ')' at position `close`. */
function matchOpenParen(s: string, close: number): number {
    let depth = 0;
    for (let i = close; i >= 0; i--) {
        const c = s[i];
        if (c === ")") depth++;
        else if (c === "(") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

export function parseDemangled(input: string): ParsedName {
    let s = input.trim();
    let special = "";
    for (const p of SPECIAL_PREFIXES) {
        if (s.startsWith(p)) {
            special = p.trim();
            s = s.slice(p.length);
            break;
        }
    }

    let isConst = false;
    let params: string | null = null;
    let name = s;

    // qualifiers after the parameter list
    let tail = s;
    for (;;) {
        const m = /\s+(const|volatile|&&|&|noexcept)$/.exec(tail);
        if (!m) break;
        if (m[1] === "const") isConst = true;
        tail = tail.slice(0, m.index);
    }
    if (tail.endsWith(")")) {
        const open = matchOpenParen(tail, tail.length - 1);
        if (open > 0) {
            params = tail.slice(open + 1, tail.length - 1);
            name = tail.slice(0, open);
        } else {
            isConst = false;
        }
    } else {
        isConst = false;
    }

    // explicit return type (templates): "void al::foo<int>"
    let explicitRet = "";
    const opIdx = name.lastIndexOf("operator");
    let head = name;
    let opPart = "";
    if (opIdx >= 0 && (opIdx === 0 || name[opIdx - 1] === ":" || name[opIdx - 1] === " ")) {
        head = name.slice(0, opIdx);
        opPart = name.slice(opIdx);
    }
    const spaceParts = splitTopLevel(head, " ");
    if (spaceParts.length > 1) {
        const last = spaceParts[spaceParts.length - 1];
        if (opPart && last === "") {
            // "bool operator==" -> head = "bool "
            explicitRet = spaceParts.slice(0, -1).join(" ").trim();
            head = "";
        } else {
            explicitRet = spaceParts.slice(0, -1).join(" ").trim();
            head = last;
        }
    }
    name = (head + opPart).trim();

    const comps = splitTopLevel(name, "::");
    const short = comps[comps.length - 1] ?? name;
    const scope = comps.slice(0, -1).join("::");
    const paramList =
        params === null || params.trim() === "" || params.trim() === "void"
            ? []
            : splitTopLevel(params, ",").map((p) => p.trim());

    return {
        qual: name,
        qualNoTpl: stripTemplateArgs(name),
        scope,
        short,
        params,
        paramList,
        isConst,
        special,
        explicitRet,
    };
}

/** "Class or namespace" heuristic for the last component of a scope. */
export function scopeLooksLikeClass(scope: string, knownNamespaces?: Set<string>): boolean {
    if (!scope) return false;
    if (scope.startsWith("(anonymous namespace)") && !scope.includes("::")) return false;
    const comps = splitTopLevel(scope, "::");
    const last = stripTemplateArgs(comps[comps.length - 1]);
    if (knownNamespaces && knownNamespaces.has(stripTemplateArgs(scope))) return false;
    if (last.includes("<")) return true;
    if (/^(al|sead|nn|rs|agl|eui|nerve|alGraphicsFunction|alPadRumbleFunction|alCameraFunction|alSensorFunction)$/.test(last)) {
        return false;
    }
    return /^[A-Z_]/.test(last) || comps[comps.length - 1].includes("<");
}

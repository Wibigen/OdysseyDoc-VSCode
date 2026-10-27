// Minimal "vscode" module for running UI code paths in Node (tests only).
const any: any = new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : any),
    apply: () => any,
    construct: () => any,
});
const partial = (known: Record<string, unknown>) => new Proxy(known, { get: (t, k) => (k in t ? t[k as string] : k === "then" ? undefined : any) });
const names = "EventEmitter Uri Range Position Selection Location Diagnostic DiagnosticSeverity DiagnosticRelatedInformation CodeAction CodeActionKind CodeLens Hover MarkdownString InlayHint InlayHintKind TreeItem TreeItemCollapsibleState ThemeIcon ThemeColor RelativePattern StatusBarAlignment ViewColumn ProgressLocation ConfigurationTarget TaskGroup TaskScope TaskRevealKind Task CustomExecution WorkspaceEdit TextEditorRevealType Disposable languages commands env extensions tasks".split(" ");
const mod: Record<string, unknown> = {};
for (const n of names) Object.defineProperty(mod, n, { enumerable: true, get: () => any });
// settings = their defaults, no folder, no editor
mod.workspace = partial({ getConfiguration: () => ({ get: (_k: string, d: unknown) => d, inspect: () => undefined, update: async () => undefined }), workspaceFolders: undefined, textDocuments: [] });
mod.window = partial({ activeTextEditor: undefined, visibleTextEditors: [] });
module.exports = mod;

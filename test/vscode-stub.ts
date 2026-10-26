// Minimal "vscode" module for running UI code paths in Node (tests only).
const any: any = new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : any),
    apply: () => any,
    construct: () => any,
});
module.exports = any;

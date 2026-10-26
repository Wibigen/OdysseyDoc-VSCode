// OdysseyDoc details panel (webview). Data comes from the extension through postMessage.
"use strict";
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------- C++ highlighting
const KW = new Set("if else for while do switch case default break continue return goto sizeof new delete this true false nullptr const static virtual inline override struct class enum union namespace public private protected template typename using typedef auto void bool char short int long float double unsigned signed volatile extern operator".split(" "));
const TY = /^(s8|u8|s16|u16|s32|u32|s64|u64|f32|f64|uint|ulong|ushort|byte|undefined\d*|[A-Z]\w*)$/;
function hl(src) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?[fFuUlL]*\b)|([A-Za-z_]\w*)(\s*\()?|(#\s*\w+)|([\s\S])/g;
  let out = "", m;
  while ((m = re.exec(src))) {
    if (m[1]) out += '<span class="c">' + esc(m[1]) + "</span>";
    else if (m[2]) out += '<span class="s">' + esc(m[2]) + "</span>";
    else if (m[3]) out += '<span class="n">' + esc(m[3]) + "</span>";
    else if (m[4]) {
      const w = m[4];
      let cls = KW.has(w) ? "k" : m[5] ? "f" : TY.test(w) ? "t" : "";
      if (/^(undefined\d*|FUN_|DAT_|PTR_|LAB_)/.test(w)) cls = "u";
      out += (cls ? '<span class="' + cls + '">' + esc(w) + "</span>" : esc(w)) + (m[5] ? esc(m[5]) : "");
    } else if (m[6]) out += '<span class="k">' + esc(m[6]) + "</span>";
    else out += esc(m[7]);
  }
  return out;
}
function codeBlock(text, firstLine) {
  const html = hl(String(text).replace(/\s+$/, ""));
  const start = (firstLine || 1) - 1;
  return '<pre style="counter-reset: ln ' + start + '">' + html.split("\n").map((l) => '<span class="l">' + (l || " ") + "</span>").join("") + "</pre>";
}

// ---------------------------------------------------------------- rendering
let cur = null;
let userTab = false;
const chip = (text, cls, copy) => '<span class="chip ' + (cls || "") + (copy ? ' copy" data-copy="' + esc(copy) + '" title="Copy' : "") + '">' + text + "</span>";
const ref = (r) => '<span class="dot st ' + r.st + '"></span><a data-id="' + r.id + '">' + esc(r.q) + "</a>" + (r.off ? ' <span class="dim small">' + r.off + "</span>" : "");
const refList = (o, empty) => {
  if (!o || !o.list.length) return empty === "" ? "" : '<div class="dim small">' + (empty || "—") + "</div>";
  return '<ul class="list">' + o.list.map((r) => "<li>" + ref(r) + "</li>").join("") + "</ul>" + (o.more ? '<div class="dim small">…and ' + o.more + " more (see the site)</div>" : "");
};
const HK = { ok: "hk-ok", warn: "hk-warn", bad: "hk-bad", unknown: "hk-unknown" };

function tabsFor(d) {
  const t = [];
  if (d.isType) t.push(["type", d.kind === "enum" ? "Values" : "Fields & members"]);
  t.push(["decomp", "OdysseyDecomp"]);
  if (d.isFn) t.push(["ghidra", "Ghidra pseudo-code"]);
  if (d.isFn) t.push(["calls", "Calls"]);
  if (d.bins.length) t.push(["hook", "Hook safety"]);
  return t;
}

function showTab(p) {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x.dataset.p === p));
  document.querySelectorAll(".pane").forEach((x) => x.classList.toggle("on", x.id === "p-" + p));
}

function render(d, canBack) {
  cur = d;
  userTab = false;
  $("back").disabled = !canBack;
  $("name").textContent = d.sig;
  const c = [chip(esc(d.kindLabel))];
  if (d.isFn || d.bins.length) c.push(chip('<span class="dot"></span>' + esc(d.status), "st " + d.st));
  for (const b of d.bins) {
    c.push(chip("offset " + b.off + (b.thunk ? " (thunk)" : ""), "", b.off));
    c.push(chip("Ghidra " + b.ghidra, "", b.ghidra));
    c.push(chip(b.abs, "", b.abs));
  }
  if (d.bins.length) c.push(chip(d.bins[0].sz + " bytes"), chip(esc(d.bins[0].obj)), chip("hook: " + esc(d.bins[0].nearLabel), HK[d.bins[0].near]));
  if (d.size !== null && d.isType) c.push(chip("size " + "0x" + d.size.toString(16)));
  if (d.rsrc === "ghidra" || d.rsrc === "unknown") c.push(chip("return type guessed", "st minor"));
  if (d.binOnly) c.push(chip("inferred from the binary"));
  $("chips").innerHTML = c.join("");

  const rows = [];
  if (d.mangled) rows.push('<div class="r"><code>' + esc(d.mangled) + '</code><button class="icon" data-copy="' + esc(d.mangled) + '" title="Copy the symbol">⧉</button></div>');
  const locs = [];
  if (d.decl) locs.push('declared: <a data-url="' + esc(d.decl.url) + '">' + esc(d.decl.f) + ":" + d.decl.l + "</a>");
  if (d.def) locs.push('defined: <a data-url="' + esc(d.def.url) + '">' + esc(d.def.f) + ":" + d.def.l + "</a>");
  if (d.parent) locs.push("in " + ref(d.parent));
  if (locs.length) rows.push('<div class="r">' + locs.join(" · ") + "</div>");
  if (d.include) rows.push('<div class="r"><button class="icon" data-inc="' + esc(d.include) + '" title="Add the include to the active .cpp">#include ' + esc(d.include) + "</button></div>");
  if (d.cm) rows.push('<div class="r dim">' + esc(d.cm.replace(/^\/\/\/?\s*|\/\*+|\*+\//g, "").trim()) + "</div>");
  $("rows").innerHTML = rows.join("");

  const a = [];
  if (d.bins.length) {
    a.push('<button class="primary" data-hook="trampoline">⚡ Hook trampoline</button>');
    a.push('<button data-hook="replace">Hook replace</button>');
    a.push('<button data-hook="inline">Hook inline</button>');
  }
  a.push('<button data-cmd="source"' + (d.decl || d.def ? "" : " disabled") + ">Decomp source</button>");
  if (d.isFn) a.push('<button data-cmd="ghidra">Ghidra pseudo-code</button>');
  a.push('<button class="icon" data-cmd="site" title="Open the page on the OdysseyDoc site">Site ↗</button>');
  $("actions").innerHTML = a.join("");

  const tabs = tabsFor(d);
  $("tabs").innerHTML = tabs.map(([p, l]) => '<div class="tab" data-p="' + p + '">' + l + "</div>").join("");
  $("panes").innerHTML = tabs.map(([p]) => '<div class="pane" id="p-' + p + '"><div class="spin">Loading…</div></div>').join("");
  if (d.isType) renderType(d);
  if (d.isFn) renderCalls(d);
  if (d.bins.length) renderHook(d);
  showTab(tabs[0][0]);
}

function renderType(d) {
  let h = "";
  if (d.underlying) h += '<div class="small">type: <code>' + esc(d.underlying) + "</code></div>";
  if (d.bases.length) h += "<h3>Bases</h3><div>" + d.bases.map((b) => (b.id !== null ? '<a data-id="' + b.id + '">' + esc(b.q) + "</a>" : esc(b.q)) + ' <span class="dim small">' + esc(b.acc) + (b.virt ? " virtual" : "") + "</span>").join("<br>") + "</div>";
  if (d.fields.length) {
    h += '<h3>Fields</h3><table class="t"><thead><tr><th>Offset</th><th>Size</th><th>Type</th><th>Name</th></tr></thead><tbody>' +
      d.fields.map((f) => '<tr><td class="num">' + (f.off !== null ? "0x" + f.off.toString(16) : "?") + '</td><td class="num">' + (f.sz ?? "") + "</td><td>" + (f.ti !== null ? '<a data-id="' + f.ti + '">' + esc(f.t) + "</a>" : esc(f.t)) + "</td><td>" + esc(f.n) + (f.cm ? ' <span class="dim small">' + esc(f.cm.replace(/^\/\/\/?\s*/, "")) + "</span>" : "") + "</td></tr>").join("") + "</tbody></table>";
  }
  if (d.values.length) h += '<h3>Values</h3><table class="t"><tbody>' + d.values.map((v) => "<tr><td>" + esc(v.n) + '</td><td class="num">' + esc(v.x) + "</td></tr>").join("") + "</tbody></table>";
  if (d.nerves.length) h += '<h3>Nerves</h3><ul class="list">' + d.nerves.map((n) => "<li>" + esc(n.m) + "(" + esc(n.n) + ") → " + esc(n.exe) + "</li>").join("") + "</ul>";
  if (d.members.length) h += "<h3>Methods (" + d.members.length + ')</h3><ul class="list">' + d.members.map((r) => "<li>" + ref(r) + "</li>").join("") + "</ul>";
  if (d.derived.list.length) h += "<h3>Derived classes</h3>" + refList(d.derived);
  $("p-type").innerHTML = h || '<div class="empty">No details for this type.</div>';
}

function renderCalls(d) {
  const amb = (g) => g.map((grp) => '<div class="amb">one of: ' + grp.map(ref).join(' <span class="dim">|</span> ') + "</div>").join("");
  let h = '<div class="cols"><div><h3>Calls</h3>' + refList(d.calls, d.callsAmb.length ? "" : "no known calls");
  if (d.callsAmb.length) h += '<h3>Ambiguous</h3><div class="dim small">Several overloads share the name and argument count; the pseudo-code does not say which one is called.</div>' + amb(d.callsAmb);
  h += "</div>";
  h += "<div><h3>Called by</h3>" + refList(d.callers, d.callersAmb.list.length ? "" : "no known callers");
  if (d.callersAmb.list.length) h += '<h3>Maybe called by</h3><div class="dim small">These call an overload with the same name and argument count — possibly this one.</div>' + refList(d.callersAmb);
  h += "</div></div>";
  if (d.overrides.list.length) h += "<h3>Overrides</h3>" + refList(d.overrides);
  if (d.overby.list.length) h += "<h3>Overridden by</h3>" + refList(d.overby);
  $("p-calls").innerHTML = h;
}

function renderHook(d) {
  let h = "";
  for (const b of d.bins) {
    if (d.bins.length > 1) h += "<h3>Entry " + b.off + (b.thunk ? " (thunk)" : "") + "</h3>";
    h += '<div>Normal case (a single <code>B</code>): <span class="pill ' + HK[b.near] + '">' + esc(b.nearLabel) + "</span></div>";
    const near = b.issues.filter((x) => x.mode !== "far");
    if (near.length) h += '<ul class="issues">' + near.map((x) => '<li class="' + (x.lvl === "bad" ? "hk-bad" : x.lvl === "warn" ? "hk-warn" : "dim") + '">' + esc(x.t) + "</li>").join("") + "</ul>";
    h += '<div style="margin-top:6px">Fallback case (absolute jump, 16–20 bytes): <span class="pill ' + HK[b.far] + '">' + esc(b.farLabel) + "</span></div>";
    const far = b.issues.filter((x) => x.mode !== "near");
    if (far.length) h += '<ul class="issues">' + far.map((x) => '<li class="' + (x.lvl === "bad" ? "hk-bad" : x.lvl === "warn" ? "hk-warn" : "dim") + '">' + esc(x.t) + "</li>").join("") + "</ul>";
    if (b.ins.length) h += '<table class="t"><thead><tr><th>#</th><th>Instruction</th><th>PC-relative</th></tr></thead><tbody>' + b.ins.map((x, k) => '<tr><td class="num">' + (k + 1) + "</td><td>" + esc(x[0] + " " + x[1]) + "</td><td>" + (x[2] ? "yes" : "") + "</td></tr>").join("") + "</tbody></table>";
    if (!b.checked) h += '<div class="note">Only the size is checked: per-instruction checks need the site\'s Ghidra export (ExportOdysseyDoc.java).</div>';
  }
  $("p-hook").innerHTML = h;
}

window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m.type === "entity") render(m.data, m.canBack);
  else if (m.type === "error") {
    $("name").textContent = "⚠ " + m.text;
    $("chips").innerHTML = $("rows").innerHTML = $("actions").innerHTML = $("tabs").innerHTML = $("panes").innerHTML = "";
  }
  else if (m.type === "decomp" && $("p-decomp")) {
    if (m.error) {
      $("p-decomp").innerHTML = '<div class="empty">' + esc(m.error) + "</div>";
      if (!userTab && cur && cur.isFn && document.querySelector(".tab.on")?.dataset.p === "decomp") showTab("ghidra");
    } else {
      $("p-decomp").innerHTML = '<div class="note">' + esc(m.path) + ":" + m.line + (m.isDef ? "" : " (declaration)") + "</div>" + codeBlock(m.text, m.line);
      if (!m.isDef && cur && cur.isFn && !userTab && document.querySelector(".tab.on")?.dataset.p === "decomp") showTab("ghidra");
    }
  } else if (m.type === "ghidra" && $("p-ghidra")) {
    if (m.error) $("p-ghidra").innerHTML = '<div class="empty">' + esc(m.error) + "</div>";
    else $("p-ghidra").innerHTML = m.list.map((g) => (m.list.length > 1 ? '<div class="ghhead">' + esc(g.offHex) + " · " + esc(g.path) + "</div>" : '<div class="note">' + esc(g.path) + " — Ghidra addresses = offset + 0x100000</div>") + codeBlock(g.text)).join("");
  }
});

document.addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-copy],[data-hook],[data-cmd],[data-id],[data-inc],[data-url],.tab,#back,#search");
  if (!t || t.disabled) return;
  if (t.classList.contains("tab")) {
    userTab = true;
    return showTab(t.dataset.p);
  }
  if (t.id === "back") return vscode.postMessage({ cmd: "back" });
  if (t.id === "search") return vscode.postMessage({ cmd: "search" });
  if (t.dataset.copy) return vscode.postMessage({ cmd: "copy", text: t.dataset.copy });
  if (t.dataset.hook) return vscode.postMessage({ cmd: "hook", kind: t.dataset.hook });
  if (t.dataset.cmd) return vscode.postMessage({ cmd: t.dataset.cmd });
  if (t.dataset.inc) return vscode.postMessage({ cmd: "include", inc: t.dataset.inc });
  if (t.dataset.url) return vscode.postMessage({ cmd: "url", url: t.dataset.url });
  if (t.dataset.id) return vscode.postMessage({ cmd: "show", id: Number(t.dataset.id) });
});

#!/usr/bin/env node

// src/cli/main.ts
import { mkdtempSync, rmSync as rmSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join as join3, relative, resolve as resolve3 } from "node:path";
import { spawn as spawn2 } from "node:child_process";

// src/core/profile.ts
var ProfileError = class extends Error {
  name = "ProfileError";
};
function parseCpuProfile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProfileError("This is not JSON, so it cannot be a .cpuprofile file.");
  }
  return toCpuProfile(data);
}
function toCpuProfile(data) {
  if (isObject(data) && isObject(data.profile) && Array.isArray(data.profile.nodes)) {
    data = data.profile;
  }
  if (Array.isArray(data) || isObject(data) && Array.isArray(data.traceEvents)) {
    throw new ProfileError(
      'This looks like a Chrome Performance trace, not a CPU profile. In DevTools, record with the "JavaScript Profiler" panel or run Node with --cpu-prof, then load the .cpuprofile file.'
    );
  }
  if (!isObject(data) || !Array.isArray(data.nodes) || data.nodes.length === 0) {
    throw new ProfileError('No call tree found. A .cpuprofile file has a "nodes" array.');
  }
  for (const node of data.nodes) {
    if (!isObject(node) || typeof node.id !== "number" || !isObject(node.callFrame) || typeof node.callFrame.functionName !== "string") {
      throw new ProfileError('The "nodes" array has an entry without an id and callFrame.');
    }
  }
  const profile = data;
  if (typeof profile.startTime !== "number" || typeof profile.endTime !== "number") {
    throw new ProfileError("The profile has no startTime/endTime.");
  }
  if (profile.samples && profile.timeDeltas && profile.samples.length !== profile.timeDeltas.length) {
    throw new ProfileError("The samples and timeDeltas arrays have different lengths.");
  }
  return profile;
}
function isObject(v) {
  return typeof v === "object" && v !== null;
}
function selfTimes(profile) {
  const out = /* @__PURE__ */ new Map();
  const { samples, timeDeltas } = profile;
  if (samples && timeDeltas && samples.length > 0) {
    const n = samples.length;
    let sum = 0;
    for (let i = 1; i < n; i++) sum += Math.max(0, timeDeltas[i]);
    const average = n > 1 ? sum / (n - 1) : profile.endTime - profile.startTime;
    for (let i = 0; i < n; i++) {
      const next = i + 1 < n ? Math.max(0, timeDeltas[i + 1]) : average;
      const id = samples[i];
      out.set(id, (out.get(id) ?? 0) + next);
    }
    return out;
  }
  const hits = profile.nodes.reduce((s, node) => s + (node.hitCount ?? 0), 0);
  const per = hits > 0 ? (profile.endTime - profile.startTime) / hits : 0;
  for (const node of profile.nodes) {
    if (node.hitCount) out.set(node.id, node.hitCount * per);
  }
  return out;
}

// src/core/ranges.ts
function functionEndLine(src, line, column) {
  if (line < 0 || line >= src.length) return null;
  let depthParen = 0;
  let depthBrace = 0;
  let sawBody = false;
  let arrowExpr = false;
  let sawArrow = false;
  let quote2 = null;
  let blockComment = false;
  for (let l = line; l < src.length; l++) {
    const text = src[l];
    let i = l === line ? column : 0;
    for (; i < text.length; i++) {
      const c = text[i];
      const next = text[i + 1];
      if (blockComment) {
        if (c === "*" && next === "/") {
          blockComment = false;
          i++;
        }
        continue;
      }
      if (quote2) {
        if (c === "\\") i++;
        else if (c === quote2) quote2 = null;
        continue;
      }
      if (c === "/" && next === "/") break;
      if (c === "/" && next === "*") {
        blockComment = true;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote2 = c;
        continue;
      }
      if (sawArrow && !sawBody && !arrowExpr && !/\s/.test(c) && c !== "{") arrowExpr = true;
      if (c === "(" || c === "[") depthParen++;
      else if (c === ")" || c === "]") {
        depthParen--;
        if (arrowExpr && depthParen < 0) return l;
      } else if (c === "=" && next === ">" && depthParen === 0 && depthBrace === 0 && !sawBody) {
        sawArrow = true;
        i++;
        continue;
      } else if (c === "{") {
        if (depthParen === 0 && depthBrace === 0 && !sawBody && !arrowExpr) sawBody = true;
        depthBrace++;
      } else if (c === "}") {
        depthBrace--;
        if (sawBody && depthBrace === 0) return l;
        if (depthBrace < 0) return l;
      } else if (c === "," || c === ";") {
        if (arrowExpr && depthParen === 0 && depthBrace === 0) return l;
      }
    }
    if (quote2 === "'" || quote2 === '"') quote2 = null;
    if (arrowExpr && depthParen === 0 && depthBrace === 0) {
      const following = src[l + 1]?.trim() ?? "";
      if (!/^[.?:+\-*/&|]/.test(following)) return l;
    }
    if (l - line > 5e3) return null;
  }
  return null;
}

// src/core/paths.ts
var CATEGORY_LABEL = {
  user: "your code",
  deps: "dependencies",
  node: "Node.js internals",
  native: "native / V8 builtins",
  gc: "garbage collection",
  program: "(program) unattributed native",
  idle: "idle",
  wait: "waiting on child processes",
  root: "root"
};
var PRELOAD_NAME = "perfproof-preload.cjs";
function categorize(functionName, url) {
  switch (functionName) {
    case "(root)":
      return "root";
    case "(idle)":
      return "idle";
    case "(program)":
      return "program";
    case "(garbage collector)":
      return "gc";
  }
  if (!url) return "native";
  if (url.startsWith("node:")) {
    if (/child_process$/.test(url) && /^(spawnSync|execFileSync|execSync)$/.test(functionName)) {
      return "wait";
    }
    return "node";
  }
  if (url.includes(PRELOAD_NAME)) return "node";
  if (/[\\/]node_modules[\\/]/.test(url)) return "deps";
  if (/^(chrome-extension|extensions|v8|wasm|evalmachine)/.test(url)) return "native";
  return "user";
}
function displayPath(url, root) {
  if (!url) return "";
  let path = url;
  if (url.startsWith("file://")) {
    try {
      path = decodeURIComponent(new URL(url).pathname);
    } catch {
      path = url.slice("file://".length);
    }
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  } else if (/^https?:\/\//.test(url)) {
    try {
      const u = new URL(url);
      path = u.host + u.pathname;
    } catch {
    }
  } else {
    path = url.replace(/\\/g, "/");
  }
  const nm = path.lastIndexOf("/node_modules/");
  if (nm !== -1) return path.slice(nm + 1);
  if (root) {
    const r = root.replace(/\\/g, "/").replace(/\/$/, "");
    if (path.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return path.slice(r.length + 1);
  }
  return path;
}
function fileFromUrl(url) {
  if (url.startsWith("file://")) {
    try {
      let path = decodeURIComponent(new URL(url).pathname);
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
      return path;
    } catch {
      return null;
    }
  }
  if (/^([A-Za-z]:[\\/]|\/)/.test(url)) return url;
  return null;
}
function packageName(path) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path.replace(/\\/g, "/"));
  return m ? m[1] : null;
}

// src/core/analyze.ts
var OFF_CPU = /* @__PURE__ */ new Set(["idle", "wait", "root"]);
function frameOf(node, root) {
  const { functionName, url, lineNumber, columnNumber = 0 } = node.callFrame;
  const category = categorize(functionName, url);
  let name = functionName;
  if (!name) name = lineNumber <= 0 && columnNumber <= 0 && url ? "(module)" : "(anonymous)";
  const key = url ? `${url}\0${lineNumber}\0${columnNumber}\0${name}` : `\0${name}`;
  return {
    key,
    name,
    url,
    line: lineNumber + 1,
    column: columnNumber,
    file: displayPath(url, root),
    category
  };
}
function analyzeProfiles(profiles, opts = {}) {
  const { root, limit = 50, flameMinFraction = 1e-3 } = opts;
  const fnStats = /* @__PURE__ */ new Map();
  const lineStats = /* @__PURE__ */ new Map();
  const categoryMs = /* @__PURE__ */ new Map();
  const processes = [];
  const flameRoot = { name: "all", category: "root", selfMs: 0, totalMs: 0 };
  const starts = /* @__PURE__ */ new Map();
  const lineOwners = /* @__PURE__ */ new Map();
  for (const { name: processName, profile } of profiles) {
    const byId = /* @__PURE__ */ new Map();
    for (const node of profile.nodes) byId.set(node.id, node);
    const isChild = /* @__PURE__ */ new Set();
    for (const node of profile.nodes) for (const c of node.children ?? []) isChild.add(c);
    const roots = profile.nodes.filter((n) => !isChild.has(n.id));
    const self = selfTimes(profile);
    const frames = /* @__PURE__ */ new Map();
    for (const node of profile.nodes) frames.set(node.id, frameOf(node, root));
    const subtree = /* @__PURE__ */ new Map();
    const order = [];
    const stack = roots.map((r) => r.id);
    while (stack.length) {
      const id = stack.pop();
      order.push(id);
      for (const c of byId.get(id)?.children ?? []) stack.push(c);
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      let sum = self.get(id) ?? 0;
      for (const c of byId.get(id)?.children ?? []) sum += subtree.get(c) ?? 0;
      subtree.set(id, sum);
    }
    const proc = {
      name: processName,
      label: "",
      cpuMs: 0,
      waitMs: 0,
      idleMs: 0,
      durationMs: (profile.endTime - profile.startTime) / 1e3
    };
    const procFlame = {
      name: processName,
      category: "root",
      selfMs: 0,
      totalMs: 0,
      children: []
    };
    const userTotals = /* @__PURE__ */ new Map();
    const onPath = /* @__PURE__ */ new Map();
    const work = roots.map((r) => ({ id: r.id, flame: procFlame, enter: true }));
    while (work.length) {
      const item = work.pop();
      const node = byId.get(item.id);
      const frame = frames.get(item.id);
      if (!item.enter) {
        const n = (onPath.get(frame.key) ?? 1) - 1;
        if (n === 0) onPath.delete(frame.key);
        else onPath.set(frame.key, n);
        continue;
      }
      const selfUs = self.get(item.id) ?? 0;
      const totalUs = subtree.get(item.id) ?? 0;
      const selfMs = selfUs / 1e3;
      if (frame.category !== "root") {
        let stat = fnStats.get(frame.key);
        if (!stat) {
          stat = {
            name: frame.name,
            file: frame.file,
            url: frame.url,
            line: frame.line,
            category: frame.category,
            selfMs: 0,
            totalMs: 0
          };
          fnStats.set(frame.key, stat);
          if (frame.url) {
            const list = starts.get(frame.url) ?? [];
            list.push({ line: frame.line, column: frame.column, name: frame.name });
            starts.set(frame.url, list);
          }
        }
        stat.selfMs += selfMs;
        if (!onPath.has(frame.key)) stat.totalMs += totalUs / 1e3;
        if (frame.category === "user" && !onPath.has(frame.key)) {
          userTotals.set(stat.file, (userTotals.get(stat.file) ?? 0) + totalUs / 1e3);
        }
        categoryMs.set(frame.category, (categoryMs.get(frame.category) ?? 0) + selfMs);
        if (frame.category === "idle") proc.idleMs += selfMs;
        else if (frame.category === "wait") proc.waitMs += selfMs;
        else proc.cpuMs += selfMs;
        if (selfUs > 0 && frame.url && !OFF_CPU.has(frame.category)) {
          const ticks = node.positionTicks?.filter((p) => p.ticks > 0) ?? [];
          const sum = ticks.reduce((s, p) => s + p.ticks, 0);
          const parts = sum > 0 ? ticks.map((p) => [p.line, p.ticks / sum]) : [[frame.line, 1]];
          for (const [line, share2] of parts) {
            const key = `${frame.url}\0${line}`;
            let ls = lineStats.get(key);
            if (!ls) {
              ls = {
                file: frame.file,
                url: frame.url,
                line,
                fn: frame.name,
                category: frame.category,
                selfMs: 0
              };
              lineStats.set(key, ls);
            }
            ls.selfMs += selfMs * share2;
            const owners = lineOwners.get(key) ?? /* @__PURE__ */ new Map();
            owners.set(frame.name, (owners.get(frame.name) ?? 0) + selfMs * share2);
            lineOwners.set(key, owners);
          }
        }
      }
      let flame = item.flame;
      if (frame.category !== "root") {
        flame.children ??= [];
        let child = flame.children.find(
          (c) => c.name === frame.name && c.file === (frame.url ? frame.file : void 0) && c.line === (frame.url ? frame.line : void 0)
        );
        if (!child) {
          child = {
            name: frame.name,
            file: frame.url ? frame.file : void 0,
            line: frame.url ? frame.line : void 0,
            category: frame.category,
            selfMs: 0,
            totalMs: 0
          };
          flame.children.push(child);
        }
        child.selfMs += selfMs;
        child.totalMs += totalUs / 1e3;
        flame = child;
      }
      onPath.set(frame.key, (onPath.get(frame.key) ?? 0) + 1);
      work.push({ id: item.id, flame, enter: false });
      for (const c of node.children ?? []) work.push({ id: c, flame, enter: true });
    }
    const top = [...userTotals].sort((a, b) => b[1] - a[1])[0];
    proc.label = top ? top[0] : guessLabel(profile.nodes, frames) ?? "node";
    procFlame.name = `${proc.label} (${processName})`;
    procFlame.totalMs = sumChildren(procFlame);
    processes.push(proc);
    if (profiles.length === 1) {
      flameRoot.children = procFlame.children;
      flameRoot.name = proc.label;
    } else {
      (flameRoot.children ??= []).push(procFlame);
    }
  }
  flameRoot.totalMs = sumChildren(flameRoot);
  prune(flameRoot, flameRoot.totalMs * flameMinFraction);
  for (const [key, ls] of lineStats) {
    const owners = [...lineOwners.get(key) ?? []].sort((a, b) => b[1] - a[1]);
    ls.fn = owners[0]?.[0] ?? ls.fn;
    const src = opts.source?.(ls.url);
    if (!src) continue;
    let best;
    for (const f of starts.get(ls.url) ?? []) {
      if (f.name === "(module)" || f.line > ls.line || best && f.line < best.line) continue;
      const end = functionEndLine(src, f.line - 1, f.column);
      if (end !== null && end + 1 >= ls.line) best = f;
    }
    ls.fn = best ? best.name : "(module)";
  }
  const sampledMs = [...categoryMs].reduce((s, [c, ms2]) => c === "root" ? s : s + ms2, 0);
  const cpuMs = [...categoryMs].reduce((s, [c, ms2]) => OFF_CPU.has(c) ? s : s + ms2, 0);
  const functions = [...fnStats.values()].filter((f) => !OFF_CPU.has(f.category) && f.selfMs > 0).sort((a, b) => b.selfMs - a.selfMs).slice(0, limit);
  const lines = [...lineStats.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, limit);
  const categories = [...categoryMs].filter(([c, ms2]) => c !== "root" && ms2 > 0).map(([category, ms2]) => ({ category, ms: ms2 })).sort((a, b) => b.ms - a.ms);
  const analysis = {
    version: 1,
    command: opts.command,
    wallMs: opts.wallMs,
    exitCode: opts.exitCode,
    sampledMs,
    cpuMs,
    categories,
    processes,
    functions,
    lines,
    flame: flameRoot,
    hints: []
  };
  analysis.hints = globalHints(analysis, [...fnStats.values()]);
  return analysis;
}
function guessLabel(nodes, frames) {
  for (const node of nodes) {
    const f = frames.get(node.id);
    if (f.category === "user") return f.file;
    if (f.category === "deps") return packageName(f.file) ?? f.file;
  }
  return void 0;
}
function sumChildren(node) {
  return node.selfMs + (node.children ?? []).reduce((s, c) => s + c.totalMs, 0);
}
function prune(node, min) {
  if (!node.children) return;
  node.children = node.children.filter((c) => c.totalMs >= min).sort((a, b) => b.totalMs - a.totalMs);
  for (const c of node.children) prune(c, min);
  if (node.children.length === 0) delete node.children;
}
function share(ms2, of) {
  return of > 0 ? ms2 / of * 100 : 0;
}
function globalHints(a, allFns) {
  const hints = [];
  const cat = (c) => a.categories.find((x) => x.category === c)?.ms ?? 0;
  const pct2 = (ms2) => `${share(ms2, a.cpuMs).toFixed(0)}%`;
  if (a.cpuMs <= 0) return ["No CPU samples were recorded. Did the command run any JavaScript?"];
  const gc = cat("gc");
  if (share(gc, a.cpuMs) >= 10) {
    hints.push(
      `Garbage collection is ${pct2(gc)} of CPU time: the hot code allocates a lot (temporary arrays, objects, strings, closures). Reusing or avoiding those allocations helps.`
    );
  }
  const deps = cat("deps");
  const user = cat("user");
  if (share(deps, a.cpuMs) >= 35 && deps > user) {
    const byPkg = /* @__PURE__ */ new Map();
    for (const f of allFns) {
      if (f.category !== "deps") continue;
      const pkg = packageName(f.file) ?? f.file;
      byPkg.set(pkg, (byPkg.get(pkg) ?? 0) + f.selfMs);
    }
    const topPkgs = [...byPkg].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([p, ms2]) => `${p} ${pct2(ms2)}`).join(", ");
    hints.push(
      `Most CPU time is inside dependencies (${topPkgs}). Before tuning your own lines, check how often your code calls into them and with how much data.`
    );
  }
  const node = cat("node");
  if (share(node, a.cpuMs) >= 35) {
    hints.push(
      `Node.js internals take ${pct2(node)} of CPU time. That is usually module loading, I/O or stream handling; look at the hot functions' callers in the flame graph.`
    );
  }
  const program = cat("program");
  if (share(program, a.cpuMs) >= 30) {
    hints.push(
      `${pct2(program)} is "(program)": native work V8 cannot attribute to a JS function (startup, compilation, native addons). Short commands are often dominated by it.`
    );
  }
  const wait = cat("wait");
  if (wait > a.cpuMs && a.processes.length > 1) {
    hints.push(
      `Parent processes mostly wait for children (${CATEGORY_LABEL.wait}); the work happens in the child processes listed below.`
    );
  }
  if (a.wallMs && a.processes.length === 1 && a.cpuMs < a.wallMs * 0.5) {
    hints.push(
      `CPU was busy for only ${share(a.cpuMs, a.wallMs).toFixed(0)}% of the wall-clock time. The rest is waiting (network, disk, timers), which a CPU profile cannot explain.`
    );
  }
  return hints;
}

// src/core/format.ts
function ms(value) {
  if (!Number.isFinite(value)) return "\u2013";
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)} s`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)} s`;
  if (value >= 100) return `${value.toFixed(0)} ms`;
  if (value >= 10) return `${value.toFixed(1)} ms`;
  return `${value.toFixed(2)} ms`;
}
function pct(value) {
  if (value >= 9.95) return `${value.toFixed(0)}%`;
  return `${value.toFixed(1)}%`;
}
function pValue(p) {
  if (p < 1e-4) return "p < 0.0001";
  return `p = ${p.toFixed(p < 0.01 ? 4 : 3)}`;
}
function times(speedup) {
  if (!Number.isFinite(speedup)) return "\u221E\xD7";
  return `${speedup >= 10 ? speedup.toFixed(0) : speedup.toFixed(2)}\xD7`;
}
function bar(fraction, width = 20) {
  const n = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return "\u2588".repeat(n) + "\xB7".repeat(width - n);
}

// src/core/report.ts
function textReport(a, opts = {}) {
  const top = opts.top ?? 8;
  const out = [];
  const head = ["perfproof"];
  if (a.command) head.push(a.command);
  out.push(head.join(" \xB7 "));
  const facts = [];
  if (a.wallMs !== void 0) facts.push(`wall ${ms(a.wallMs)}`);
  facts.push(`CPU ${ms(a.cpuMs)}`);
  facts.push(a.processes.length === 1 ? "1 process" : `${a.processes.length} processes`);
  if (a.exitCode !== void 0 && a.exitCode !== null && a.exitCode !== 0) {
    facts.push(`exit code ${a.exitCode}`);
  }
  out.push(facts.join(" \xB7 "), "");
  out.push("Where the CPU time goes");
  for (const c of a.categories.filter((c2) => c2.category !== "idle" && c2.category !== "wait")) {
    const s = share(c.ms, a.cpuMs);
    if (s < 0.5) continue;
    out.push(
      `  ${CATEGORY_LABEL[c.category].padEnd(30)} ${pct(s).padStart(6)}  ${bar(s / 100)}  ${ms(c.ms)}`
    );
  }
  out.push("");
  const lines = a.lines.slice(0, top);
  if (lines.length) {
    out.push("Hot lines (self time)");
    lines.forEach((l, i) => {
      out.push(
        `  ${String(i + 1).padStart(2)}. ${l.file}:${l.line}  ${l.fn}  ${ms(l.selfMs)}  ${pct(share(l.selfMs, a.cpuMs))}${l.category === "user" ? "" : `  [${CATEGORY_LABEL[l.category]}]`}`
      );
      if (l.snippet) out.push(...snippetLines(l, "      "));
      if (l.hint) out.push(`      hint: ${l.hint}`);
    });
    out.push("");
  }
  const fns = a.functions.slice(0, top);
  if (fns.length) {
    out.push("Hot functions (self \xB7 total)");
    for (const f of fns) {
      const where = f.file ? `${f.file}:${f.line}` : CATEGORY_LABEL[f.category];
      out.push(
        `  ${pct(share(f.selfMs, a.cpuMs)).padStart(6)}  ${ms(f.selfMs).padStart(9)} \xB7 ${ms(f.totalMs).padStart(9)}  ${f.name}  ${where}`
      );
    }
    out.push("");
  }
  if (a.processes.length > 1) {
    out.push("Processes");
    for (const p of [...a.processes].sort((x, y) => y.cpuMs - x.cpuMs)) {
      const wait = p.waitMs > 1 ? `, waited ${ms(p.waitMs)} on children` : "";
      out.push(`  ${p.name.padEnd(13)} ${ms(p.cpuMs).padStart(9)} CPU  ${p.label}${wait}`);
    }
    out.push("");
  }
  if (a.hints.length) {
    out.push("Notes");
    for (const h of a.hints) out.push(`  - ${h}`);
    out.push("");
  }
  if (opts.savedTo)
    out.push(`Saved ${opts.savedTo} (report.md, report.json, flamegraph.html, *.cpuprofile)`);
  return out.join("\n").trimEnd() + "\n";
}
function snippetLines(l, indent) {
  if (!l.snippet) return [];
  const width = String(l.snippet.start + l.snippet.code.length - 1).length;
  return l.snippet.code.map((code2, i) => {
    const n = l.snippet.start + i;
    const mark = n === l.line ? ">" : " ";
    return `${indent}${mark} ${String(n).padStart(width)} | ${code2}`.trimEnd();
  });
}
function markdownReport(a, opts = {}) {
  const top = opts.top ?? 10;
  const out = [];
  out.push(`## perfproof profile${a.command ? `: \`${a.command}\`` : ""}`, "");
  const facts = [];
  if (a.wallMs !== void 0) facts.push(`**Wall:** ${ms(a.wallMs)}`);
  facts.push(`**CPU:** ${ms(a.cpuMs)}`);
  facts.push(`**Processes:** ${a.processes.length}`);
  out.push(facts.join(" \xB7 "), "");
  out.push("| Category | Share | Time |", "| --- | ---: | ---: |");
  for (const c of a.categories.filter((c2) => c2.category !== "idle" && c2.category !== "wait")) {
    if (share(c.ms, a.cpuMs) < 0.5) continue;
    out.push(`| ${CATEGORY_LABEL[c.category]} | ${pct(share(c.ms, a.cpuMs))} | ${ms(c.ms)} |`);
  }
  out.push("");
  const lines = a.lines.slice(0, top);
  if (lines.length) {
    out.push(
      "### Hot lines",
      "",
      "| # | Line | Function | Self | Share |",
      "| ---: | --- | --- | ---: | ---: |"
    );
    lines.forEach((l, i) => {
      out.push(
        `| ${i + 1} | \`${md(l.file)}:${l.line}\` | \`${md(l.fn)}\` | ${ms(l.selfMs)} | ${pct(share(l.selfMs, a.cpuMs))} |`
      );
    });
    out.push("");
    const first = lines.find((l) => l.snippet);
    if (first?.snippet) {
      out.push(`Hottest line in context (\`${first.file}:${first.line}\`):`, "", "```js");
      out.push(...snippetLines(first, ""));
      out.push("```", "");
      if (first.hint) out.push(`> ${first.hint}`, "");
    }
  }
  const fns = a.functions.slice(0, top);
  if (fns.length) {
    out.push(
      "### Hot functions",
      "",
      "| Function | Location | Self | Total |",
      "| --- | --- | ---: | ---: |"
    );
    for (const f of fns) {
      out.push(
        `| \`${md(f.name)}\` | ${f.file ? `\`${md(f.file)}:${f.line}\`` : CATEGORY_LABEL[f.category]} | ${ms(f.selfMs)} | ${ms(f.totalMs)} |`
      );
    }
    out.push("");
  }
  if (a.hints.length) {
    for (const h of a.hints) out.push(`- ${h}`);
    out.push("");
  }
  out.push("<sub>Generated by [perfproof](https://github.com/feresbr1/perfproof).</sub>");
  return out.join("\n") + "\n";
}
function md(s) {
  return s.replace(/\|/g, "\\|").replace(/`/g, "'");
}
function benchText(result, base) {
  const s = result.summary;
  const out = [];
  out.push(`perfproof bench \xB7 ${result.command}`);
  out.push(
    `  ${s.n} runs: ${ms(s.mean)} \xB1 ${ms(s.ci95)} (95% CI) \xB7 median ${ms(s.median)} \xB7 min ${ms(s.min)} \xB7 max ${ms(s.max)} \xB7 sd ${ms(s.sd)}`
  );
  if (s.mean > 0 && s.sd / s.mean > 0.1) {
    out.push("  note: runs vary by more than 10%; close other programs or add more runs (-n).");
  }
  if (base) {
    const b = base.result.summary;
    out.push(`  baseline "${base.name}": ${ms(b.mean)} \xB1 ${ms(b.ci95)} (${b.n} runs)`);
    out.push("", `  ${verdictLine(base.cmp)}`);
  }
  return out.join("\n") + "\n";
}
function verdictLine(cmp) {
  const change = `${cmp.change > 0 ? "+" : ""}${(cmp.change * 100).toFixed(1)}%`;
  if (cmp.verdict === "faster") {
    return `FASTER: ${times(cmp.speedup)} faster than the baseline (${change} time, ${pValue(cmp.p)})`;
  }
  if (cmp.verdict === "slower") {
    return `SLOWER: takes ${times(1 / cmp.speedup)} as long as the baseline (${change} time, ${pValue(cmp.p)})`;
  }
  return `NO SIGNIFICANT DIFFERENCE (${change}, ${pValue(cmp.p)}). Treat it as noise.`;
}
function benchMarkdown(result, base) {
  const s = result.summary;
  const rows = ["| | Mean | 95% CI | Median | Runs |", "| --- | ---: | ---: | ---: | ---: |"];
  if (base) {
    const b = base.result.summary;
    rows.push(
      `| Baseline (${base.name}) | ${ms(b.mean)} | \xB1 ${ms(b.ci95)} | ${ms(b.median)} | ${b.n} |`
    );
  }
  rows.push(`| Current | ${ms(s.mean)} | \xB1 ${ms(s.ci95)} | ${ms(s.median)} | ${s.n} |`);
  const out = [`## perfproof bench: \`${result.command}\``, "", ...rows, ""];
  if (base) out.push(`**${verdictLine(base.cmp)}** (Welch's t-test)`, "");
  return out.join("\n");
}

// src/core/stats.ts
function summarize(xs) {
  const n = xs.length;
  if (n === 0) throw new Error("No measurements.");
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const ci95 = n > 1 ? tQuantile(0.975, n - 1) * (sd / Math.sqrt(n)) : 0;
  return { n, mean, sd, median, min: sorted[0], max: sorted[n - 1], ci95 };
}
function compare(baseline, current, { alpha = 0.05, minChange = 0.02 } = {}) {
  const a = summarize(baseline);
  const b = summarize(current);
  const va = a.sd ** 2 / a.n;
  const vb = b.sd ** 2 / b.n;
  const diff = b.mean - a.mean;
  let t;
  let df;
  let p;
  if (va + vb === 0) {
    t = diff === 0 ? 0 : Math.sign(diff) * Infinity;
    df = a.n + b.n - 2;
    p = diff === 0 ? 1 : 0;
  } else {
    t = diff / Math.sqrt(va + vb);
    const denom = (a.n > 1 ? va ** 2 / (a.n - 1) : 0) + (b.n > 1 ? vb ** 2 / (b.n - 1) : 0);
    df = denom > 0 ? (va + vb) ** 2 / denom : a.n + b.n - 2;
    p = 2 * (1 - tCdf(Math.abs(t), Math.max(df, 1)));
  }
  const change = a.mean > 0 ? diff / a.mean : 0;
  const speedup = b.mean > 0 ? a.mean / b.mean : Infinity;
  let verdict = "same";
  if (p < alpha && Math.abs(change) >= minChange) verdict = diff < 0 ? "faster" : "slower";
  return { speedup, change, p, t, df, verdict };
}
function tCdf(t, df) {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}
function tQuantile(p, df) {
  let lo = -1e3;
  let hi = 1e3;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBeta = logGamma(a + b) - logGamma(a) - logGamma(b);
  const front = Math.exp(lnBeta + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return front * betaFraction(x, a, b) / a;
  return 1 - front * betaFraction(1 - x, b, a) / b;
}
function betaFraction(x, a, b) {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return h;
}
function logGamma(z) {
  const g = 7;
  const coef = [
    0.9999999999998099,
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9984369578019572e-21,
    15056327351493116e-23
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = coef[0];
  for (let i = 1; i < g + 2; i++) x += coef[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// src/node/bench.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// src/node/command.ts
import { spawn } from "node:child_process";
var isWindows = process.platform === "win32";
function commandLine(argv) {
  return argv.map(quote).join(" ");
}
function quote(arg) {
  if (arg === "") return '""';
  if (!/[\s"'&|<>^()%!;$`*?[\]{}~#]/.test(arg)) return arg;
  if (isWindows) return `"${arg.replace(/"/g, '""')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
function runCommand(argv, opts) {
  const asShellLine = argv.length === 1 && /\s/.test(argv[0]);
  const useShell = isWindows || asShellLine;
  const [file, args] = useShell ? [asShellLine ? argv[0] : commandLine(argv), []] : [argv[0], argv.slice(1)];
  return new Promise((resolve4, reject) => {
    const start = performance.now();
    let tail = "";
    const keep = (chunk) => {
      tail = (tail + chunk.toString("utf8")).slice(-4e3);
    };
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: useShell,
      stdio: opts.output === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", (err) => {
      if (err.code === "ENOENT") reject(new Error(`Command not found: ${argv[0]}`));
      else reject(err);
    });
    child.on("close", (exitCode, signal) => {
      resolve4({ exitCode, signal, wallMs: performance.now() - start, tail });
    });
  });
}

// src/node/bench.ts
var BenchError = class extends Error {
  name = "BenchError";
};
async function bench(opts) {
  const total = opts.warmup + opts.runs;
  const runs = [];
  for (let i = 0; i < total; i++) {
    const r = await runCommand(opts.argv, {
      cwd: opts.cwd,
      output: opts.showOutput ? "inherit" : "hide"
    });
    if (r.exitCode !== 0) {
      const why = r.signal ? `was killed by ${r.signal}` : `exited with code ${r.exitCode}`;
      throw new BenchError(
        `The command ${why} on run ${i + 1}. Benchmarks only count successful runs.${r.tail ? `

Last output:
${r.tail.trimEnd()}` : ""}`
      );
    }
    if (i >= opts.warmup) runs.push(r.wallMs);
    opts.onProgress?.(i + 1, total);
  }
  return {
    command: commandLine(opts.argv),
    runs,
    summary: summarize(runs),
    failures: 0,
    node: process.version,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function baselinePath(cwd, name) {
  if (/[\\/]|\.json$/.test(name)) return resolve(cwd, name);
  if (!/^[\w.-]+$/.test(name)) {
    throw new BenchError(`Baseline names may only use letters, digits, ".", "-" and "_": ${name}`);
  }
  return join(resolve(cwd, ".perfproof"), "baselines", `${name}.json`);
}
function saveBaseline(cwd, name, result) {
  const file = baselinePath(cwd, name);
  mkdirSync(dirname(file), { recursive: true });
  const base = resolve(cwd, ".perfproof");
  const ignore = join(base, ".gitignore");
  if (file.startsWith(base) && !existsSync(ignore)) writeFileSync(ignore, "*\n");
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  return file;
}
function loadBaseline(cwd, name) {
  const file = baselinePath(cwd, name);
  if (!existsSync(file)) {
    throw new BenchError(
      `No baseline "${name}" (${file}). Save one first: perfproof bench --save ${name} -- <command>`
    );
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new BenchError(`The baseline ${file} is not valid JSON.`);
  }
  if (!Array.isArray(data.runs) || data.runs.length === 0 || !data.runs.every((x) => typeof x === "number")) {
    throw new BenchError(`The baseline ${file} has no timings.`);
  }
  return { ...data, summary: summarize(data.runs) };
}

// src/node/html.ts
var BACKSLASH = String.fromCharCode(92);
function scriptSafeJson(value) {
  return JSON.stringify(value).replace(/</g, `${BACKSLASH}u003c`).replace(new RegExp(String.fromCharCode(8232), "g"), `${BACKSLASH}u2028`).replace(new RegExp(String.fromCharCode(8233), "g"), `${BACKSLASH}u2029`);
}
function escapeHtml(s) {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
  );
}
function analysisToHtml(analysis, viewerJs) {
  const js = viewerJs ?? (true ? '"use strict";(()=>{var v,xe,Ke,L,be,Q,we,Y,ke,ie,se,Qe,X={},ee=[],Xe=/^m(i|n|o|s|text|space)$/,ae=Array.isArray,Me=ee.slice,D=Object.assign;function te(e){e&&e.parentNode&&e.remove()}function Z(e,t,n,r,l){var o={type:e,props:t,key:n,ref:r,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:l||++xe,__i:-1,__u:0};return!l&&v.vnode&&v.vnode(o),o}function R(e){return e.children}function K(e,t){this.props=e,this.context=t,this.__g=0}function U(e,t){if(t==null)return e.__?U(e.__,e.__i+1):null;for(var n;t<e.__k.length;t++)if((n=e.__k[t])&&n.__e)return n.__e;return typeof e.type!="function"||e.props.__P?null:U(e)}function Ce(e){if((e=e.__)&&e.__c&&!e.props.__P)return e.__e=null,e.__k.some(function(t){return t&&(e.__e=t.__e)}),Ce(e)}function ye(e){(8&e.__g||!(e.__g|=8)||!L.push(e)||Q++)&&be==v.debounceRendering||((be=v.debounceRendering)||queueMicrotask)(et)}function et(){var e,t,n,r,l,o,i,c,f;try{for(t=1;L.length;)L.length>t&&L.sort(we),e=L.shift(),t=L.length,8&e.__g&&(r=void 0,l=void 0,o=(l=(n=e).__v).__e,i=[],c=[],(f=n.__P)&&((r=D({constructor:void 0},l)).__v=l.__v+1,v.vnode&&v.vnode(r),le(f,r,l,n.__n,f.namespaceURI,32&l.__u?[o]:null,i,o||U(l),32&l.__u,c),r.__v=l.__v,r.__.__k[r.__i]=r,$e(i,r,c),l.__=l.__e=null,r.__e!=o&&Ce(r)))}finally{L.length=Q=0}}function Fe(e,t,n,r,l,o,i,c,f,_,p){var g,b,m,h,a,x,k=r.__k||ee,u=t.length;for(f=tt(n,t,k,f,u),g=0;g<u;g++)(m=n.__k[g])!=null&&(b=~m.__i&&k[m.__i]||X,m.__i=g,x=le(e,m,b,l,o,i,c,f,_,p),h=m.__e,(b.ref!=m.ref||8&b.__u)&&(b.ref&&pe(b.ref,null,m,b),m.ref&&p.push(m.ref,m.__c||h,m)),a=a||h,4&m.__u?(f=Se(m,f,e,!b.__v),b.__e&&(b.__e=null)):typeof m.type=="function"&&x!==void 0?f=x:h&&(f=h.nextSibling),m.__u&=-7);return n.__e=a,f}function tt(e,t,n,r,l){var o,i,c,f,_,p,g,b,m,h,a=n.length,x=a,k=0,u=!1,d=e.__k=Array(l);for(o=0;o<l;o++)(i=t[o])!=null&&typeof i!="boolean"&&typeof i!="function"?(typeof i!="object"||i.constructor==String?i=d[o]=Z(null,i):ae(i)?i=d[o]=Z(R,{children:i}):i.constructor===void 0&&i.__b?i=d[o]=Z(i.type,i.props,i.key,i.ref,i.__v):d[o]=i,f=o+k,i.__=e,i.__b=e.__b+1,c=null,~(_=i.__i=nt(i,n,f,x))&&(x--,(c=n[_])&&(c.__u|=2)),c&&c.__v?(i.__u|=2,_==f-1?k--:_==f+1?k++:_!=f&&(_>f?k--:k++,u=!0)):(~_||(l>a?k--:l<a&&k++),typeof i.type!="function"&&(i.__u|=4))):d[o]=null;if(u){for(p=[],g=[],o=0;o<l;o++)if((i=d[o])&&2&i.__u){for(b=0,m=p.length;b<m;)p[h=b+m>>1]<i.__i?b=h+1:m=h;p[b]=i.__i,g[o]=b+1}for(k=p.length;o--;)g[o]&&(g[o]==k?k--:d[o].__u|=4)}if(x)for(o=0;o<a;o++)!(c=n[o])||2&c.__u||(c.__e==r&&(r=U(c)),ce(c,c));return r}function Se(e,t,n,r){var l,o,i;if(typeof e.type=="function"){if(e.props.__P)return t;if(l=e.__k)for(o=0;o<l.length;o++)l[o]&&(l[o].__=e,t=Se(l[o],t,n,!1));return t}for(t&&!t.parentNode&&(t=U(e))&&!t.parentNode&&(t=null),i=t;i&&i.nodeType==8;)i=i.nextSibling;for(e.__e!=i&&(!r&&n.moveBefore&&e.__e.parentNode?n.moveBefore(e.__e,t):n.insertBefore(e.__e,t||null)),t=e.__e;(t=t&&t.nextSibling)&&t.nodeType==8;);return t}function nt(e,t,n,r){var l,o,i,c=e.key,f=e.type,_=t[n],p=_&&!(2&_.__u);if(_===null&&c==null||p&&c==_.key&&f==_.type)return n;if(r>(p?1:0)){for(l=n-1,o=n+1;l>=0||o<t.length;)if((_=t[i=l>=0?l--:o++])&&!(2&_.__u)&&c==_.key&&f==_.type)return i}return-1}function ve(e,t,n){n==null&&(n=""),t[0]=="-"?e.setProperty(t,n):e[t]=n}function J(e,t,n,r,l){var o,i;e:if(t=="style")if(typeof n=="string")e.style.cssText=n;else{if(typeof r=="string"&&(e.style.cssText=r=""),r)for(t in r)n&&t in n||ve(e.style,t,"");if(n)for(t in n)r&&n[t]==r[t]||ve(e.style,t,n[t])}else if(t[0]=="o"&&t[1]=="n")(e.__e||(e.__e={}))[t]=n,n&&r||(i=se[t]||(se[t]=ot(t)),(e.__a||(e.__a={}))[t]=ie,o=t!=(t=t.replace(ke,"$1")),(t=t.slice(2))[0]<"a"&&(t=t.toLowerCase()),n?e.addEventListener(t,i,o):e.removeEventListener(t,i,o));else{if(l=="http://www.w3.org/2000/svg")t=t.replace(/xlink(H|:h)/,"h").replace(/sName$/,"s");else if(t!="width"&&t!="height"&&t!="href"&&t!="list"&&t!="form"&&t!="tabIndex"&&t!="download"&&t!="rowSpan"&&t!="colSpan"&&t!="role"&&t!="popover"&&t in e)try{e[t]=n??"";break e}catch{}typeof n=="function"||(n==null||n===!1&&t[4]!="-"?e.removeAttribute(t):e.setAttribute(t,t=="popover"&&n==1?"":n))}}function ot(e){return function(t){if(this.__e){var n=this.__e[e];if(t[Y]==null)t[Y]=ie++;else if(t[Y]<this.__a[e])return;return n(v.event?v.event(t):t)}}}function le(e,t,n,r,l,o,i,c,f,_){var p,g,b,m,h,a,x,k,u,d,y,w,S,$,V,q,O,G,z,E,N=t.type;if(t.constructor!==void 0)return null;if(128&n.__u&&(f=32&n.__u,p=n.__c.__z)){if(t.__u|=f,g=o=[],p.nodeType==8)for(b=1,m=p.nextSibling;m;m=m.nextSibling){if(m.nodeType==8){if(m.data.startsWith("$s"))b++;else if(m.data.startsWith("/$s")&&!--b)break}o.push(m)}else o.push(p);c=o[0]}(p=v.__b)&&p(t);e:if(typeof N=="function"){h=i.length;try{if(d=t.props,y=(p=N.prototype)&&p.render,w=(p=N.contextType)&&r[p.__c],S=p?w?w.props.value:p.__:r,n.__c?2&(a=t.__c=n.__c).__g&&(a.__g|=1):(y?t.__c=a=new N(d,S):(t.__c=a=new K(d,S),a.constructor=N,a.render=st),w&&w.sub(a),a.state||(a.state={}),a.__n=r,a.__g|=8,a.__h=[],a.__k=[]),y&&(a.__s||(a.__s=a.state),N.getDerivedStateFromProps&&(a.__s==a.state&&(a.__s=D({},a.__s)),D(a.__s,N.getDerivedStateFromProps(d,a.__s)))),x=a.props,k=a.state,a.__v=t,n.__c){if(y&&!N.getDerivedStateFromProps&&d!==x&&a.componentWillReceiveProps&&a.componentWillReceiveProps(d,S),t.__v==n.__v&&!(8&a.__g)||!(4&a.__g)&&a.shouldComponentUpdate&&a.shouldComponentUpdate(d,a.__s,S)===!1){t.__v!=n.__v&&(a.props=d,a.state=a.__s,a.__g&=-9),t.__e=n.__e,t.__k=n.__k,t.__k.some(function(P){P&&(P.__=t)}),ee.push.apply(a.__h,a.__k),a.__k=[],a.__h.length&&i.push(a),c=U(n);break e}a.componentWillUpdate&&a.componentWillUpdate(d,a.__s,S),y&&a.componentDidUpdate&&a.__h.push(function(){a.componentDidUpdate(x,k,u)})}else y&&!N.getDerivedStateFromProps&&a.componentWillMount&&a.componentWillMount(),y&&a.componentDidMount&&a.__h.push(a.componentDidMount);if(a.context=S,a.props=d,a.__P=e,a.__g&=-5,$=v.__r,V=0,y)a.state=a.__s,a.__g&=-9,$&&$(t),p=a.render(a.props,a.state,a.context),ee.push.apply(a.__h,a.__k),a.__k=[];else do a.__g&=-9,$&&$(t),p=a.render(a.props,a.state,a.context),a.state=a.__s;while(8&a.__g&&++V<25);a.state=a.__s,a.getChildContext&&(r=D({},r,a.getChildContext())),y&&n.__c&&a.getSnapshotBeforeUpdate&&(u=a.getSnapshotBeforeUpdate(x,k)),q=p&&p.type===R&&p.key==null?p.props.children:p,d.__P&&(p=c,l=(e=d.__P).namespaceURI,f=o=null,n.props&&n.props.__P!=e&&(n.__k.some(function(P){P&&ce(P,P)}),n.__k=null),c=n.__k?U(n,0):null),c=Fe(e,ae(q)?q:[q],t,n,r,l,o,i,c,f,_),d.__P&&(t.__e=null,c=p),t.__u&=-161,128&n.__u&&(a.__z=null),g&&g.some(te),a.__h.length&&i.push(a),1&a.__g&&(a.__g&=-4)}catch(P){if(i.length=h,t.__v=null,f||o)if(P.then){if(O=0,t.__u|=f?160:128,o){for(~(z=o.indexOf(c||void 0))||(z=o.length);(E=o[z-1])&&E.nodeType==8;)z--;for(;z<o.length;z++)if(E=o[z]){if(o[z]=null,E.nodeType==8){if(E.data.startsWith("$s"))O++||(G=E);else if(O&&E.data.startsWith("/$s")&&!--O){c=E;break}}else if(!O)break}}if(!G){for(;c&&c.nodeType==8&&c.nextSibling;)c=c.nextSibling;G=c}t.__c.__z||(t.__c.__z=G),t.__e=c}else o&&o.some(te);else t.__e=n.__e;t.__k||(t.__k=n.__k||[]),P.then||Pe(t),v.__e(P,t,n)}}else c=t.__e=rt(n.__e,t,n,r,l,o,i,f,_,e);return(p=v.diffed)&&p(t),128&t.__u?void 0:c}function Pe(e){e&&(e.__c&&(e.__c.__g|=4),e.__k&&e.__k.some(Pe))}function $e(e,t,n){for(var r=0;r<n.length;)pe(n[r++],n[r++],n[r++]);v.__c&&v.__c(t,e),e.some(function(l){try{e=l.__h,l.__h=[],e.some(function(o){o.call(l)})}catch(o){v.__e(o,l.__v)}})}function rt(e,t,n,r,l,o,i,c,f,_){var p,g,b,m,h,a,x,k,u,d=n.props||X,y=t.props,w=t.type;if(w=="svg"?l="http://www.w3.org/2000/svg":w=="math"?l="http://www.w3.org/1998/Math/MathML":l||(l="http://www.w3.org/1999/xhtml"),o){for(p=0;p<o.length;p++)if((h=o[p])&&(w?h.localName==w:h.nodeType==3)){e=h,o[p]=null;break}}if(!e){if(k=_.ownerDocument||document,!w)return k.createTextNode(y);e=k.createElementNS(l,w,y.is&&y),c&&(v.__m&&v.__m(t,o),c=!1),o=null}if(w){if(_=w=="template"?e.content:e,o=w=="textarea"&&y.defaultValue!=null?null:o&&Me.call(_.childNodes),!c&&o)for(d={},p=0;p<e.attributes.length;p++)d[(h=e.attributes[p]).name]=h.value;for(p in d)h=d[p],p=="dangerouslySetInnerHTML"?b=h:p=="children"||p in y||p=="value"&&"defaultValue"in y||p=="checked"&&"defaultChecked"in y||J(e,p,null,h,l);for(p in u=1&n.__u,y)h=y[p],p=="children"?m=h:p=="dangerouslySetInnerHTML"?g=h:p=="value"?a=h:p=="checked"?x=h:c&&typeof h!="function"||!(d[p]!==h||u&&h!=null)||J(e,p,h,d[p],l);g?(c||b&&(g.__html==b.__html||g.__html==e.innerHTML)||(e.innerHTML=g.__html),t.__k=[]):(b&&(e.textContent=""),(w=="foreignObject"||l=="http://www.w3.org/1998/Math/MathML"&&Xe.test(w))&&(l="http://www.w3.org/1999/xhtml"),Fe(_,ae(m)?m:[m],t,n,r,l,o,i,o?o[0]:n.__k&&U(n,0),c,f),o&&o.some(te)),c&&w!="textarea"||(p="value",w=="progress"&&a==null?e.removeAttribute(p):a==null||a===e[p]&&(w!="progress"||a)||J(e,p,a,d[p],l),p="checked",x!=null&&x!=e[p]&&J(e,p,x,d[p],l))}else d===y||c&&e.data==y||(e.data=y);return e}function pe(e,t,n,r){try{typeof e=="function"?t?t.__x=e(t)||1:r&&(r=r.__c||r.__e)&&(t=r.__x)&&(r.__x=null,typeof t=="function"?t():e(null)):e.current=t}catch(l){v.__e(l,n)}}function ce(e,t,n){var r,l;if(v.unmount&&v.unmount(e),!(r=e.ref)||r.current&&r.current!=e.__e||pe(r,null,t,e),r=e.__c){if(r.componentWillUnmount)try{r.componentWillUnmount()}catch(o){v.__e(o,t)}r.__P=r.__n=null}if(r=e.__k)for(l=0;l<r.length;l++)r[l]&&ce(r[l],t,typeof e.type!="function"||n&&!e.props.__P);(r=e.__e)&&(n||te(r),r.__e&&(r.__e=null)),e.__e=e.__c=e.__=null}function st(e,t,n){return this.constructor(e,n)}function Ne(e,t){var n,r,l,o;v.__&&v.__(e,t),t.nodeType==9&&(t=t.documentElement),r=(n=e&&32&e.__u)?null:t.__k,t.__k=Z(R,{children:[e]}),l=[],o=[],le(t,t.__k,r||X,X,t.namespaceURI,r?null:t.firstChild?Me.call(t.childNodes):null,l,r?r.__e:t.firstChild,n,o),$e(l,t.__k,o),t.__k.props.children=null}v={__e:function(e,t,n,r){for(var l,o,i;t=t.__;)if((l=t.__c)&&!(1&l.__g)){l.__g|=4;try{if((o=l.constructor)&&o.getDerivedStateFromError&&(l.setState(o.getDerivedStateFromError(e)),i=8&l.__g),l.componentDidCatch&&(l.componentDidCatch(e,r||{}),i=8&l.__g),i)return void(l.__g|=2)}catch(c){e=c,i=0}}throw Q=0,e}},xe=0,Ke=function(e){return e!=null&&e.constructor===void 0},K.prototype.setState=function(e,t){var n=this.__s;n&&n!=this.state||(n=this.__s=D({},this.state)),typeof e=="function"&&(e=e(D({},n),this.props)),e&&(D(n,e),this.__v&&(t&&this.__k.push(t),ye(this)))},K.prototype.forceUpdate=function(e){this.__v&&(this.__g|=4,e&&this.__h.push(e),ye(this))},K.prototype.render=R,L=[],Q=0,we=function(e,t){return e.__v.__b-t.__v.__b},Y=Symbol(),ke=/(PointerCapture)$|Capture$/i,ie=0,se={},Qe=0;var j,C,ue,Te,fe=Object.is,ne=0,De=[],_e=[],M=v,Ae=M.__b,ze=M.__r,Ee=M.diffed,Le=M.__c,Ue=M.unmount,Re=M.__;function me(e,t){M.__h&&M.__h(C,e,ne||t),ne=0;var n=C.__H||(C.__H={__:[],__h:[]});return e>=n.__.length&&n.__.push({}),n.__[e]}function H(e){return ne=1,it(je,e)}function it(e,t,n){var r=me(j++,2);if(r.t=e,!r.__c&&(r.__=[n?n(t):je(void 0,t),function(o){var i=r.__N?r.__N[0]:r.__[0],c=r.t(i,o);fe(i,c)||(r.__N=[c,r.__[1]],r.__c.setState({}))}],r.__c=C,!C.__f)){C.__f=!0;var l=C.shouldComponentUpdate;C.shouldComponentUpdate=function(o,i,c){var f=this.__H;if(!f)return!0;var _=!1,p=this.props!=o;if(f.__.some(function(b){b.__N&&(_=!0,fe(b.__[0],b.__N[0])||(p=!0))}),l){var g=l.call(this,o,i,c);return _?g||p:g}return!_||p}}return r.__}function he(e,t){var n=me(j++,3);!M.__s&&We(n.__H,t)&&(n.__P=!0,n.__=e,n.u=t,C.__H.__h.push(n))}function Oe(e){return ne=5,oe(function(){return{current:e}},[])}function oe(e,t){var n=me(j++,7);return We(n.__H,t)&&(n.__=e(),n.__H=t),n.__}function at(){var e;do{for(;e=_e.shift();)try{W(e)}catch(n){M.__e(n,{__:(e=e.__P)&&e.__v})}for(;e=De.shift();){var t=e.__H;if(e.__P&&t)try{t.__h.some(W),t.__h.some(de),t.__h=[]}catch(n){t.__h=[],M.__e(n,e.__v)}}}while(_e.length)}M.__b=function(e){C=null,Ae&&Ae(e)},M.__=function(e,t){e&&t.__k&&t.__k.__m&&(e.__m=t.__k.__m),Re&&Re(e,t)},M.__r=function(e){ze&&ze(e),j=0;var t=(C=e.__c).__H;t&&(ue==C?C.__h=[]:(t.__h.some(W),t.__h.some(de),j=0),t.__h=[],t.__.some(function(n){n.__N&&(n.__=n.__N),n.u=n.__N=void 0})),ue=C},M.diffed=function(e){Ee&&Ee(e);var t=e.__c;t&&t.__H&&(t.__H.__h.length&&Ie(De.push(t)),t.__H.__.some(function(n){n.u&&(n.__H=n.u)})),ue=C=null},M.__c=function(e,t){t.some(function(n){try{n.__h.some(W),n.__h=n.__h.filter(function(r){return!r.__||de(r)})}catch(r){t.some(function(l){l.__h&&(l.__h=[])}),t=[],M.__e(r,n.__v)}}),Le&&Le(e,t)},M.unmount=function(e){Ue&&Ue(e);var t,n,r=e.__c;r&&r.__H&&(r.__H.__.some(function(l){try{if(l.__P&&l.__c){if(n===void 0){for(n=e.__;n&&(!n.__c||!n.__c.__P);)n=n.__;n=n&&n.__c}l.__P=n,Ie(_e.push(l))}else W(l)}catch(o){t=o}}),r.__H=void 0,t&&M.__e(t,r.__v))};var He=typeof requestAnimationFrame=="function";function lt(e){var t,n=function(){clearTimeout(r),He&&cancelAnimationFrame(t),setTimeout(e)},r=setTimeout(n,35);He&&(t=requestAnimationFrame(n))}function Ie(e){e!=1&&Te==M.requestAnimationFrame||((Te=M.requestAnimationFrame)||lt)(at)}function W(e){var t=C,n=e.__c;typeof n=="function"&&(e.__c=void 0,n()),C=t}function de(e){var t=C;e.__c=e.__(),C=t}function We(e,t){return!e||e.length!=t.length||t.some(function(n,r){return!fe(n,e[r])})}function je(e,t){return typeof t=="function"?t(e):t}var T={user:"your code",deps:"dependencies",node:"Node.js internals",native:"native / V8 builtins",gc:"garbage collection",program:"(program) unattributed native",idle:"idle",wait:"waiting on child processes",root:"root"};function I(e,t){return t>0?e/t*100:0}function F(e){return Number.isFinite(e)?e>=1e4?`${(e/1e3).toFixed(1)} s`:e>=1e3?`${(e/1e3).toFixed(2)} s`:e>=100?`${e.toFixed(0)} ms`:e>=10?`${e.toFixed(1)} ms`:`${e.toFixed(2)} ms`:"\\u2013"}function A(e){return e>=9.95?`${e.toFixed(0)}%`:`${e.toFixed(1)}%`}var pt=0;function s(e,t,n,r,l,o){t||(t={});var i,c,f=t;if("ref"in f&&typeof e!="function")for(c in f={},t)c=="ref"?i=t[c]:f[c]=t[c];var _={type:e,props:f,key:n,ref:i,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:--pt,__i:-1,__u:0};return(l||o)&&(_.__source=l,_.__self=o),v.vnode&&v.vnode(_),_}var Be=22,ct=2500,ut={user:[14,26,82,50],deps:[262,22,60,58],node:[190,20,70,36],native:[30,8,8,46],gc:[44,6,90,48],program:[30,6,6,60],idle:[210,6,20,80],wait:[215,8,25,70],root:[30,0,6,30]};function ft(e){let t=2166136261;for(let n=0;n<e.length;n++)t=Math.imul(t^e.charCodeAt(n),16777619);return(t>>>0)/4294967296}function _t(e){let[t,n,r,l]=ut[e.category],o=ft(e.name+(e.file??""));return`hsl(${(t+(o-.5)*n).toFixed(0)} ${r}% ${(l+(o-.5)*8).toFixed(0)}%)`}var dt=new Set(["gc","program","idle","wait"]);function mt(e,t,n){let r=[],l=e.totalMs>0?n/e.totalMs:0,o=[{node:e,path:[...t,e],x:0,w:n,depth:0}];for(;o.length&&r.length<ct;){let i=o.pop();r.push(i);let c=i.x,f=[];for(let _ of i.node.children??[]){let p=_.totalMs*l;p>=2&&f.push({node:_,path:[...i.path,_],x:c,w:p,depth:i.depth+1}),c+=p}for(let _=f.length-1;_>=0;_--)o.push(f[_])}return r}function ht(e,t){return e.name.toLowerCase().includes(t)||(e.file??"").toLowerCase().includes(t)}function Ve({root:e}){let t=e.totalMs,n=Oe(null),[r,l]=H(800),[o,i]=H([e]),[c,f]=H(""),[_,p]=H(null);he(()=>i([e]),[e]),he(()=>{let u=n.current;if(!u)return;let d=()=>l(Math.max(200,u.clientWidth));d();let y=new ResizeObserver(d);return y.observe(u),()=>y.disconnect()},[]);let g=o[o.length-1],b=oe(()=>mt(g,o.slice(0,-1),r),[g,r,o]),m=b.reduce((u,d)=>Math.max(u,d.depth),0),h=c.trim().toLowerCase(),a=oe(()=>{if(!h)return null;let u=new Set,d=0,y=(w,S)=>{let $=ht(w,h);$&&u.add(w),$&&!S&&(d+=w.totalMs);for(let V of w.children??[])y(V,S||$)};return y(g,!1),{hit:u,total:d}},[h,g]),x=_??g,k=()=>i(u=>u.length>1?u.slice(0,-1):u);return s("div",{onKeyDown:u=>{u.key==="Escape"&&k()},children:[s("div",{class:"pp-flame-bar",children:[s("label",{class:"pp-sr",for:"pp-flame-search",children:"Search functions or files"}),s("input",{id:"pp-flame-search",type:"search",placeholder:"Search functions or files\\u2026",value:c,onInput:u=>f(u.currentTarget.value)}),o.length>1&&s("button",{type:"button",class:"pp-btn",onClick:()=>i([e]),children:"Reset zoom"})]}),s("div",{class:"pp-crumbs","aria-label":"Zoom path",children:o.length>1?o.map((u,d)=>s("span",{children:[d>0&&" \\u203A ",d<o.length-1?s("button",{type:"button",onClick:()=>i(o.slice(0,d+1)),children:u.name}):s("b",{children:u.name})]},d)):s("span",{children:"Click a frame to zoom in. Esc zooms out. Width is total time, top-down by call."})}),s("div",{ref:n,class:"pp-flame",style:{height:`${(m+1)*Be}px`},role:"group","aria-label":"Flame graph","data-testid":"flame",children:b.map(u=>{let d=a?!a.hit.has(u.node):!1,y=`${u.node.name}${u.node.file?` (${u.node.file}:${u.node.line})`:""}: ${F(u.node.totalMs)} total, ${F(u.node.selfMs)} self`;return s("button",{type:"button",class:`${d?"is-dim":""} ${dt.has(u.node.category)?"is-light":""}`,style:{left:`${u.x}px`,top:`${u.depth*Be}px`,width:`${u.w}px`,background:_t(u.node)},title:y,"aria-label":y,onClick:()=>i(u.path.length>1&&u.node===g?o.slice(0,-1):u.path),onMouseEnter:()=>p(u.node),onMouseLeave:()=>p(null),onFocus:()=>p(u.node),onBlur:()=>p(null),children:u.w>30?u.node.name:""},u.path.length+":"+u.x)})}),s("div",{class:"pp-detail","aria-live":"polite",children:a?s("span",{children:["\\u201C",c.trim(),"\\u201D matches ",s("b",{children:a.hit.size})," frames: ",s("b",{children:F(a.total)})," (",A(t>0?a.total/t*100:0)," of sampled time)"]}):s("span",{children:[s("code",{children:x.name}),x.file&&s(R,{children:[" ","in ",s("code",{children:`${x.file}:${x.line}`})]})," \\xB7 ","total ",s("b",{children:F(x.totalMs)})," (",A(t>0?x.totalMs/t*100:0),") \\xB7 self ",s("b",{children:F(x.selfMs)})," \\xB7"," ",T[x.category]]})})]})}var ge={user:"var(--c-user)",deps:"var(--c-deps)",node:"var(--c-node)",native:"var(--c-native)",gc:"var(--c-gc)",program:"var(--c-program)",idle:"var(--c-idle)",wait:"var(--c-wait)",root:"var(--c-program)"};function Ge({analysis:e}){let t=e.categories.filter(n=>n.category!=="idle"&&n.category!=="wait");return s("div",{class:"pp-report",children:[s("section",{class:"pp-card","aria-label":"Summary",children:s("div",{class:"pp-head",children:[e.command&&s("p",{class:"pp-cmd",children:["$ ",e.command]}),e.wallMs!==void 0&&s(B,{label:"Wall clock",value:F(e.wallMs)}),s(B,{label:"CPU time",value:F(e.cpuMs)}),s(B,{label:e.processes.length===1?"Process":"Processes",value:String(e.processes.length)}),qe(e)!==null&&s(B,{label:"In your code",value:A(qe(e))}),e.exitCode!==void 0&&e.exitCode!==null&&e.exitCode!==0&&s(B,{label:"Exit code",value:String(e.exitCode)})]})}),s("section",{class:"pp-card","aria-labelledby":"pp-where",children:[s("h2",{id:"pp-where",children:"Where the CPU time goes"}),s("div",{class:"pp-stack",role:"img","aria-label":t.map(n=>`${T[n.category]} ${A(I(n.ms,e.cpuMs))}`).join(", "),children:t.map(n=>s("div",{style:{width:`${I(n.ms,e.cpuMs)}%`,background:ge[n.category]},title:`${T[n.category]}: ${F(n.ms)}`},n.category))}),s("div",{class:"pp-legend",children:t.filter(n=>I(n.ms,e.cpuMs)>=.5).map(n=>s("span",{children:[s("i",{style:{background:ge[n.category]}}),T[n.category]," ",s("em",{children:A(I(n.ms,e.cpuMs))})]},n.category))})]}),s("section",{class:"pp-card","aria-labelledby":"pp-hot",children:[s("h2",{id:"pp-hot",children:"Hot lines \\xB7 self time"}),e.lines.length?s(gt,{lines:e.lines.slice(0,10),cpuMs:e.cpuMs}):s("p",{class:"pp-empty",children:"No JavaScript lines were sampled."})]}),e.hints.length>0&&s("section",{class:"pp-card","aria-labelledby":"pp-notes",children:[s("h2",{id:"pp-notes",children:"Notes"}),s("ul",{class:"pp-notes",children:e.hints.map(n=>s("li",{children:n},n))})]}),s("section",{class:"pp-card","aria-labelledby":"pp-flame-title",children:[s("h2",{id:"pp-flame-title",children:"Flame graph"}),s(Ve,{root:e.flame})]}),s("section",{class:"pp-card","aria-labelledby":"pp-fns",children:[s("h2",{id:"pp-fns",children:"Hot functions"}),s(bt,{fns:e.functions.slice(0,20),cpuMs:e.cpuMs})]}),e.processes.length>1&&s("section",{class:"pp-card","aria-labelledby":"pp-procs",children:[s("h2",{id:"pp-procs",children:"Processes"}),s("div",{class:"pp-table-wrap",children:s("table",{class:"pp-table",children:[s("thead",{children:s("tr",{children:[s("th",{children:"Process"}),s("th",{children:"Main script"}),s("th",{class:"num",children:"CPU"}),s("th",{class:"num",children:"Waiting on children"})]})}),s("tbody",{children:[...e.processes].sort((n,r)=>r.cpuMs-n.cpuMs).map(n=>s("tr",{children:[s("td",{class:"mono",children:n.name}),s("td",{children:s("code",{children:n.label})}),s("td",{class:"num",children:F(n.cpuMs)}),s("td",{class:"num",children:n.waitMs>1?F(n.waitMs):"\\u2013"})]},n.name))})]})})]})]})}function qe(e){let t=e.categories.find(n=>n.category==="user");return t?I(t.ms,e.cpuMs):null}function B({label:e,value:t}){return s("div",{class:"pp-stat",children:[s("b",{children:t}),s("span",{children:e})]})}function gt({lines:e,cpuMs:t}){let[n,r]=H(e[0]?.snippet?0:null),l=e[0]?.selfMs??1;return s("ol",{class:"pp-lines",children:e.map((o,i)=>{let c=!!(o.snippet||o.hint),f=n===i&&c;return s("li",{class:"pp-line",children:[s("button",{type:"button","aria-expanded":c?f:void 0,onClick:()=>c&&r(f?null:i),style:{cursor:c?"pointer":"default"},children:[s("span",{class:"pp-rank",children:i+1}),s("span",{class:"pp-where",children:[s("code",{children:[o.file,":",o.line]}),o.category!=="user"&&s("span",{class:"pp-tag",children:T[o.category]}),s("small",{children:["in ",s("code",{children:o.fn}),c&&!f?" \\xB7 show code":""]})]}),s("span",{class:"pp-amount",children:[s("b",{children:A(I(o.selfMs,t))}),s("small",{children:F(o.selfMs)})]}),s("span",{class:"pp-meter",style:{width:`${o.selfMs/l*100}%`}})]}),f&&o.snippet&&s("pre",{class:"pp-snippet",children:o.snippet.code.map((_,p)=>{let g=o.snippet.start+p;return s("div",{class:g===o.line?"is-hot":"",children:[s("span",{children:g}),_]},g)})}),f&&o.hint&&s("p",{class:"pp-hint",children:[s("b",{children:"Hint:"})," ",o.hint]})]},`${o.url}:${o.line}`)})})}function bt({fns:e,cpuMs:t}){let[n,r]=H("self"),l=[...e].sort((i,c)=>n==="self"?c.selfMs-i.selfMs:c.totalMs-i.totalMs),o=(i,c)=>s("button",{type:"button",onClick:()=>r(i),"aria-pressed":n===i,children:[c,n===i?" \\u2193":""]});return s("div",{class:"pp-table-wrap",children:s("table",{class:"pp-table",children:[s("thead",{children:s("tr",{children:[s("th",{children:"Function"}),s("th",{class:"num",children:o("self","Self")}),s("th",{class:"num",children:o("total","Total")})]})}),s("tbody",{children:l.map(i=>s("tr",{children:[s("td",{children:[s("span",{class:"pp-dot",style:{background:ge[i.category]}}),s("code",{class:"pp-fn",children:i.name.length>80?`${i.name.slice(0,77)}\\u2026`:i.name}),s("small",{class:"pp-loc",children:i.file?`${i.file}:${i.line}`:T[i.category]})]}),s("td",{class:"num",children:[F(i.selfMs),s("small",{class:"pp-loc",children:A(I(i.selfMs,t))})]}),s("td",{class:"num",children:F(i.totalMs)})]},`${i.url}:${i.line}:${i.name}`))})]})})}var Je=`\n.pp {\n  --bg: #fbfaf7; --panel: #ffffff; --ink: #17140f; --muted: #6b665c; --line: #e6e1d6;\n  --soft: #f3f0e8; --hot: #e5470f; --hot-soft: #fde6dc; --ok: #0f8a5f; --warn: #b7791f;\n  --c-user: #e5470f; --c-deps: #8b5cf6; --c-node: #0e7490; --c-native: #78716c;\n  --c-gc: #ca8a04; --c-program: #a8a29e; --c-wait: #cbd5e1; --c-idle: #e2e8f0;\n  --mono: \'JetBrains Mono\', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  --sans: Inter, ui-sans-serif, system-ui, -apple-system, \'Segoe UI\', sans-serif;\n  color: var(--ink); background: var(--bg); font: 15px/1.5 var(--sans);\n}\n@media (prefers-color-scheme: dark) {\n  .pp:not([data-theme=\'light\']) {\n    --bg: #12110f; --panel: #1b1a17; --ink: #f2efe8; --muted: #a39e93; --line: #2f2c27;\n    --soft: #23211d; --hot: #ff6a33; --hot-soft: #3a1f14; --ok: #34d399; --warn: #fbbf24;\n    --c-native: #a8a29e; --c-program: #57534e; --c-wait: #334155; --c-idle: #1e293b;\n  }\n}\n.pp[data-theme=\'dark\'] {\n  --bg: #12110f; --panel: #1b1a17; --ink: #f2efe8; --muted: #a39e93; --line: #2f2c27;\n  --soft: #23211d; --hot: #ff6a33; --hot-soft: #3a1f14; --ok: #34d399; --warn: #fbbf24;\n  --c-native: #a8a29e; --c-program: #57534e; --c-wait: #334155; --c-idle: #1e293b;\n}\n.pp * { box-sizing: border-box; }\n.pp-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }\n.pp code, .pp pre, .pp .mono { font-family: var(--mono); font-variant-ligatures: none; }\n.pp-report { display: grid; gap: 20px; }\n.pp-card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px; min-width: 0; }\n.pp-card h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 0 0 12px; font-weight: 600; }\n.pp-head { display: flex; flex-wrap: wrap; gap: 8px 28px; align-items: baseline; }\n.pp-cmd { font-family: var(--mono); font-size: 15px; word-break: break-all; flex: 1 1 100%; margin: 0; font-weight: 600; }\n.pp-stat { display: flex; flex-direction: column; }\n.pp-stat b { font-size: 26px; letter-spacing: -.02em; font-weight: 700; font-variant-numeric: tabular-nums; }\n.pp-stat span { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }\n.pp-stack { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--soft); }\n.pp-stack > div { height: 100%; min-width: 2px; }\n.pp-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 12px; font-size: 13px; }\n.pp-legend span { display: inline-flex; align-items: center; gap: 6px; }\n.pp-legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }\n.pp-legend em { font-style: normal; color: var(--muted); font-variant-numeric: tabular-nums; }\n.pp-lines { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }\n.pp-line { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }\n.pp-line > button { all: unset; box-sizing: border-box; cursor: pointer; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 10px; align-items: center; width: 100%; padding: 10px 12px; position: relative; }\n.pp-line > button:focus-visible { outline: 2px solid var(--hot); outline-offset: -2px; }\n.pp-line > button:hover { background: var(--soft); }\n.pp-rank { font-family: var(--mono); color: var(--muted); font-size: 13px; text-align: right; }\n.pp-where { min-width: 0; }\n.pp-where code { font-size: 14px; font-weight: 600; word-break: break-all; }\n.pp-where small { display: block; color: var(--muted); font-size: 12.5px; }\n.pp-amount { text-align: right; font-variant-numeric: tabular-nums; font-size: 14px; white-space: nowrap; }\n.pp-amount b { display: block; font-size: 16px; }\n.pp-amount small { color: var(--muted); }\n.pp-meter { position: absolute; left: 0; bottom: 0; height: 3px; background: var(--hot); border-radius: 0 2px 2px 0; }\n.pp-snippet { margin: 0; padding: 10px 0; background: var(--soft); border-top: 1px solid var(--line); overflow-x: auto; font-size: 13px; line-height: 1.6; }\n.pp-snippet div { padding: 0 14px; white-space: pre; }\n.pp-snippet .is-hot { background: var(--hot-soft); box-shadow: inset 3px 0 0 var(--hot); }\n.pp-snippet span { color: var(--muted); user-select: none; display: inline-block; min-width: 3.2em; }\n.pp-hint { margin: 0; padding: 10px 14px; font-size: 13.5px; border-top: 1px dashed var(--line); }\n.pp-hint b { color: var(--hot); }\n.pp-tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 99px; background: var(--soft); color: var(--muted); margin-left: 6px; vertical-align: 1px; font-family: var(--sans); font-weight: 500; }\n.pp-table-wrap { overflow-x: auto; }\n.pp-table { width: 100%; border-collapse: collapse; font-size: 14px; }\n.pp-table th { text-align: left; font-weight: 600; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; padding: 6px 10px; border-bottom: 1px solid var(--line); }\n.pp-table td { padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }\n.pp-table td.num, .pp-table th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }\n.pp-table code { font-size: 13px; word-break: break-all; }\n.pp-table button { all: unset; cursor: pointer; color: inherit; }\n.pp-table button:focus-visible { outline: 2px solid var(--hot); }\n.pp-loc { display: block; color: var(--muted); font-size: 12px; font-family: var(--mono); word-break: break-all; margin-left: 16px; }\n.pp-table td.num .pp-loc { margin-left: 0; }\n.pp-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: 1px; }\n.pp-notes { margin: 0; padding-left: 18px; display: grid; gap: 6px; }\n.pp-flame-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }\n.pp-flame-bar input { flex: 1 1 200px; font: inherit; font-size: 14px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }\n.pp-flame-bar input:focus { outline: 2px solid var(--hot); outline-offset: -1px; }\n.pp-btn { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; }\n.pp-btn:hover { background: var(--soft); }\n.pp-btn:focus-visible { outline: 2px solid var(--hot); }\n.pp-crumbs { font-size: 13px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-bottom: 8px; min-height: 20px; }\n.pp-crumbs button { all: unset; cursor: pointer; color: var(--ink); text-decoration: underline; text-underline-offset: 2px; }\n.pp-flame { position: relative; overflow: hidden; border-radius: 8px; background: var(--soft); }\n.pp-flame button { all: unset; box-sizing: border-box; position: absolute; height: 21px; font: 11.5px/21px var(--mono); padding: 0 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff; cursor: pointer; border-right: 1px solid var(--soft); border-bottom: 1px solid var(--soft); }\n.pp-flame button:hover, .pp-flame button:focus-visible { filter: brightness(1.15); outline: 2px solid var(--ink); outline-offset: -2px; z-index: 1; }\n.pp-flame button.is-dim { opacity: .25; }\n.pp-flame button.is-light { color: #111; }\n.pp-detail { margin-top: 10px; font-size: 13.5px; min-height: 42px; color: var(--muted); }\n.pp-detail code { color: var(--ink); }\n.pp-detail b { color: var(--ink); font-variant-numeric: tabular-nums; }\n.pp-empty { color: var(--muted); font-size: 14px; }\n@media (max-width: 640px) {\n  .pp-card { padding: 14px; border-radius: 12px; }\n  .pp-stat b { font-size: 21px; }\n  .pp-line > button { grid-template-columns: 22px minmax(0, 1fr) auto; gap: 8px; }\n}\n`;var Ye=document.createElement("style");Ye.textContent=`${Je}\nhtml, body { margin: 0; }\nbody { background: #fbfaf7; }\n@media (prefers-color-scheme: dark) { body { background: #12110f; } }\n.pp-page { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; min-height: 100vh; }\n.pp-brand { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 16px; font-size: 14px; color: var(--muted); }\n.pp-brand b { color: var(--ink); font-size: 17px; letter-spacing: -.01em; }\n.pp-brand a { color: inherit; }`;document.head.appendChild(Ye);var yt=document.getElementById("perfproof-data")?.textContent??"null",re=JSON.parse(yt),Ze=document.getElementById("app");Ze.className="pp";Ne(s("div",{class:"pp-page",children:[s("header",{class:"pp-brand",children:[s("b",{children:"perfproof"}),s("span",{children:[re?.createdAt?new Date(re.createdAt).toLocaleString():""," \\xB7"," ",s("a",{href:"https://github.com/feresbr1/perfproof",children:"github.com/feresbr1/perfproof"})]})]}),re?s(Ge,{analysis:re}):s("p",{children:"This file has no profile data."})]}),Ze);})();\n' : "");
  const title = analysis.command ? `perfproof \xB7 ${analysis.command}` : "perfproof profile";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
<div id="app"></div>
<script id="perfproof-data" type="application/json">${scriptSafeJson(analysis)}</script>
<script>${js.replace(/<\/script/gi, `<${BACKSLASH}/script`)}</script>
</body>
</html>
`;
}

// src/node/profile.ts
import {
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  readdirSync,
  readFileSync as readFileSync2,
  rmSync,
  statSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { join as join2, resolve as resolve2 } from "node:path";

// src/core/hints.ts
var LINE_HINTS = [
  {
    test: /\.(includes|indexOf|lastIndexOf|find|findIndex|findLast|some|every)\(/,
    hint: (m) => `.${m[1]}() scans the whole array. Inside a loop that is O(n\xB2); a Set or Map lookup is O(1).`
  },
  {
    test: /\.filter\([^)]*\)\s*\.length|\.filter\([^)]*\)\[0\]/,
    hint: () => ".filter() builds a new array just to count or take the first item."
  },
  {
    test: /\bnew RegExp\(/,
    hint: () => "A RegExp is compiled on a hot line; build it once outside the loop."
  },
  {
    test: /JSON\.(parse|stringify)\(/,
    hint: (m) => `JSON.${m[1]}() on a hot line: avoid round-tripping (deep copies, cache keys) or cache the result.`
  },
  {
    test: /\b(readFileSync|writeFileSync|existsSync|statSync|readdirSync|execSync|execFileSync|spawnSync)\(/,
    hint: (m) => `${m[1]}() blocks the thread; batch it, cache it, or move it out of the loop.`
  },
  {
    test: /\.sort\(/,
    hint: () => "Sorting on a hot line: if this runs repeatedly, sort once or keep the data ordered."
  },
  {
    test: /\[\s*\.\.\.\w|\{\s*\.\.\.\w|\.concat\(/,
    hint: () => "Spreading or concatenating copies the whole collection each time; in a loop that is O(n\xB2)."
  },
  {
    test: /\bdelete\s+\w+[.[]/,
    hint: () => "`delete` turns objects into slow dictionary mode; set the field to undefined or use a Map."
  },
  {
    test: /\.(shift|unshift|splice)\(/,
    hint: (m) => `.${m[1]}() moves every element; for queues use an index pointer or a ring buffer.`
  },
  {
    test: /\btry\s*\{.*\bcatch\b|\bthrow new\b/,
    hint: () => "Exceptions on a hot path are slow; use return values for expected failures."
  }
];
function lineHint(code2) {
  const text = code2.replace(/\/\/.*$/, "");
  for (const { test, hint } of LINE_HINTS) {
    const m = test.exec(text);
    if (m) return hint(m);
  }
  return void 0;
}

// src/node/profile.ts
function nodeOptionPath(p) {
  return `"${p.replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
}
async function profileCommand(opts) {
  mkdirSync2(opts.dir, { recursive: true });
  const flags = [
    "--cpu-prof",
    `--cpu-prof-dir=${nodeOptionPath(opts.dir)}`,
    `--cpu-prof-interval=${Math.max(50, Math.round(opts.interval))}`
  ];
  const preload = join2(opts.dir, PRELOAD_NAME);
  writeFileSync2(preload, preloadSource(opts.precise));
  flags.push(`--require=${nodeOptionPath(preload)}`);
  const env = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, ...flags].filter(Boolean).join(" ")
  };
  const result = await runCommand(opts.argv, {
    cwd: opts.cwd,
    env,
    output: opts.quiet ? "hide" : "inherit"
  });
  rmSync(preload, { force: true });
  await settle(opts.dir);
  const profiles = [];
  const skipped = [];
  for (const f of readdirSync(opts.dir).filter((f2) => f2.endsWith(".cpuprofile")).sort()) {
    try {
      profiles.push(...readProfiles([join2(opts.dir, f)]));
    } catch {
      skipped.push(f);
    }
  }
  return { ...result, profiles, skipped };
}
async function settle(dir) {
  const snapshot = () => readdirSync(dir).filter((f) => f.endsWith(".cpuprofile")).map((f) => `${f}:${statSync(join2(dir, f)).size}`).sort().join("|");
  let last = snapshot();
  let stable = 0;
  for (let waited = 0; waited < 3e3 && stable < 2; waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
    const now = snapshot();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}
function preloadSource(precise) {
  return `'use strict';
${precise ? "require('node:v8').setFlagsFromString('--no-use-osr');" : ""}
// --cpu-prof writes the profile on a normal exit only. Test runners stop workers with SIGTERM, so
// turn an otherwise unhandled SIGTERM/SIGINT into a normal exit (programs with their own handlers
// keep them).
if (require('node:worker_threads').isMainThread) {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    process.on(signal, () => {
      if (process.listenerCount(signal) === 1) process.exit(code);
    });
  }
}
`;
}
function readProfiles(paths) {
  const files = [];
  for (const p of paths) {
    if (!existsSync2(p)) throw new ProfileError(`Not found: ${p}`);
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (f.endsWith(".cpuprofile")) files.push(join2(p, f));
      }
    } else {
      files.push(p);
    }
  }
  return files.map((file) => {
    try {
      return { name: profileName(file), profile: parseCpuProfile(readFileSync2(file, "utf8")) };
    } catch (err) {
      throw new ProfileError(`${file}: ${err.message}`);
    }
  });
}
function profileName(file) {
  const base = file.split(/[\\/]/).pop();
  const m = /^CPU\.\d+\.\d+\.(\d+)\.(\d+)\.\d+\.cpuprofile$/.exec(base);
  if (m) return m[2] === "0" ? `pid ${m[1]}` : `pid ${m[1]}/${m[2]}`;
  return base.replace(/\.cpuprofile$/, "");
}
function analyzeWithSource(profiles, opts) {
  const cache = /* @__PURE__ */ new Map();
  const source = (url) => {
    if (!cache.has(url)) {
      const file = fileFromUrl(url);
      let lines = null;
      if (file && !/[\\/]node_modules[\\/]/.test(file)) {
        try {
          lines = readFileSync2(file, "utf8").split(/\r?\n/);
        } catch {
          lines = null;
        }
      }
      cache.set(url, lines);
    }
    return cache.get(url);
  };
  const analysis = analyzeProfiles(profiles, { ...opts, source });
  for (const ls of analysis.lines.slice(0, 20)) {
    if (ls.category !== "user") continue;
    const src = source(ls.url);
    if (!src || ls.line < 1 || ls.line > src.length) continue;
    const start = Math.max(1, ls.line - 2);
    const end = Math.min(src.length, ls.line + 2);
    ls.snippet = {
      start,
      code: src.slice(start - 1, end).map((l) => l.length > 160 ? `${l.slice(0, 157)}...` : l)
    };
    ls.hint = lineHint(src[ls.line - 1]);
  }
  return analysis;
}
function newRunDir(cwd) {
  const base = resolve2(cwd, ".perfproof");
  mkdirSync2(base, { recursive: true });
  const ignore = join2(base, ".gitignore");
  if (!existsSync2(ignore)) writeFileSync2(ignore, "*\n");
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  let dir = join2(base, "runs", stamp);
  for (let i = 2; existsSync2(dir); i++) dir = join2(base, "runs", `${stamp}-${i}`);
  mkdirSync2(dir, { recursive: true });
  return dir;
}

// src/cli/main.ts
var VERSION = true ? "1.0.1" : "0.0.0-dev";
var HELP = `perfproof ${VERSION}: find out why Node.js code is slow, and prove a fix made it faster.

Usage
  perfproof run [options] -- <command...>      Profile a command and every Node.js process it starts
  perfproof bench [options] -- <command...>    Time a command, save a baseline, compare against it
  perfproof analyze <file|dir>... [options]    Report on existing .cpuprofile files
  perfproof guide                              The workflow, written for coding agents

run / analyze options
  --top <n>          Hot lines and functions to show (default 8)
  --json             Print the full report as JSON
  --md               Print the report as Markdown
  --html <file>      (analyze) Also write a flame graph HTML file
  --interval <us>    (run) Sampling interval in microseconds (default 500)
  --no-precise       (run) Keep V8's on-stack replacement (faster, less exact line attribution)
  -q, --quiet        (run) Hide the command's own output
  --no-save          (run) Do not keep the run in .perfproof/runs/
  --open             Open the flame graph in a browser

bench options
  -n, --runs <n>     Timed runs (default 10)
  -w, --warmup <n>   Untimed warm-up runs (default 1)
  --save [name]      Save the timings as a baseline (default name: baseline)
  --compare [name]   Compare against a saved baseline (Welch's t-test)
  --fail-if-slower   Exit with code 1 when significantly slower than the baseline
  --show-output      Show the command's output
  --json, --md       Machine-readable output

Examples
  perfproof run -- node scripts/build.js
  perfproof run -- npm test
  perfproof bench --save before -- node scripts/build.js
  # ...change the code...
  perfproof bench --compare before -- node scripts/build.js

Docs: https://github.com/feresbr1/perfproof
`;
var UsageError = class extends Error {
  name = "UsageError";
};
var VALUE_FLAGS = /* @__PURE__ */ new Set(["--top", "--interval", "--html", "-n", "--runs", "-w", "--warmup"]);
var OPTIONAL_VALUE_FLAGS = /* @__PURE__ */ new Set(["--save", "--compare"]);
var BOOLEAN_FLAGS = /* @__PURE__ */ new Set([
  "--json",
  "--md",
  "--no-precise",
  "-q",
  "--quiet",
  "--no-save",
  "--open",
  "--fail-if-slower",
  "--show-output",
  "-h",
  "--help",
  "-v",
  "--version"
]);
function parseArgs(argv) {
  const flags = /* @__PURE__ */ new Map();
  const positionals = [];
  let command = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      command = argv.slice(i + 1);
      break;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === void 0 || value === "--") throw new UsageError(`${name} needs a value.`);
      flags.set(name, value);
    } else if (OPTIONAL_VALUE_FLAGS.has(name)) {
      if (eq > 0) flags.set(name, arg.slice(eq + 1));
      else if (argv[i + 1] !== void 0 && !argv[i + 1].startsWith("-"))
        flags.set(name, argv[++i]);
      else flags.set(name, true);
    } else if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
    } else if (arg.startsWith("-") && arg.length > 1) {
      throw new UsageError(`Unknown option: ${arg}. Put the command to run after "--".`);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals, command };
}
function intFlag(p, names, fallback, min) {
  for (const n of names) {
    const v = p.flags.get(n);
    if (typeof v === "string") {
      const x = Number(v);
      if (!Number.isInteger(x) || x < min)
        throw new UsageError(`${n} must be a whole number \u2265 ${min}.`);
      return x;
    }
  }
  return fallback;
}
async function main(argv, io) {
  try {
    return await dispatch(argv, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`perfproof: ${err.message}
Run "perfproof --help" for usage.
`);
      return 2;
    }
    if (err instanceof ProfileError || err instanceof BenchError) {
      io.err(`perfproof: ${err.message}
`);
      return 2;
    }
    io.err(`perfproof: ${err.message ?? String(err)}
`);
    return 1;
  }
}
async function dispatch(argv, io) {
  const [sub, ...rest] = argv;
  if (sub === void 0 || sub === "-h" || sub === "--help" || sub === "help") {
    io.out(HELP);
    return 0;
  }
  if (sub === "-v" || sub === "--version") {
    io.out(`${VERSION}
`);
    return 0;
  }
  if (sub === "guide") {
    io.out(true ? "# perfproof: measure, fix, prove\n\nNever guess where time goes. Profile the real workload, fix what the profile shows, and report a\nbenchmark verdict, not an impression.\n\nRun the CLI with `npx -y github:feresbr1/perfproof <command>` (Node.js 22.15+). Below, `perfproof`\nstands for that.\n\n## 1. Find a command that reproduces the slowness\n\nPick the smallest real command that shows the problem: `node scripts/build.js`, `npm test`,\n`npx vitest run some.test.ts`, `node bin/cli.js --flag input.json`. It must be deterministic and take\nroughly 0.2 s to 60 s. If the slow path needs input data, create a realistic input file first.\n\n## 2. Save a baseline before changing anything\n\n```sh\nperfproof bench --save before -- <command>\n```\n\nThis runs the command 1 + 10 times (`-n` to change) and stores the timings in\n`.perfproof/baselines/before.json`. Every run must exit with code 0.\n\n## 3. Profile\n\n```sh\nperfproof run -q -- <command>\n```\n\n`-q` hides the command's own output. The report lists:\n\n- **Where the CPU time goes**: your code vs dependencies vs Node.js internals vs GC.\n- **Hot lines**: file:line, enclosing function, self time and share, the code around it, and a hint\n  when the line matches a known slow pattern. Start here.\n- **Hot functions**: self time (spent in the function itself) and total time (including callees).\n- **Notes**: e.g. heavy GC, time dominated by a dependency, or a mostly idle (I/O-bound) process.\n\nProfiles cover every Node.js process the command starts (npm, test workers, child processes). Add\n`--md` for a Markdown report, `--json` for the full data. A flame graph is saved to\n`.perfproof/runs/<timestamp>/flamegraph.html`.\n\n## 4. Fix the hottest code you own\n\n- Work top-down on the hot lines in **your code**. A hint is a lead, not a diagnosis; read the code.\n- Typical wins: Set/Map instead of `includes`/`indexOf`/`find` in loops, hoisting regexes, caches and\n  invariant work out of loops, avoiding repeated `JSON.parse(JSON.stringify())`, sync I/O in loops,\n  and quadratic spreading/concatenation.\n- If dependencies dominate, look at how often and with what data your code calls them.\n- If CPU time is far below wall time, the program is waiting (network, disk, timers): a CPU profile\n  will not explain that part; say so.\n- Keep behaviour identical. Run the project's tests after the change.\n\n## 5. Prove it\n\n```sh\nperfproof bench --compare before -- <command>\n```\n\nThe verdict line is one of:\n\n- `FASTER: 2.59\xD7 faster than the baseline (-61.4% time, p < 0.0001)`\n- `SLOWER: ...`\n- `NO SIGNIFICANT DIFFERENCE (...)`: treat it as noise; do not claim an improvement.\n\nUse `--fail-if-slower` in scripts to exit with code 1 on a significant slowdown. If runs vary by\nmore than 10% (perfproof prints a note), raise `-n`.\n\n## 6. Report\n\nTell the user: the command measured, what the profile showed (top hot line and its share), what you\nchanged, and the bench verdict line with the numbers. Paste `perfproof bench --compare before --md`\noutput if they want a table. Do not round up or claim speed-ups the verdict does not support.\n\n## Limits\n\n- Node.js only (not Bun or Deno; not browser code, though a Chrome DevTools `.cpuprofile` can be\n  analysed with `perfproof analyze file.cpuprofile`).\n- Line numbers refer to the code Node.js ran. For TypeScript run with Node's built-in type stripping\n  they match the source; for bundled or transpiled output they refer to the generated files.\n- A process only writes its profile when it exits normally. perfproof turns an unhandled\n  SIGTERM/SIGINT into a normal exit, so test-runner workers are captured on Linux and macOS. On\n  Windows, killed workers cannot be captured: run Vitest with `--pool=threads` (worker threads are\n  profiled) or profile a single test file.\n- `run` disables V8 on-stack replacement for accurate line attribution, which can make long loops\n  slightly slower while profiling. Use `bench` (no profiler) for timing claims.\n" : "See skills/perfproof/SKILL.md\n");
    return 0;
  }
  if (sub === "run" || sub === "--") return run(parseArgs(sub === "--" ? argv : rest), io);
  if (sub === "bench") return benchCmd(parseArgs(rest), io);
  if (sub === "analyze") return analyze(parseArgs(rest), io);
  throw new UsageError(
    `Unknown command "${sub}". Did you mean: perfproof run -- ${commandLine(argv)}`
  );
}
function emit(analysis, p, io, savedTo) {
  const top = intFlag(p, ["--top"], 8, 1);
  if (p.flags.has("--json")) io.out(JSON.stringify(analysis, null, 2) + "\n");
  else if (p.flags.has("--md")) io.out(markdownReport(analysis, { top }));
  else io.out(textReport(analysis, { top, savedTo }));
}
async function run(p, io) {
  const argv = p.command.length ? p.command : p.positionals;
  if (!argv.length) throw new UsageError("Nothing to run. Example: perfproof run -- node app.js");
  if (!supportsCpuProfInNodeOptions(process.versions.node)) {
    throw new UsageError(
      `perfproof run needs Node.js 22.15 or newer (this is ${process.version}): older versions do not allow --cpu-prof in NODE_OPTIONS, which is how child processes get profiled.`
    );
  }
  const save = !p.flags.has("--no-save");
  const dir = save ? newRunDir(io.cwd) : mkdtempSync(join3(tmpdir(), "perfproof-"));
  const command = commandLine(argv);
  io.err(`perfproof: profiling ${command}
`);
  try {
    const result = await profileCommand({
      argv,
      cwd: io.cwd,
      dir,
      interval: intFlag(p, ["--interval"], 500, 50),
      precise: !p.flags.has("--no-precise"),
      quiet: p.flags.has("-q") || p.flags.has("--quiet")
    });
    if (result.profiles.length === 0) {
      const failed = result.exitCode !== 0 ? ` The command exited with code ${result.exitCode}.` : "";
      io.err(
        `perfproof: no Node.js process wrote a profile.${failed} perfproof profiles programs run by Node.js 22.15+ (node, npm, npx, test runners); Bun and Deno are not supported.
`
      );
      if (result.tail) io.err(result.tail);
      return 2;
    }
    if (result.skipped.length) {
      io.err(`perfproof: skipped ${result.skipped.length} incomplete profile(s): ${result.skipped.join(", ")}
`);
    }
    const analysis = analyzeWithSource(result.profiles, {
      root: io.cwd,
      command,
      wallMs: result.wallMs,
      exitCode: result.exitCode
    });
    analysis.createdAt = (/* @__PURE__ */ new Date()).toISOString();
    const html = join3(dir, "flamegraph.html");
    if (save) {
      writeFileSync3(join3(dir, "report.json"), JSON.stringify(analysis, null, 2) + "\n");
      writeFileSync3(join3(dir, "report.md"), markdownReport(analysis));
      writeFileSync3(html, analysisToHtml(analysis));
    }
    if (result.exitCode !== 0 && result.tail && !p.flags.has("--json")) {
      io.err(
        `perfproof: the command exited with code ${result.exitCode}. Last output:
${result.tail}
`
      );
    }
    emit(analysis, p, io, save ? relative(io.cwd, dir) || "." : void 0);
    if (p.flags.has("--open")) {
      if (save) openFile(html);
      else io.err("perfproof: --open needs a saved run (drop --no-save).\n");
    }
    return result.exitCode ?? 1;
  } finally {
    if (!save) rmSync2(dir, { recursive: true, force: true });
  }
}
async function analyze(p, io) {
  const paths = [...p.positionals, ...p.command];
  if (!paths.length) throw new UsageError("Give one or more .cpuprofile files or folders.");
  const profiles = readProfiles(paths.map((x) => resolve3(io.cwd, x)));
  if (!profiles.length) throw new ProfileError("No .cpuprofile files found there.");
  const analysis = analyzeWithSource(profiles, { root: io.cwd });
  const html = p.flags.get("--html");
  if (typeof html === "string") {
    const file = resolve3(io.cwd, html);
    writeFileSync3(file, analysisToHtml(analysis));
    io.err(`perfproof: wrote ${html}
`);
    if (p.flags.has("--open")) openFile(file);
  }
  emit(analysis, p, io);
  return 0;
}
async function benchCmd(p, io) {
  const argv = p.command.length ? p.command : p.positionals;
  if (!argv.length)
    throw new UsageError("Nothing to time. Example: perfproof bench -- node app.js");
  const runs = intFlag(p, ["-n", "--runs"], 10, 2);
  const warmup = intFlag(p, ["-w", "--warmup"], 1, 0);
  const saveName = p.flags.get("--save");
  const compareName = p.flags.get("--compare");
  const baseline = compareName === void 0 ? void 0 : {
    // A baseline given as a file path is labelled by its file name: base.json -> "base".
    name: compareName === true ? "baseline" : basename(compareName).replace(/\.json$/, ""),
    result: loadBaseline(io.cwd, compareName === true ? "baseline" : compareName)
  };
  io.err(`perfproof: timing ${commandLine(argv)} (${warmup} warm-up + ${runs} runs)
`);
  const result = await bench({
    argv,
    cwd: io.cwd,
    runs,
    warmup,
    showOutput: p.flags.has("--show-output"),
    onProgress: io.isTTY ? (d, t) => io.err(`\r  run ${d}/${t}${d === t ? "\n" : ""}`) : void 0
  });
  const base = baseline && { ...baseline, cmp: compare(baseline.result.runs, result.runs) };
  if (base && base.result.command !== result.command) {
    io.err(`perfproof: note: the baseline was recorded for "${base.result.command}".
`);
  }
  if (p.flags.has("--json")) {
    io.out(
      JSON.stringify(
        {
          ...result,
          baseline: base ? { name: base.name, ...base.result, comparison: base.cmp } : void 0
        },
        null,
        2
      ) + "\n"
    );
  } else if (p.flags.has("--md")) {
    io.out(benchMarkdown(result, base));
  } else {
    io.out(benchText(result, base));
  }
  if (saveName !== void 0) {
    const name = saveName === true ? "baseline" : saveName;
    const file = saveBaseline(io.cwd, name, result);
    io.err(`perfproof: saved baseline "${name}" (${relative(io.cwd, file)})
`);
  }
  if (base && base.cmp.verdict === "slower" && p.flags.has("--fail-if-slower")) return 1;
  return 0;
}
function supportsCpuProfInNodeOptions(version) {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 22 || major === 22 && minor >= 15;
}
function openFile(file) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", '""', file]] : process.platform === "darwin" ? ["open", [file]] : ["xdg-open", [file]];
  spawn2(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {
  }).unref();
}

// src/cli/index.ts
var code = await main(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
  isTTY: Boolean(process.stderr.isTTY)
});
process.exitCode = code;

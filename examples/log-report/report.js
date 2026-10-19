// Summarise an access log: requests per status, unique visitors, slowest endpoints.
// This version is intentionally naive; see README.md for what perfproof finds in it.
import { generateLog } from './generate.js';

const LINE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\w+) (\S+)[^"]*" (\d{3}) (\d+) (\d+)ms$/;

function parse(line) {
  const m = new RegExp(LINE).exec(line);
  if (!m) return null;
  return { ip: m[1], method: m[3], path: m[4], status: Number(m[5]), ms: Number(m[7]) };
}

function endpoint(path) {
  return path.replace(/\/\d+$/, '/:id');
}

export function summarise(lines) {
  const visitors = [];
  const statuses = {};
  const timings = {};
  for (const line of lines) {
    const r = parse(line);
    if (!r) continue;
    if (!visitors.includes(r.ip)) visitors.push(r.ip);
    statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    const key = `${r.method} ${endpoint(r.path)}`;
    (timings[key] ??= []).push(r.ms);
  }
  const slowest = Object.entries(timings)
    .map(([key, ms]) => {
      const sorted = [...ms].sort((a, b) => a - b);
      return { key, p95: sorted[Math.floor(sorted.length * 0.95)], count: ms.length };
    })
    .sort((a, b) => b.p95 - a.p95)
    .slice(0, 5);
  return { requests: lines.length, visitors: visitors.length, statuses, slowest };
}

const summary = summarise(generateLog(Number(process.argv[2] ?? 150_000)));
console.log(JSON.stringify(summary, null, 2));

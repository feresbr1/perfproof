// Summarise an access log: requests per status, unique visitors, slowest endpoints.
// The same report after acting on perfproof's two hottest lines (see README.md).
import { generateLog } from './generate.js';

const LINE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\w+) (\S+)[^"]*" (\d{3}) (\d+) (\d+)ms$/;

function parse(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  return { ip: m[1], method: m[3], path: m[4], status: Number(m[5]), ms: Number(m[7]) };
}

function endpoint(path) {
  return path.replace(/\/\d+$/, '/:id');
}

export function summarise(lines) {
  const visitors = new Set();
  const statuses = {};
  const timings = {};
  for (const line of lines) {
    const r = parse(line);
    if (!r) continue;
    visitors.add(r.ip);
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
  return { requests: lines.length, visitors: visitors.size, statuses, slowest };
}

const summary = summarise(generateLog(Number(process.argv[2] ?? 150_000)));
console.log(JSON.stringify(summary, null, 2));

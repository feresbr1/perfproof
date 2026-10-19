// Deterministic fake access log, so every run (and every machine) processes the same data.
const PATHS = [
  '/',
  '/login',
  '/api/items',
  '/api/items/:id',
  '/api/search',
  '/cart',
  '/checkout',
  '/static/app.js',
];
const METHODS = ['GET', 'GET', 'GET', 'POST', 'PUT', 'DELETE'];
const STATUSES = [200, 200, 200, 200, 201, 204, 301, 304, 400, 401, 404, 500];

export function generateLog(count, seed = 42) {
  // mulberry32
  let s = seed >>> 0;
  const rand = (n) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const lines = [];
  for (let i = 0; i < count; i++) {
    const ip = `10.0.${rand(16)}.${rand(250)}`;
    const path = PATHS[rand(PATHS.length)].replace(':id', String(rand(500)));
    const day = String(1 + rand(28)).padStart(2, '0');
    lines.push(
      `${ip} - - [${day}/Oct/2026:12:00:00 +0000] "${METHODS[rand(METHODS.length)]} ${path} HTTP/1.1" ${STATUSES[rand(STATUSES.length)]} ${200 + rand(5000)} ${1 + rand(900)}ms`,
    );
  }
  return lines;
}

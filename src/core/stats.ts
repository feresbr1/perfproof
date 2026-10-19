export interface Summary {
  n: number;
  mean: number;
  sd: number;
  median: number;
  min: number;
  max: number;
  /** Half-width of the 95% confidence interval of the mean. */
  ci95: number;
}

export function summarize(xs: number[]): Summary {
  const n = xs.length;
  if (n === 0) throw new Error('No measurements.');
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median = n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const ci95 = n > 1 ? tQuantile(0.975, n - 1) * (sd / Math.sqrt(n)) : 0;
  return { n, mean, sd, median, min: sorted[0]!, max: sorted[n - 1]!, ci95 };
}

export interface Comparison {
  /** baseline mean / current mean: 2 means twice as fast. */
  speedup: number;
  /** Relative change of the mean, (current - baseline) / baseline. */
  change: number;
  /** Two-sided p-value of Welch's t-test. */
  p: number;
  t: number;
  df: number;
  verdict: 'faster' | 'slower' | 'same';
}

/**
 * Welch's t-test on two sets of timings. A difference only counts when it is statistically
 * significant (p < alpha) and larger than `minChange` (default 2%), so noise is reported as "same".
 */
export function compare(
  baseline: number[],
  current: number[],
  { alpha = 0.05, minChange = 0.02 } = {},
): Comparison {
  const a = summarize(baseline);
  const b = summarize(current);
  const va = a.sd ** 2 / a.n;
  const vb = b.sd ** 2 / b.n;
  const diff = b.mean - a.mean;
  let t: number;
  let df: number;
  let p: number;
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
  let verdict: Comparison['verdict'] = 'same';
  if (p < alpha && Math.abs(change) >= minChange) verdict = diff < 0 ? 'faster' : 'slower';
  return { speedup, change, p, t, df, verdict };
}

// --- Student's t distribution -------------------------------------------------------------------

/** CDF of Student's t distribution with `df` degrees of freedom. */
export function tCdf(t: number, df: number): number {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Inverse CDF by bisection; accurate to ~1e-10, plenty for confidence intervals. */
export function tQuantile(p: number, df: number): number {
  let lo = -1e3;
  let hi = 1e3;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Regularized incomplete beta function I_x(a, b) (continued fraction, Numerical Recipes). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBeta = logGamma(a + b) - logGamma(a) - logGamma(b);
  const front = Math.exp(lnBeta + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaFraction(x, a, b)) / a;
  return 1 - (front * betaFraction(1 - x, b, a)) / b;
}

function betaFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
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

function logGamma(z: number): number {
  // Lanczos approximation (g = 7, n = 9).
  const g = 7;
  const coef = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = coef[0]!;
  for (let i = 1; i < g + 2; i++) x += coef[i]! / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

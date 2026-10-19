export function ms(value: number): string {
  if (!Number.isFinite(value)) return '–';
  if (value >= 10_000) return `${(value / 1000).toFixed(1)} s`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (value >= 100) return `${value.toFixed(0)} ms`;
  if (value >= 10) return `${value.toFixed(1)} ms`;
  return `${value.toFixed(2)} ms`;
}

export function pct(value: number): string {
  if (value >= 9.95) return `${value.toFixed(0)}%`;
  return `${value.toFixed(1)}%`;
}

export function pValue(p: number): string {
  if (p < 0.0001) return 'p < 0.0001';
  return `p = ${p.toFixed(p < 0.01 ? 4 : 3)}`;
}

export function times(speedup: number): string {
  if (!Number.isFinite(speedup)) return '∞×';
  return `${speedup >= 10 ? speedup.toFixed(0) : speedup.toFixed(2)}×`;
}

export function bar(fraction: number, width = 20): string {
  const n = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(n) + '·'.repeat(width - n);
}

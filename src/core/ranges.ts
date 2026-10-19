/**
 * Find where a function ends, given the 0-based line/column where V8 says it starts. A small
 * scanner, not a parser: it skips strings, template literals and comments and balances brackets.
 * Good enough to tell which function a hot line belongs to; returns null when unsure.
 */
export function functionEndLine(src: string[], line: number, column: number): number | null {
  if (line < 0 || line >= src.length) return null;
  let depthParen = 0;
  let depthBrace = 0;
  let sawBody = false;
  let arrowExpr = false;
  let sawArrow = false;
  let quote: string | null = null;
  let blockComment = false;

  for (let l = line; l < src.length; l++) {
    const text = src[l]!;
    let i = l === line ? column : 0;
    for (; i < text.length; i++) {
      const c = text[i]!;
      const next = text[i + 1];
      if (blockComment) {
        if (c === '*' && next === '/') {
          blockComment = false;
          i++;
        }
        continue;
      }
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '/' && next === '/') break;
      if (c === '/' && next === '*') {
        blockComment = true;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        continue;
      }
      // `x => expr`: after the arrow, anything but "{" starts an expression body.
      if (sawArrow && !sawBody && !arrowExpr && !/\s/.test(c) && c !== '{') arrowExpr = true;
      if (c === '(' || c === '[') depthParen++;
      else if (c === ')' || c === ']') {
        depthParen--;
        if (arrowExpr && depthParen < 0) return l;
      } else if (c === '=' && next === '>' && depthParen === 0 && depthBrace === 0 && !sawBody) {
        sawArrow = true;
        i++;
        continue;
      } else if (c === '{') {
        if (depthParen === 0 && depthBrace === 0 && !sawBody && !arrowExpr) sawBody = true;
        depthBrace++;
      } else if (c === '}') {
        depthBrace--;
        if (sawBody && depthBrace === 0) return l;
        if (depthBrace < 0) return l;
      } else if (c === ',' || c === ';') {
        if (arrowExpr && depthParen === 0 && depthBrace === 0) return l;
      }
    }
    if (quote === "'" || quote === '"') quote = null; // unterminated string: give up on it
    if (arrowExpr && depthParen === 0 && depthBrace === 0) {
      const following = src[l + 1]?.trim() ?? '';
      if (!/^[.?:+\-*/&|]/.test(following)) return l;
    }
    if (l - line > 5000) return null;
  }
  return null;
}

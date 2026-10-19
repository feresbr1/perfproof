function unique(n) {
  const seen = [];
  for (let i = 0; i < n; i++) {
    if (!seen.includes(i % 4000)) seen.push(i % 4000);
  }
  return seen.length;
}
console.log(unique(Number(process.argv[2] ?? 80000)));

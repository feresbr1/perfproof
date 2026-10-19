// A worker does some work, then idles until its parent stops it with SIGTERM (as test runners do).
const { fork } = require('node:child_process');
function burn(ms) {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(x + 1);
  return x;
}
if (process.argv[2] === 'worker') {
  burn(300);
  process.send('done');
  setInterval(() => {}, 1000);
} else {
  const child = fork(__filename, ['worker']);
  child.on('message', () => child.kill('SIGTERM'));
}

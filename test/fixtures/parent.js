const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
execFileSync(process.execPath, [join(__dirname, 'child.js')], { stdio: 'inherit' });

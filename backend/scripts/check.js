// Syntax-checks every source file (fast CI gate before the slower integration tests).
import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (p.endsWith('.js')) yield p;
  }
}
let n = 0;
for (const dir of ['src', 'scripts', 'test']) {
  for await (const file of walk(dir)) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    n++;
  }
}
console.log(`syntax ok: ${n} files`);

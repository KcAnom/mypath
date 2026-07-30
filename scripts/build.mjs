import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const checked = spawnSync(process.execPath, ['scripts/check.mjs'], { stdio: 'inherit' });
if (checked.status) process.exit(checked.status);
for (const required of ['web/index.html', 'web/src/main.tsx', 'web/src/App.tsx', 'server/src/db/migrations/001_core.sql', 'server/src/db/migrations/005_runtime.sql']) {
  if (!fs.existsSync(required)) throw new Error(`Missing runtime resource: ${required}`);
}
for (const file of ['web/index.html', 'web/styles.css', 'server/generate.js']) {
  const source = fs.readFileSync(file, 'utf8');
  if (/fonts\.(?:googleapis|gstatic)\.com/i.test(source)) throw new Error(`Remote Google Font dependency remains in ${file}`);
}
const vite = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit' });
if (vite.status) process.exit(vite.status || 1);
if (!fs.existsSync('.runtime/web/index.html')) throw new Error('Vite did not produce the local web runtime');
console.log('Production React UI built into ignored .runtime/web; dist and Tauri resources were not modified');

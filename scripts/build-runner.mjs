// Rebuilds backend/src/runner/engine.bundle.mjs: the browser's AI engine (src/pages/bulk-trader/serverRun.ts and the
// AutoPilotEngine behind it) packed into one file the backend can import. Run it after ANY change to the AI engine, so the
// server runs the same logic as the AI tab:   node scripts/build-runner.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = [
    '--yes',
    'esbuild@0.24.0',
    'src/pages/bulk-trader/serverRun.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node18',
    '--log-level=warning',
    '--outfile=backend/src/runner/engine.bundle.mjs',
];
const res = spawnSync('npx', args, { cwd: root, stdio: 'inherit' });
process.exit(res.status ?? 1);

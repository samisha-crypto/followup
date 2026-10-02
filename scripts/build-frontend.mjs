import { spawnSync } from 'node:child_process';

const windows = process.platform === 'win32';
const result = spawnSync(windows ? 'py' : 'python3',
  windows ? ['-3', 'scripts/build-frontend.py'] : ['scripts/build-frontend.py'],
  { stdio: 'inherit' });

if (result.error) throw result.error;
process.exit(result.status ?? 1);

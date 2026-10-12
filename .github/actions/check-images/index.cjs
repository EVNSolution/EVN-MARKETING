const { spawnSync } = require('node:child_process');
// A JavaScript action receives the runtime cache environment. Keep tokens out of argv/logs.
const result = spawnSync('python3', ['.github/scripts/check_images.py'], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);

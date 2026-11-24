// Stands in for `openmorals hook openclaw` when the generated plugin is exercised in tests. It does nothing unless run
// with --openmorals-shim, and refuses to run without OPENMORALS_HOME so a test can never write to a real config folder.
import { runOpenclawHook } from '../../../src/adapters/openclaw/index.js';

if (process.argv.includes('--openmorals-shim')) {
  const home = process.env['OPENMORALS_HOME'];
  if (home === undefined || home === '') {
    process.exitCode = 3;
  } else {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      process.stdout.write(runOpenclawHook(Buffer.concat(chunks).toString('utf8'), { env: { OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' }, platform: 'linux' }).stdout);
    });
  }
}

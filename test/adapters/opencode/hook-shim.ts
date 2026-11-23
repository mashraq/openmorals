// Stands in for `openmorals hook opencode` when the generated plugin is exercised in tests. It does nothing unless run
// with --openmorals-shim, and refuses to run without OPENMORALS_HOME so a test can never write to a real config folder.
import { runOpencodeHook } from '../../../src/adapters/opencode/index.js';

if (process.argv.includes('--openmorals-shim')) {
  const home = process.env['OPENMORALS_HOME'];
  if (home === undefined || home === '') {
    process.exitCode = 3;
  } else {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      process.stdout.write(runOpencodeHook(Buffer.concat(chunks).toString('utf8'), { env: { OPENMORALS_HOME: home } }).stdout);
    });
  }
}

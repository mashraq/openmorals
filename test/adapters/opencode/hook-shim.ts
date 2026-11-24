// Stands in for `openmorals hook opencode` when the generated plugin is exercised in tests. It does nothing unless run
// with --openmorals-shim (and --platform=<p> to force the host platform), and refuses to run without OPENMORALS_HOME so a test can never write to a real config folder.
import { runOpencodeHook } from '../../../src/adapters/opencode/index.js';

if (process.argv.includes('--openmorals-shim')) {
  const home = process.env['OPENMORALS_HOME'];
  if (home === undefined || home === '') {
    process.exitCode = 3;
  } else {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      const forced = process.argv.find((a) => a.startsWith('--platform='))?.slice('--platform='.length);
      const platform: { platform?: NodeJS.Platform } = forced === 'win32' || forced === 'darwin' || forced === 'linux' ? { platform: forced } : {};
      process.stdout.write(runOpencodeHook(Buffer.concat(chunks).toString('utf8'), { env: { OPENMORALS_HOME: home }, ...platform }).stdout);
    });
  }
}

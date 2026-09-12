// Test-only child injection. Production CLI accepts no child override.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const [launcherPath, repo, logPath] = process.argv.slice(2);
const { startLauncher } = await import(pathToFileURL(launcherPath).href);
if (typeof startLauncher !== 'function') throw new Error('launcher must export startLauncher');
await startLauncher({
  command: process.execPath,
  args: [path.join(import.meta.dirname, 'child.cjs'), repo, logPath],
  input: process.stdin,
  output: process.stdout,
});

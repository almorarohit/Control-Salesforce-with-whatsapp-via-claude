import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ITEM_NOT_FOUND = 44; // errSecItemNotFound exit status from `security`

// Generic-password items in the login keychain, via macOS's `security` CLI.
// Values are written over stdin (hex-encoded), so they never appear in process arguments.
export function createKeychain(service) {
  async function get(account) {
    try {
      const { stdout } = await run('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
      return stdout.replace(/\n$/, '');
    } catch (err) {
      if (err.code === ITEM_NOT_FOUND) return undefined;
      throw new Error(`Keychain read failed for ${service}/${account}: ${err.stderr || err.message}`);
    }
  }

  async function set(account, value) {
    const hex = Buffer.from(value, 'utf8').toString('hex');
    await new Promise((resolve, reject) => {
      const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 && !stderr.trim() ? resolve() : reject(new Error(`Keychain write failed for ${service}/${account}: ${stderr || code}`))));
      child.stdin.end(`add-generic-password -U -s ${service} -a ${account} -X ${hex}\n`);
    });
    if ((await get(account)) !== value) throw new Error(`Keychain write for ${service}/${account} did not read back`);
  }

  async function remove(account) {
    try {
      await run('security', ['delete-generic-password', '-s', service, '-a', account]);
    } catch (err) {
      if (err.code !== ITEM_NOT_FOUND) throw new Error(`Keychain delete failed for ${service}/${account}: ${err.stderr || err.message}`);
    }
  }

  return { get, set, remove };
}

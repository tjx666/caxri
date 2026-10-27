import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Formats generated source the way `bun run format` formats a committed file, so a generator's output is already
 * format-clean. `filepath` only selects the language and the `bunfig.toml` `[fmt]` overrides; nothing is read from or
 * written to it. `--no-config` keeps a Prettier config in a parent directory of the checkout from changing the result.
 */
export async function formatSource(source: string, filepath: string): Promise<string> {
    const child = spawn(
        'bun',
        ['fmt', '--no-config', '--no-script', '--log-level', 'error', '--stdin-filepath', filepath],
        { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
        child.stdin.end(source);
    });
    if (exitCode !== 0) {
        throw new Error(
            `bun fmt failed for ${filepath}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
        );
    }
    return Buffer.concat(stdout).toString('utf8');
}

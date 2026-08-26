import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const runtimeExports = [
    new URL('../dist/index.js', import.meta.url),
    new URL('../dist/testing.js', import.meta.url),
];

/**
 * Verifies that every declared runtime entry can be loaded by the platform without a bundler.
 */
export async function verifyRuntimeExports(urls: readonly URL[] = runtimeExports): Promise<void> {
    await Promise.all(
        urls.map(async (url) => {
            try {
                await execFileAsync('node', [
                    '--input-type=module',
                    '--eval',
                    `await import(${JSON.stringify(url.href)})`,
                ]);
            } catch (error) {
                const stderr =
                    error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
                        ? error.stderr.trim()
                        : String(error);
                throw new Error(`Platform ESM loader rejected ${url.href}:\n${stderr}`, {
                    cause: error,
                });
            }
        }),
    );
}

if (import.meta.main) {
    await verifyRuntimeExports();
    process.stdout.write(`Verified ${runtimeExports.length} Agent skill runtime exports\n`);
}

import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export function parseSpecPaths(raw: string | undefined): string[] {
    const value: unknown = JSON.parse(raw ?? 'null');
    const paths: unknown[] = Array.isArray(value) ? value : [];
    if (
        paths.length === 0 ||
        paths.some(
            (path) => typeof path !== 'string' || !/^e2e\/[a-z0-9][a-z0-9-]*\.e2e\.ts$/u.test(path),
        )
    ) {
        throw new Error('CI_E2E_TESTS must contain validated E2E spec paths');
    }
    return [...new Set(paths as string[])];
}

async function main(): Promise<void> {
    const paths = parseSpecPaths(process.env.CI_E2E_TESTS);
    await Promise.all(paths.map((path) => access(path)));
    const child = spawn('bunx', ['playwright', 'test', ...paths, '--reporter=line'], {
        stdio: 'inherit',
    });
    const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    });
    if (code !== 0) process.exitCode = code ?? 1;
}

if (import.meta.main) await main();

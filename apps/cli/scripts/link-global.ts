import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

interface CliManifest {
    engines?: { node?: string };
    name?: string;
    version?: string;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultCliRoot = resolve(scriptDirectory, '..');

function requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`CLI package manifest is missing ${field}`);
    }
    return value;
}

/**
 * Pnpm 12 cannot load workspace/catalog dependencies in the global resolver used by `pnpm add -g .`. The verified
 * `caxri.cjs` bundle has no external dependencies, so expose a minimal stable `file:` package that pnpm can register
 * without publishing `@caxri/protocol`. See https://pnpm.io/next/global-packages#registering-local-packages-globally.
 */
export async function prepareGlobalCliPackage(cliRoot = defaultCliRoot): Promise<string> {
    const manifest = JSON.parse(
        await readFile(join(cliRoot, 'package.json'), 'utf8'),
    ) as CliManifest;
    const name = requiredString(manifest.name, 'name');
    const version = requiredString(manifest.version, 'version');
    const bundlePath = join(cliRoot, 'dist', 'caxri.cjs');
    const globalRoot = join(cliRoot, 'dist', 'global');
    const nextBundlePath = join(globalRoot, `.caxri-${process.pid}.cjs`);
    const nextManifestPath = join(globalRoot, `.package-${process.pid}.json`);

    await mkdir(globalRoot, { recursive: true });
    await copyFile(bundlePath, nextBundlePath);
    await chmod(nextBundlePath, 0o755);
    await writeFile(
        nextManifestPath,
        `${JSON.stringify(
            {
                name,
                version,
                private: true,
                bin: { caxri: './caxri.cjs' },
                engines: manifest.engines,
            },
            null,
            2,
        )}\n`,
        'utf8',
    );
    await rename(nextBundlePath, join(globalRoot, 'caxri.cjs'));
    await rename(nextManifestPath, join(globalRoot, 'package.json'));
    return globalRoot;
}

async function linkGlobalCli(cliRoot = defaultCliRoot): Promise<void> {
    const globalRoot = await prepareGlobalCliPackage(cliRoot);
    const child = spawn('pnpm', ['add', '--global', 'file:.'], {
        cwd: globalRoot,
        stdio: 'inherit',
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) reject(new Error(`pnpm exited with ${signal}`));
            else resolve(code ?? 1);
        });
    });
    if (exitCode !== 0) throw new Error(`pnpm add --global file:. exited with code ${exitCode}`);
}

if (import.meta.main) await linkGlobalCli();

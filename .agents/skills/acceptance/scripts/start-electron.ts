#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    errorCode,
    getProcessIdentity,
    isAlive,
    isOwnedLauncher,
    removeOwnedUserData,
    runtimeStateSchema,
    type RuntimeState,
} from './runtime-state';
import {
    acquireDesktopLease,
    releaseDesktopLease,
} from '../../switch-worktree/scripts/desktop-lease';
import { assertBuildOutputsFresh } from '../../../../src/shared/node/build-freshness';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RUNTIME_PATH = join(PROJECT_ROOT, '.records', 'acceptance', 'runtime.json');
const ELECTRON_PATH = join(PROJECT_ROOT, 'node_modules', '.bin', 'electron');
const BUILT_MAIN_PATH = join(PROJECT_ROOT, 'out', 'main', 'index.js');
const STALE_BUILD_MESSAGE = 'Build output is stale; run `bun run build` before Acceptance';
const BUILD_INPUT_PATHS = [
    join(PROJECT_ROOT, 'src'),
    join(PROJECT_ROOT, 'electron.vite.config.ts'),
    join(PROJECT_ROOT, 'package.json'),
    join(PROJECT_ROOT, 'package-lock.json'),
    join(PROJECT_ROOT, 'tsconfig.node.json'),
    join(PROJECT_ROOT, 'tsconfig.web.json'),
];
const BUILD_OUTPUT_PATHS = [
    BUILT_MAIN_PATH,
    join(PROJECT_ROOT, 'out', 'main', 'runtime.js'),
    join(PROJECT_ROOT, 'out', 'preload', 'index.cjs'),
    join(PROJECT_ROOT, 'out', 'preload', 'process-explorer.cjs'),
    join(PROJECT_ROOT, 'out', 'renderer', 'index.html'),
    join(PROJECT_ROOT, 'out', 'renderer', 'process-explorer.html'),
];
const WATCHED_BUILD_INPUT_EXTENSIONS = new Set([
    '.css',
    '.html',
    '.json',
    '.png',
    '.svg',
    '.ts',
    '.tsx',
    '.ttf',
    '.woff',
    '.woff2',
]);

type OptionValue = string | true;
type ParsedOptions = Record<string, OptionValue[]>;

function parseOptions(argv: string[]): ParsedOptions {
    const options: ParsedOptions = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) throw new Error(`Expected an option, received: ${token}`);
        const key = token.slice(2);
        const next = argv[index + 1];
        (options[key] ??= []).push(next && !next.startsWith('--') ? argv[++index] : true);
    }
    return options;
}

function stringOptions(options: ParsedOptions, key: string): string[] {
    const values = options[key] ?? [];
    if (values.some((value) => value === true)) throw new Error(`--${key} requires a value`);
    return values as string[];
}

function stringOption(options: ParsedOptions, key: string): string | undefined {
    const values = options[key] ?? [];
    if (values.length > 1) throw new Error(`--${key} may only be provided once`);
    const value = values[0];
    if (value === true) throw new Error(`--${key} requires a value`);
    return value;
}

function help(): string {
    return `Start an isolated Caxri Electron acceptance instance

Options:
  --port N               CDP port (default: 9222)
  --test-root PATH       Project root selected in Caxri; repeat to queue roots (default: repository root)
  --help                 Show this message`;
}

async function removeStaleRuntime(): Promise<void> {
    let rawText: string;
    try {
        rawText = await readFile(RUNTIME_PATH, 'utf8');
    } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
    }

    let current: RuntimeState;
    try {
        const raw: unknown = JSON.parse(rawText);
        current = runtimeStateSchema.parse(raw);
    } catch {
        throw new Error(
            `Invalid ${relative(PROJECT_ROOT, RUNTIME_PATH)}; inspect it before removing stale state`,
        );
    }

    /** Preserve a verified live owner; only stale identity can release its state. */
    if (await isOwnedLauncher(current)) {
        throw new Error(
            `Acceptance instance already running with launcher PID ${current.launcherPid}`,
        );
    }
    await unlink(RUNTIME_PATH);
    await removeOwnedUserData(current);
}

async function assertPortAvailable(port: number): Promise<void> {
    const server = createServer();
    server.unref();
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, '127.0.0.1', resolveListen);
    }).catch((error: unknown) => {
        if (errorCode(error) === 'EADDRINUSE')
            throw new Error(`CDP port ${port} is already in use`);
        throw error;
    });
    await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
}

async function writeRuntime(state: RuntimeState): Promise<void> {
    await mkdir(dirname(RUNTIME_PATH), { recursive: true });
    const temporary = `${RUNTIME_PATH}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, RUNTIME_PATH);
}

async function waitForCdp(port: number, child: ChildProcess): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Electron exited before CDP became ready (${child.exitCode})`);
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) return;
        } catch {
            // The listener is expected to reject connections while Electron starts.
        }
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
    }
    throw new Error(`Timed out waiting for CDP on port ${port}`);
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    if (options.help?.length) {
        console.log(help());
        return;
    }

    const port = Number(stringOption(options, 'port') ?? 9222);
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
        throw new Error('--port must be an integer between 1024 and 65535');
    }

    const desktopLease = await acquireDesktopLease(PROJECT_ROOT, 'Acceptance');
    try {
        await access(ELECTRON_PATH);
        await assertBuildOutputsFresh({
            inputPaths: BUILD_INPUT_PATHS,
            outputPaths: BUILD_OUTPUT_PATHS,
            staleMessage: STALE_BUILD_MESSAGE,
            watchedDirectoryExtensions: WATCHED_BUILD_INPUT_EXTENSIONS,
        });
        await removeStaleRuntime();
        await assertPortAvailable(port);

        const requestedRoots = stringOptions(options, 'test-root');
        const testRootPaths = (requestedRoots.length > 0 ? requestedRoots : [PROJECT_ROOT]).map(
            (root) => resolve(PROJECT_ROOT, root),
        );
        await Promise.all(
            testRootPaths.map((root) =>
                access(root).catch(() => {
                    throw new Error(`Test root does not exist: ${root}`);
                }),
            ),
        );
        const testRootPath = testRootPaths[0];
        const launcherIdentity = await getProcessIdentity(process.pid);
        if (!launcherIdentity) throw new Error('Could not establish Acceptance launcher identity');
        const userDataDir = await mkdtemp(join(tmpdir(), 'caxri-acceptance-user-'));

        const child = spawn(ELECTRON_PATH, ['.', `--remote-debugging-port=${port}`], {
            cwd: PROJECT_ROOT,
            env: {
                ...process.env,
                CAXRI_E2E: '1',
                CAXRI_TEST_ROOT_PATH: testRootPath,
                CAXRI_TEST_ROOT_PATHS: JSON.stringify(testRootPaths),
                CAXRI_USER_DATA_DIR: userDataDir,
            },
            stdio: 'inherit',
        });
        const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolveExit, rejectExit) => {
                child.once('error', rejectExit);
                child.once('exit', (code, signal) => resolveExit({ code, signal }));
            },
        );

        const runtime: RuntimeState = {
            cdpUrl: `http://127.0.0.1:${port}`,
            electronPid: child.pid ?? null,
            launcherIdentity,
            launcherPid: process.pid,
            ownedUserData: true,
            port,
            startedAt: new Date().toISOString(),
            testRootPath,
            testRootPaths,
            userDataDir,
        };
        let stopping = false;
        const stop = (): void => {
            if (stopping) return;
            stopping = true;
            if (isAlive(child.pid)) child.kill('SIGTERM');
            const forceTimer = setTimeout(() => {
                if (isAlive(child.pid)) child.kill('SIGKILL');
            }, 5_000);
            forceTimer.unref();
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);

        try {
            await writeRuntime(runtime);
            await Promise.race([
                waitForCdp(port, child),
                childExit.then<never>(({ code, signal }) => {
                    throw new Error(
                        `Electron exited before CDP was ready (${code ?? signal ?? 'unknown'})`,
                    );
                }),
            ]);
            console.log(JSON.stringify({ ...runtime, status: 'ready' }));
            const { code, signal } = await childExit;
            if (!stopping && code !== 0) {
                throw new Error(`Electron exited with code ${code} (${signal ?? 'no signal'})`);
            }
        } finally {
            stop();
            await childExit.catch(() => undefined);
            await unlink(RUNTIME_PATH).catch((error: unknown) => {
                if (errorCode(error) !== 'ENOENT') throw error;
            });
            await removeOwnedUserData(runtime);
        }
    } finally {
        await releaseDesktopLease(desktopLease);
    }
}

void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});

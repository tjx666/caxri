import type { Buffer } from 'node:buffer';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { developmentCommands } from '../development-commands';

async function waitForEvents(path: string, count: number): Promise<string[]> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            // eslint-disable-next-line no-await-in-loop -- bounded polling observes a child-process fixture
            const events = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean);
            if (events.length >= count) return events;
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error;
        }
        // eslint-disable-next-line no-await-in-loop -- bounded polling observes a child-process fixture
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Development process events did not reach ${count}`);
}

async function readEvents(path: string): Promise<string[]> {
    try {
        return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
    }
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
    return new Promise((resolve) => {
        child.once('exit', (exitCode) => resolve(exitCode));
    });
}

describe('development commands', () => {
    it('passes the Desktop entry explicitly from the workspace root', () => {
        expect(developmentCommands).toContainEqual([
            'electron-vite',
            'dev',
            '--entry',
            'out/main/index.js',
        ]);
    });

    it('waits for the first complete Server artifact before starting Desktop', async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), 'caxri-development-'));
        const eventsPath = join(fixtureRoot, 'events.log');
        const fakePnpm = join(fixtureRoot, 'pnpm');
        const fakeElectronVite = join(fixtureRoot, 'electron-vite');
        await Promise.all([
            writeFile(
                fakePnpm,
                String.raw`#!/usr/bin/env bun
import { appendFile, writeFile } from 'node:fs/promises';
await Bun.sleep(100);
await appendFile(process.env.CAXRI_TEST_DEVELOPMENT_EVENTS, 'server-ready\n');
await writeFile(process.env.CAXRI_SERVER_WATCH_READY_FILE, 'ready\n');
await Bun.sleep(5_000);
`,
            ),
            writeFile(
                fakeElectronVite,
                String.raw`#!/usr/bin/env bun
import { appendFile } from 'node:fs/promises';
await appendFile(process.env.CAXRI_TEST_DEVELOPMENT_EVENTS, 'desktop-started\n');
await Bun.sleep(5_000);
`,
            ),
        ]);
        await Promise.all([chmod(fakePnpm, 0o755), chmod(fakeElectronVite, 0o755)]);
        const root = resolve(import.meta.dirname, '../..');
        const child = spawn('bun', [resolve(root, 'scripts/development.ts')], {
            cwd: root,
            env: {
                ...process.env,
                CAXRI_TEST_DEVELOPMENT_EVENTS: eventsPath,
                PATH: `${fixtureRoot}${delimiter}${process.env.PATH ?? ''}`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        try {
            await expect(waitForEvents(eventsPath, 2)).resolves.toEqual([
                'server-ready',
                'desktop-started',
            ]);
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                const exited = once(child, 'exit');
                child.kill('SIGTERM');
                await exited;
            }
            await rm(fixtureRoot, { force: true, recursive: true });
        }
    });

    it('exits without starting Desktop when the Server watcher stops before readiness', async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), 'caxri-development-exit-'));
        const eventsPath = join(fixtureRoot, 'events.log');
        const fakePnpm = join(fixtureRoot, 'pnpm');
        const fakeElectronVite = join(fixtureRoot, 'electron-vite');
        await Promise.all([
            writeFile(fakePnpm, '#!/usr/bin/env bun\nprocess.exitCode = 17;\n'),
            writeFile(
                fakeElectronVite,
                String.raw`#!/usr/bin/env bun
import { appendFile } from 'node:fs/promises';
await appendFile(process.env.CAXRI_TEST_DEVELOPMENT_EVENTS, 'desktop-started\n');
`,
            ),
        ]);
        await Promise.all([chmod(fakePnpm, 0o755), chmod(fakeElectronVite, 0o755)]);
        const root = resolve(import.meta.dirname, '../..');
        const child = spawn('bun', [resolve(root, 'scripts/development.ts')], {
            cwd: root,
            env: {
                ...process.env,
                CAXRI_TEST_DEVELOPMENT_EVENTS: eventsPath,
                PATH: `${fixtureRoot}${delimiter}${process.env.PATH ?? ''}`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        try {
            const exitCode = await waitForExit(child);

            expect(exitCode).toBe(17);
            await expect(readEvents(eventsPath)).resolves.toEqual([]);
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
            await rm(fixtureRoot, { force: true, recursive: true });
        }
    });

    it('fails clearly instead of waiting forever when Server readiness is not published', async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), 'caxri-development-timeout-'));
        const eventsPath = join(fixtureRoot, 'events.log');
        const fakePnpm = join(fixtureRoot, 'pnpm');
        const fakeElectronVite = join(fixtureRoot, 'electron-vite');
        await Promise.all([
            writeFile(
                fakePnpm,
                String.raw`#!/usr/bin/env bun
import { appendFile } from 'node:fs/promises';
await appendFile(process.env.CAXRI_TEST_DEVELOPMENT_EVENTS, 'server-started\n');
await Bun.sleep(5_000);
`,
            ),
            writeFile(
                fakeElectronVite,
                String.raw`#!/usr/bin/env bun
import { appendFile } from 'node:fs/promises';
await appendFile(process.env.CAXRI_TEST_DEVELOPMENT_EVENTS, 'desktop-started\n');
`,
            ),
        ]);
        await Promise.all([chmod(fakePnpm, 0o755), chmod(fakeElectronVite, 0o755)]);
        const root = resolve(import.meta.dirname, '../..');
        const child = spawn('bun', [resolve(root, 'scripts/development.ts')], {
            cwd: root,
            env: {
                ...process.env,
                CAXRI_SERVER_WATCH_READY_TIMEOUT_MS: '75',
                CAXRI_TEST_DEVELOPMENT_EVENTS: eventsPath,
                PATH: `${fixtureRoot}${delimiter}${process.env.PATH ?? ''}`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        try {
            const exitCode = await waitForExit(child);

            expect(exitCode).toBe(1);
            expect(stderr).toContain(
                'Timed out after 75 ms waiting for the initial Server artifact',
            );
            await expect(readEvents(eventsPath)).resolves.not.toContain('desktop-started');
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
            await rm(fixtureRoot, { force: true, recursive: true });
        }
    });
});

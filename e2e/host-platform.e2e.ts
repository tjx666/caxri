import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { connectToHost, ensureHost } from '@caxri/cli';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri } from './support/helpers.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const cliPath = join(projectRoot, 'packages', 'cli', 'dist', 'caxri.cjs');
const electronPath = join(
    projectRoot,
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'MacOS',
    'Electron',
);
const hostEntryPath = join(projectRoot, 'out', 'main', 'host.js');

interface CliResult {
    code: number;
    stderr: string;
    stdout: string;
}

function runCli(args: readonly string[], environment: NodeJS.ProcessEnv): Promise<CliResult> {
    return new Promise((resolveRun) => {
        execFile(
            process.execPath,
            [cliPath, ...args],
            {
                env: { ...process.env, ...environment },
                maxBuffer: 2 * 1024 * 1024,
                timeout: 15_000,
            },
            (error, stdout, stderr) => {
                resolveRun({
                    code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
                    stderr,
                    stdout,
                });
            },
        );
    });
}

async function stopHost(userDataPath: string): Promise<void> {
    const client = await connectToHost(userDataPath, 2_000).catch(() => undefined);
    if (!client) return;
    let pid: number | undefined;
    try {
        pid = (await client.request('host.status', {})).pid;
        await client.request('host.stop', { confirmLivePtys: true }).catch(() => undefined);
    } finally {
        client.close();
    }
    const manifestPath = join(userDataPath, 'host', 'manifest.json');
    await expect
        .poll(
            async () => {
                const manifestExists = await access(manifestPath)
                    .then(() => true)
                    .catch(() => false);
                let processExists: boolean;
                try {
                    if (pid) process.kill(pid, 0);
                    processExists = pid !== undefined;
                } catch {
                    processExists = false;
                }
                return { manifestExists, processExists };
            },
            { timeout: 5_000 },
        )
        .toEqual({ manifestExists: false, processExists: false });
}

test('shares settings across an app-managed headless Host and Desktop', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-host-platform-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const isolatedHome = join(testDirectory, 'home');
    const root = join(isolatedHome, 'project');
    const unscopedSecret = 'headless-secret-must-not-propagate';
    await Promise.all([mkdir(root, { recursive: true }), mkdir(isolatedHome, { recursive: true })]);
    const hostEnvironment: NodeJS.ProcessEnv = {
        CAXRI_CLI_PATH: cliPath,
        CAXRI_DESKTOP_LAUNCH: JSON.stringify({
            executable: electronPath,
            args: [projectRoot, '--disable-gpu'],
            cwd: projectRoot,
        }),
        CAXRI_E2E: '1',
        CAXRI_E2E_AGENT_MODE: 'blocked',
        CAXRI_E2E_WINDOW_MODE: 'hidden',
        CAXRI_TEST_ROOT_PATH: root,
        CLAUDE_CONFIG_DIR: join(isolatedHome, 'claude'),
        CODEX_HOME: join(isolatedHome, 'codex'),
        CODEX_SQLITE_HOME: join(isolatedHome, 'codex'),
        HOME: isolatedHome,
        XDG_CACHE_HOME: join(isolatedHome, 'cache'),
        XDG_CONFIG_HOME: join(isolatedHome, 'config'),
        XDG_DATA_HOME: join(isolatedHome, 'data'),
        ...(process.env.CAXRI_E2E_WORKER_NAMESPACE
            ? { CAXRI_E2E_WORKER_NAMESPACE: process.env.CAXRI_E2E_WORKER_NAMESPACE }
            : {}),
    };
    const environment = {
        ...hostEnvironment,
        CAXRI_USER_DATA_DIR: userData,
        UNSCOPED_SECRET_SENTINEL: unscopedSecret,
    };
    let running: Awaited<ReturnType<typeof launchCaxri>> | undefined;
    try {
        const headless = await ensureHost(
            userData,
            { executable: electronPath, entryPath: hostEntryPath, environment: hostEnvironment },
            15_000,
        );
        headless.close();
        const patched = await runCli(
            [
                'settings',
                'patch',
                '--set',
                'terminal.osc52ClipboardWrite=true',
                '--profile',
                userData,
                '--request-id',
                'headless-settings-patch-e2e',
                '--yes',
                '--json',
            ],
            environment,
        );
        expect(patched).toMatchObject({ code: 0, stderr: '' });
        expect(JSON.parse(patched.stdout)).toMatchObject({
            changedKeys: ['terminal.osc52ClipboardWrite'],
            dryRun: false,
            value: { 'terminal.osc52ClipboardWrite': true },
        });

        const initialStatus = await runCli(
            ['host', 'status', '--profile', userData, '--json'],
            environment,
        );
        expect(initialStatus).toMatchObject({ code: 0, stderr: '' });
        const initialHost = JSON.parse(initialStatus.stdout) as {
            desktop: { state: string };
            pid: number;
            runtimePid: number;
        };
        expect(initialHost).toMatchObject({
            desktop: { state: 'offline' },
            pid: expect.any(Number),
            runtimePid: expect.any(Number),
        });

        running = await launchCaxri({
            preserveHostOnClose: true,
            userDataDir: userData,
            testRootPath: root,
        });
        await createShellSession(running.page);
        await running.page.keyboard.press('Meta+,');
        const clipboardSetting = running.page.getByRole('checkbox', {
            name: 'Allow OSC 52 clipboard writes',
        });
        await expect(clipboardSetting).toBeChecked();
        await clipboardSetting.click();
        await expect(clipboardSetting).not.toBeChecked();
        await expect
            .poll(async () => {
                const result = await runCli(
                    ['settings', 'get', '--profile', userData, '--json'],
                    environment,
                );
                if (result.code !== 0) return result.stderr;
                const value = JSON.parse(result.stdout) as {
                    value?: { 'terminal.osc52ClipboardWrite'?: unknown };
                };
                return value.value?.['terminal.osc52ClipboardWrite'];
            })
            .toBe(false);

        await running.app.close();
        running = undefined;
        const commands = await Promise.all(
            [
                ['project', 'list'],
                ['session', 'list'],
                ['settings', 'get'],
                ['logs', 'query'],
                ['diagnostics', 'snapshot'],
                ['host', 'status'],
            ].map((command) => runCli([...command, '--profile', userData, '--json'], environment)),
        );
        expect(commands.every((result) => result.code === 0 && result.stderr === '')).toBe(true);
        expect(JSON.parse(commands[0].stdout)).toMatchObject({
            projects: [{ id: expect.any(String) }],
        });
        expect(JSON.parse(commands[1].stdout)).toMatchObject({
            sessions: [{ id: expect.any(String) }],
        });
        expect(JSON.parse(commands[2].stdout)).toMatchObject({
            value: { 'terminal.osc52ClipboardWrite': false },
        });
        expect(JSON.parse(commands[3].stdout)).toMatchObject({ records: expect.any(Array) });
        expect(JSON.parse(commands[4].stdout)).toMatchObject({ runtimeStatus: 'ready' });
        expect(JSON.parse(commands[5].stdout)).toMatchObject({
            desktop: { state: 'offline' },
            pid: initialHost.pid,
            runtimePid: initialHost.runtimePid,
        });
        expect(commands.map(({ stdout }) => stdout).join('\n')).not.toContain(unscopedSecret);
    } finally {
        await running?.app.close().catch(() => undefined);
        await stopHost(userData);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

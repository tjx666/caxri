import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { realCodexSmokeArguments } from './support/agent-fixture.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    typeTerminal,
} from './support/helpers.ts';

async function isPathPresent(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

test('the default E2E launch cannot resolve a host Agent executable', async () => {
    allowE2EErrors([
        {
            source: 'runtime',
            event: 'pty.spawn_failed',
            code: 'UNAVAILABLE',
            count: 1,
        },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-mode-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'host-bin');
    const launchMarker = join(testDirectory, 'host-codex-launched');
    const executable = join(bin, 'codex');
    await Promise.all([mkdir(root), mkdir(bin)]);
    await writeFile(
        executable,
        `#!${process.execPath}\n` +
            `require('node:fs').writeFileSync(${JSON.stringify(launchMarker)}, 'launched');\n` +
            `setInterval(() => {}, 1000);\n`,
        'utf8',
    );
    await chmod(executable, 0o700);

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    try {
        await createProjectSession(running.page, 'codex');
        await expect(
            running.page.getByText('Agent CLI executable was not found', { exact: true }),
        ).toBeVisible();
        await expect.poll(() => isPathPresent(launchMarker)).toBe(false);
        const launchRecord = (await readFile(join(userData, 'logs', 'main.jsonl'), 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map(
                (line) =>
                    JSON.parse(line) as {
                        event: string;
                        fields?: Record<string, string | null>;
                    },
            )
            .find((record) => record.event === 'e2e.launch');
        expect(launchRecord?.fields).toMatchObject({
            agentMode: 'blocked',
            agentProvider: null,
        });
        expect(JSON.stringify(launchRecord)).not.toContain(launchMarker);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('the blocked E2E mode shadows host Agents inside a Shell Terminal', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-shell-mode-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'host-bin');
    const launchMarker = join(testDirectory, 'shell-host-codex-launched');
    const executable = join(bin, 'codex');
    await Promise.all([mkdir(root), mkdir(bin)]);
    await writeFile(
        executable,
        `#!${process.execPath}\n` +
            `require('node:fs').writeFileSync(${JSON.stringify(launchMarker)}, 'launched');\n` +
            `process.stdout.write('UNSAFE_HOST_CODEX\\n');\n`,
        'utf8',
    );
    await chmod(executable, 0o700);

    const running = await launchCaxri({
        agentMode: { mode: 'blocked' },
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    try {
        await createShellSession(running.page);
        await typeTerminal(running.page, 'codex');
        await expect(running.page.locator('.xterm-rows')).toContainText('Caxri E2E blocked codex');
        await expect.poll(() => isPathPresent(launchMarker)).toBe(false);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('real mode rejects unsafe launch args and interactive Agent input', async () => {
    allowE2EErrors([
        {
            source: 'main',
            event: 'ipc.request_failed',
            code: 'VALIDATION',
            count: 1,
        },
        {
            source: 'runtime',
            event: 'ipc.request_failed',
            code: 'VALIDATION',
            count: 1,
        },
        {
            source: 'runtime',
            event: 'pty.spawn_failed',
            code: 'VALIDATION',
            count: 1,
        },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-real-agent-policy-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'host-bin');
    const home = join(testDirectory, 'home');
    const state = join(testDirectory, 'provider-state');
    const launchMarker = join(testDirectory, 'real-codex-launch.json');
    const inputMarker = join(testDirectory, 'real-codex-input');
    const executable = join(bin, 'codex');
    await Promise.all([mkdir(root), mkdir(bin), mkdir(home), mkdir(state)]);
    await writeFile(
        executable,
        `#!${process.execPath}\n` +
            `const fs = require('node:fs');\n` +
            `if (process.argv.includes('--version')) { process.stdout.write('synthetic-codex 1.0\\n'); process.exit(0); }\n` +
            `fs.writeFileSync(${JSON.stringify(launchMarker)}, JSON.stringify(process.argv.slice(2)));\n` +
            `process.stdin.setRawMode?.(true); process.stdin.resume();\n` +
            `process.stdin.on('data', (chunk) => fs.appendFileSync(${JSON.stringify(inputMarker)}, chunk));\n` +
            `process.stdout.write('SYNTHETIC_REAL_CODEX_READY\\r\\n');\n`,
        'utf8',
    );
    await chmod(executable, 0o700);

    const running = await launchCaxri({
        agentMode: { mode: 'real', provider: 'codex' },
        userDataDir: userData,
        testRootPath: root,
        env: {
            HOME: home,
            CODEX_HOME: state,
            CODEX_SQLITE_HOME: state,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
    });
    try {
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify({
                'agents.providers': {
                    codex: {
                        hooks: { enabled: false },
                        launch: { executable: 'codex', args: ['--unsafe-test-argument'] },
                    },
                },
            }),
        });
        await createProjectSession(running.page, 'codex');
        await expect(
            running.page.getByText('Terminal process could not be started', { exact: true }),
        ).toBeVisible();
        await expect.poll(() => isPathPresent(launchMarker)).toBe(false);

        const prompt = 'Read README.md and report its heading. Do not modify any files.';
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify({
                'agents.providers': {
                    codex: {
                        hooks: { enabled: false },
                        launch: { executable: 'codex', args: realCodexSmokeArguments(prompt) },
                    },
                },
            }),
        });
        await running.page.getByRole('button', { name: 'Restart Terminal' }).click();
        await expect(running.page.locator('.xterm-rows')).toContainText(
            'SYNTHETIC_REAL_CODEX_READY',
        );
        const bootstrap = await pageRequest<{ terminals: Array<{ id: string }> }>(
            running.page,
            'app.bootstrap',
        );
        await expect(
            pageRequest(running.page, 'terminal.input', {
                terminalId: bootstrap.terminals[0].id,
                data: '\u{3}',
            }),
        ).rejects.toThrow('VALIDATION: Real Agent E2E does not accept interactive Terminal input');
        await expect.poll(() => isPathPresent(inputMarker)).toBe(false);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('real mode cannot bypass its Agent policy through a Shell Terminal', async () => {
    allowE2EErrors([
        {
            source: 'runtime',
            event: 'pty.spawn_failed',
            code: 'VALIDATION',
            count: 1,
        },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-real-agent-shell-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'host-bin');
    const home = join(testDirectory, 'home');
    const state = join(testDirectory, 'provider-state');
    const launchMarker = join(testDirectory, 'real-shell-codex-launched');
    const executable = join(bin, 'codex');
    await Promise.all([mkdir(root), mkdir(bin), mkdir(home), mkdir(state)]);
    await writeFile(
        executable,
        `#!${process.execPath}\n` +
            `require('node:fs').writeFileSync(${JSON.stringify(launchMarker)}, 'launched');\n`,
        'utf8',
    );
    await chmod(executable, 0o700);

    const running = await launchCaxri({
        agentMode: { mode: 'real', provider: 'codex' },
        userDataDir: userData,
        testRootPath: root,
        env: {
            HOME: home,
            CODEX_HOME: state,
            CODEX_SQLITE_HOME: state,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
    });
    try {
        await createProjectSession(running.page, 'shell');
        const bootstrap = await pageRequest<{ terminals: Array<{ id: string }> }>(
            running.page,
            'app.bootstrap',
        );
        await pageRequest(running.page, 'terminal.input', {
            terminalId: bootstrap.terminals[0].id,
            data: 'codex\r',
        });
        await expect(
            running.page.getByText('Terminal process could not be started', { exact: true }),
        ).toBeVisible();
        await expect.poll(() => isPathPresent(launchMarker)).toBe(false);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

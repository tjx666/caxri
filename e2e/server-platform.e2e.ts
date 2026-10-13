import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { connectToServer, ensureServer } from '@caxri/client/supervise';
import { createE2EAgentEnvironment } from '@caxri/system';

import { delegationFixtureSource } from '../scripts/agent-delegation-fixture.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    openSettingsTab,
    pageRequest,
    revealSettingsSection,
} from './support/helpers.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const cliPath = join(projectRoot, 'apps', 'cli', 'dist', 'caxri.cjs');
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
const serverArtifactRoot = join(projectRoot, 'apps', 'server', 'dist', 'server');

interface CliResult {
    code: number;
    stderr: string;
    stdout: string;
}

function runCli(arguments_: readonly string[], environment: NodeJS.ProcessEnv): Promise<CliResult> {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            [cliPath, ...arguments_],
            {
                env: { ...process.env, ...environment },
                maxBuffer: 2 * 1024 * 1024,
                timeout: 15_000,
            },
            (error, stdout, stderr) => {
                resolve({
                    code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
                    stderr,
                    stdout,
                });
            },
        );
    });
}

async function stopHost(userDataPath: string): Promise<void> {
    let client: Awaited<ReturnType<typeof connectToServer>> | undefined;
    try {
        client = await connectToServer(userDataPath, 2_000);
    } catch {
        client = undefined;
    }
    if (!client) return;
    let pid: number | undefined;
    try {
        pid = (await client.request('host.status', {})).pid;
        try {
            await client.request('host.stop', { confirmLivePtys: true });
        } catch {
            // Ignore stop failures; the poll below confirms the Host actually shut down.
        }
    } finally {
        client.close();
    }
    const manifestPath = join(userDataPath, 'host', 'manifest.json');
    await expect
        .poll(
            async () => {
                let isManifestExists: boolean;
                try {
                    await access(manifestPath);
                    isManifestExists = true;
                } catch {
                    isManifestExists = false;
                }
                let isProcessExists: boolean;
                try {
                    // `pid` is always defined here: its only assignment (`host.status` above) is
                    // unguarded by a `catch`, so a failure there would already have aborted this
                    // function before reaching this poll.
                    if (pid) process.kill(pid, 0);
                    isProcessExists = true;
                } catch {
                    isProcessExists = false;
                }
                return { manifestExists: isManifestExists, processExists: isProcessExists };
            },
            { timeout: 5_000 },
        )
        .toEqual({ manifestExists: false, processExists: false });
}

test('authorizes an external caller before Desktop attaches and revokes it across a Server restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-external-platform-e2e-'));
    const userData = join(directory, 'profile');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: { executableSource: delegationFixtureSource('claude') } },
    });
    const isolatedEnvironment = await createE2EAgentEnvironment({
        fixtureRoot: join(userData, 'e2e-agents'),
        mode: agentMode,
        sourceEnvironment: {},
    });
    const hostEnvironment = {
        ...isolatedEnvironment,
        CAXRI_E2E: '1',
        CAXRI_E2E_AGENT_HOOKS: '1',
        CAXRI_E2E_WINDOW_MODE: 'hidden',
        CAXRI_CLI_PATH: cliPath,
        CAXRI_AGENT_HOOKS_PATH: join(userData, 'agent-hooks'),
        CAXRI_TEST_ROOT_PATH: root,
        ...(process.env.CAXRI_E2E_WORKER_NAMESPACE && {
            CAXRI_E2E_WORKER_NAMESPACE: process.env.CAXRI_E2E_WORKER_NAMESPACE,
        }),
    };
    /**
     * Synthetic owner invocation clears only its child environment, never the developer's configuration.
     */
    const ownerEnvironment = {
        ...hostEnvironment,
        CAXRI_USER_DATA_DIR: userData,
        CI: undefined,
        GITHUB_ACTIONS: undefined,
        CODEX_THREAD_ID: undefined,
        CLAUDECODE: undefined,
        CLAUDE_CODE_ENTRYPOINT: undefined,
        GROK_SESSION_ID: undefined,
        CAXRI_AGENT_ENDPOINT_HOST_ID: undefined,
        CAXRI_AGENT_ENDPOINT_ID: undefined,
        CAXRI_AGENT_ENDPOINT_GENERATION: undefined,
        CAXRI_AGENT_ENDPOINT_TOKEN: undefined,
        CAXRI_DELEGATION_CLIENT_ID: undefined,
        CAXRI_DELEGATION_GENERATION: undefined,
        CAXRI_DELEGATION_TOKEN: undefined,
    };
    let running: Awaited<ReturnType<typeof launchCaxri>> | undefined;
    try {
        const owner = await ensureServer(
            userData,
            { artifactRoot: serverArtifactRoot, environment: hostEnvironment },
            15_000,
        );
        try {
            expect((await owner.request('host.status', {})).desktop.state).toBe('offline');
        } finally {
            owner.close();
        }
        const authorize = await runCli(
            [
                'agent',
                'delegate',
                'access',
                'create',
                '--root',
                root,
                '--provider',
                'codex',
                '--register-project',
                '--profile',
                userData,
                '--yes',
                '--json',
            ],
            ownerEnvironment,
        );
        expect(authorize.code, authorize.stderr).toBe(0);
        const issued = JSON.parse(authorize.stdout) as {
            clientId: string;
            generation: number;
            token: string;
            projectId: string;
            sessionId: string;
        };
        const externalEnvironment = {
            ...ownerEnvironment,
            CODEX_THREAD_ID: 'synthetic-external-caller',
            CAXRI_DELEGATION_CLIENT_ID: issued.clientId,
            CAXRI_DELEGATION_GENERATION: String(issued.generation),
            CAXRI_DELEGATION_TOKEN: issued.token,
        };
        const context = await runCli(['agent-context', '--json'], externalEnvironment);
        expect(context.code).toBe(0);
        expect(JSON.parse(context.stdout)).toMatchObject({
            principal: {
                kind: 'delegation-client',
                projectIds: [issued.projectId],
                sessionId: issued.sessionId,
            },
        });
        const taskPath = join(directory, 'task.md');
        await writeFile(taskPath, 'Synthetic external delegation');
        const created = await runCli(
            [
                'agent',
                'delegate',
                'create',
                '--project',
                issued.projectId,
                '--session',
                issued.sessionId,
                '--provider',
                'claude',
                '--model',
                'opus',
                '--prompt-file',
                taskPath,
                '--request-id',
                'external-task',
                '--json',
            ],
            externalEnvironment,
        );
        expect(created.code).toBe(0);
        const receipt = JSON.parse(created.stdout) as { delegationId: string; terminalId: string };
        running = await launchCaxri({
            agentMode,
            preserveHostOnClose: true,
            userDataDir: userData,
            testRootPath: root,
            env: { CAXRI_E2E_AGENT_HOOKS: '1' },
        });
        await pageRequest(running.page, 'session.select', { sessionId: issued.sessionId });
        await expect(
            running.page.locator(`.terminal-pane[data-terminal-id="${receipt.terminalId}"]`),
        ).toBeVisible();
        const waited = await runCli(
            ['agent', 'delegate', 'wait', receipt.delegationId, '--timeout', '10000', '--json'],
            externalEnvironment,
        );
        expect(waited.code).toBe(0);
        expect(JSON.parse(waited.stdout)).toMatchObject({
            receipt: { status: 'completed' },
            answer: { text: 'Synthetic delegation complete' },
        });
        await running.app.close();
        running = undefined;
        await stopHost(userData);
        const restarted = await ensureServer(
            userData,
            { artifactRoot: serverArtifactRoot, environment: hostEnvironment },
            15_000,
        );
        restarted.close();
        const recovered = await runCli(
            ['agent', 'delegate', 'result', receipt.delegationId, '--json'],
            externalEnvironment,
        );
        expect(recovered.code).toBe(0);
        expect(JSON.parse(recovered.stdout)).toMatchObject({
            receipt: { status: 'completed' },
            answer: { text: 'Synthetic delegation complete' },
        });
        const revoked = await runCli(
            [
                'agent',
                'delegate',
                'access',
                'revoke',
                '--client',
                issued.clientId,
                '--generation',
                String(issued.generation),
                '--profile',
                userData,
                '--yes',
                '--json',
            ],
            ownerEnvironment,
        );
        expect(revoked.code).toBe(0);
        const denied = await runCli(
            ['agent', 'delegate', 'result', receipt.delegationId, '--json'],
            externalEnvironment,
        );
        expect(denied.code).not.toBe(0);
    } finally {
        await running?.app.close();
        await stopHost(userData);
        await rm(directory, { recursive: true, force: true });
    }
});

test('shares settings across an app-managed Server and Desktop', async () => {
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
        ...(process.env.CAXRI_E2E_WORKER_NAMESPACE && {
            CAXRI_E2E_WORKER_NAMESPACE: process.env.CAXRI_E2E_WORKER_NAMESPACE,
        }),
    };
    const environment = {
        ...hostEnvironment,
        CAXRI_USER_DATA_DIR: userData,
        UNSCOPED_SECRET_SENTINEL: unscopedSecret,
    };
    let running: Awaited<ReturnType<typeof launchCaxri>> | undefined;
    try {
        const headless = await ensureServer(
            userData,
            { artifactRoot: serverArtifactRoot, environment: hostEnvironment },
            15_000,
        );
        headless.close();
        const patched = await runCli(
            [
                'settings',
                'patch',
                '--set',
                // The shipped default is true. Exercise the real CLI transition from that default to false before the
                // Desktop toggles it back on and proves the value survives the app lifecycle.
                'terminal.osc52ClipboardWrite=false',
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
            value: { 'terminal.osc52ClipboardWrite': false },
        });

        const initialStatus = await runCli(
            ['host', 'status', '--profile', userData, '--json'],
            environment,
        );
        expect(initialStatus).toMatchObject({ code: 0, stderr: '' });
        const initialHost = JSON.parse(initialStatus.stdout) as {
            desktop: { state: string };
            pid: number;
        };
        expect(initialHost).toMatchObject({
            desktop: { state: 'offline' },
            pid: expect.any(Number),
        });

        running = await launchCaxri({
            preserveHostOnClose: true,
            userDataDir: userData,
            testRootPath: root,
        });
        await createShellSession(running.page);
        // Settings rows are virtualized, so reveal the Terminal section before querying its switch.
        const settingsTab = await openSettingsTab(running.page);
        await revealSettingsSection(settingsTab, 'Terminal');
        const clipboardSetting = settingsTab.getByRole('switch', {
            name: 'Let programs in the Terminal copy to your clipboard',
        });
        await expect(clipboardSetting).not.toBeChecked();
        await clipboardSetting.check();
        await expect(clipboardSetting).toBeChecked();
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
            .toBe(true);

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
            value: { 'terminal.osc52ClipboardWrite': true },
        });
        expect(JSON.parse(commands[3].stdout)).toMatchObject({ records: expect.any(Array) });
        expect(JSON.parse(commands[4].stdout)).toMatchObject({ runtimeStatus: 'ready' });
        expect(JSON.parse(commands[5].stdout)).toMatchObject({
            desktop: { state: 'offline' },
            pid: initialHost.pid,
        });
        expect(commands.map(({ stdout }) => stdout).join('\n')).not.toContain(unscopedSecret);
    } finally {
        try {
            await running?.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await stopHost(userData);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

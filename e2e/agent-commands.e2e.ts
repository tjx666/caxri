import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { discoverServerManifest, ServerClient } from '@caxri/client/supervise';
import { agentMessageReceiptSchema } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const cliPath = join(projectRoot, 'apps', 'cli', 'dist', 'caxri.cjs');

interface EndpointCapture {
    context: {
        endpoint: {
            ref: { hostId: string; endpointId: string; generation: number };
            projectId: string;
            sessionId: string;
            terminalId: string;
        };
    };
    credential: {
        hostId: string;
        endpointId: string;
        generation: number;
        token: string;
    };
    providerSessionId: string;
}

interface InputCapture {
    endpointId: string;
    hex: string;
    text: string;
}

async function jsonLines<T>(path: string): Promise<T[]> {
    try {
        return (await readFile(path, 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as T);
    } catch {
        return [];
    }
}

function runCli(
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stderr: string; stdout: string }> {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            [cliPath, ...arguments_],
            {
                /**
                 * Model a synthetic human caller independently of the runner's automation identity.
                 */
                env: {
                    ...process.env,
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
                    ...environment,
                },
                maxBuffer: 1024 * 1024,
                timeout: 10_000,
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

test('Agent dispatch, exact control, wake, and human steer remain separate', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-commands-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const capturePath = join(testDirectory, 'endpoint-captures.jsonl');
    const inputPath = join(testDirectory, 'terminal-input.jsonl');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version')) {
  process.stdout.write('claude-agent-commands-test 1.0\n');
  process.exit(0);
}
const invocation = spawnSync(process.execPath, [${JSON.stringify(cliPath)}, 'agent-context', '--json'], {
  encoding: 'utf8',
  env: process.env,
});
if (invocation.status !== 0) {
  process.stderr.write(invocation.stderr);
  process.exit(invocation.status || 1);
}
const context = JSON.parse(invocation.stdout);
const endpointId = process.env.CAXRI_AGENT_ENDPOINT_ID;
const providerSessionId = 'provider-' + endpointId;
const sessions = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions');
fs.mkdirSync(sessions, { recursive: true });
const now = Date.now();
fs.writeFileSync(path.join(sessions, endpointId + '.json'), JSON.stringify({
  cwd: process.cwd(),
  name: 'Command Agent',
  sessionId: providerSessionId,
  startedAt: now,
  updatedAt: now,
  status: 'busy',
}));
// A restart resumes only a conversation Claude Code has written to disk.
const transcripts = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replaceAll(/[^a-z0-9]/gi, '-'));
fs.mkdirSync(transcripts, { recursive: true });
fs.appendFileSync(path.join(transcripts, providerSessionId + '.jsonl'), '{}\n');
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  context,
  credential: {
    hostId: process.env.CAXRI_AGENT_ENDPOINT_HOST_ID,
    endpointId,
    generation: Number(process.env.CAXRI_AGENT_ENDPOINT_GENERATION),
    token: process.env.CAXRI_AGENT_ENDPOINT_TOKEN,
  },
  providerSessionId,
}) + '\n');
process.stdin.setRawMode?.(true);
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(${JSON.stringify(inputPath)}, JSON.stringify({
    endpointId,
    hex: chunk.toString('hex'),
    text: chunk.toString('utf8'),
  }) + '\n');
  process.stdout.write('HUMAN-STEER:' + chunk.toString('utf8') + '\r\n');
});
process.stdout.write('Command Agent ready ' + endpointId + '\r\n');
process.stdin.resume();
`,
            },
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    let controller: ServerClient | undefined;
    let awakened: ServerClient | undefined;
    try {
        const sessionId = await createProjectSession(running.page, 'claude');
        await expect
            .poll(async () => (await jsonLines<EndpointCapture>(capturePath)).length)
            .toBe(1);
        const controllerCapture = (await jsonLines<EndpointCapture>(capturePath)).at(0);
        if (!controllerCapture) throw new Error('Controller Endpoint capture missing');
        const manifest = await discoverServerManifest(userData);
        controller = await ServerClient.connect(manifest, 2_000, {
            kind: 'agent',
            ...controllerCapture.credential,
        });

        expect(controller.welcome.commands).toContain('agent.dispatch.status');
        expect(controller.welcome.commands).not.toContain('agent.dispatch.start');
        expect(controller.welcome.commands).not.toContain('agent.control.stop');
        expect(controller.welcome.commands).not.toContain('terminal.send');
        await expect(
            controller.request('agent.dispatch.start', {
                projectId: controllerCapture.context.endpoint.projectId,
                sessionId,
                provider: 'claude',
            }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });

        await pageRequest(running.page, 'agent.grant', {
            endpoint: controllerCapture.context.endpoint.ref,
            policy: 'agent:control',
            ttlMs: 60_000,
        });
        const dispatchInput = {
            projectId: controllerCapture.context.endpoint.projectId,
            sessionId,
            provider: 'claude' as const,
        };
        const firstDispatch = await controller.requestWithId(
            'dispatch-idempotent',
            'agent.dispatch.start',
            dispatchInput,
        );
        const duplicateDispatch = await controller.requestWithId(
            'dispatch-idempotent',
            'agent.dispatch.start',
            dispatchInput,
        );
        expect(duplicateDispatch).toEqual(firstDispatch);
        expect(firstDispatch).toMatchObject({
            dispatchId: expect.stringMatching(/^dispatch-[0-9a-f]{64}$/u),
            operation: 'start',
            status: 'running',
            terminalId: expect.any(String),
            endpoint: expect.objectContaining({ generation: 1 }),
        });
        expect(firstDispatch.dispatchId).not.toBe('dispatch-idempotent');
        await expect
            .poll(async () => (await jsonLines<EndpointCapture>(capturePath)).length)
            .toBe(2);
        const firstTarget = (await jsonLines<EndpointCapture>(capturePath)).at(1);
        if (!firstTarget || !firstDispatch.terminalId || !firstDispatch.endpoint)
            throw new Error('Dispatched Endpoint capture missing');
        expect(firstTarget.context.endpoint.terminalId).toBe(firstDispatch.terminalId);
        await expect
            .poll(async () => {
                const state = await pageRequest<{
                    terminals: Array<{ agentSessionId?: string; id: string }>;
                }>(running.page, 'app.bootstrap');
                return state.terminals.find(({ id }) => id === firstDispatch.terminalId)
                    ?.agentSessionId;
            })
            .toBe(firstTarget.providerSessionId);

        const lifecycleWait = controller.request('agent.dispatch.wait', {
            dispatchId: firstDispatch.dispatchId,
            afterRevision: firstDispatch.revision,
            timeoutMs: 5_000,
        });
        await pageRequest(running.page, 'terminal.restart', {
            terminalId: firstDispatch.terminalId,
            mode: 'resume',
        });
        await expect(lifecycleWait).resolves.toMatchObject({
            outcome: 'changed',
            receipt: { status: 'interrupted' },
        });
        await expect
            .poll(async () => (await jsonLines<EndpointCapture>(capturePath)).length)
            .toBe(3);
        const currentTarget = (await jsonLines<EndpointCapture>(capturePath)).at(2);
        if (!currentTarget) throw new Error('Restarted Endpoint capture missing');
        await expect(
            controller.request('agent.control.interrupt', { endpoint: firstDispatch.endpoint }),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        await expect
            .poll(async () => {
                const state = await pageRequest<{
                    terminals: Array<{
                        id: string;
                        lastAgentProcessState?: string;
                        lastProcessState: string;
                    }>;
                }>(running.page, 'app.bootstrap');
                const terminal = state.terminals.find(({ id }) => id === firstDispatch.terminalId);
                return {
                    agent: terminal?.lastAgentProcessState,
                    shell: terminal?.lastProcessState,
                };
            })
            .toEqual({ agent: 'running', shell: 'running' });

        const humanText = 'terminal-human-steer sentinel';
        const ownerCli = await runCli([
            'terminal',
            'send',
            '--terminal',
            controllerCapture.context.endpoint.terminalId,
            '--text',
            humanText,
            '--enter',
            '--profile',
            userData,
            '--yes',
            '--json',
        ]);
        expect(ownerCli).toMatchObject({ code: 0, stderr: '' });
        expect(JSON.parse(ownerCli.stdout)).toMatchObject({ accepted: true, enter: true });
        await expect(running.page.locator('.xterm-rows')).toContainText(humanText);
        const deniedText = 'agent-steer-must-be-denied';
        const deniedCli = await runCli(
            [
                'terminal',
                'send',
                '--terminal',
                controllerCapture.context.endpoint.terminalId,
                '--text',
                deniedText,
                '--enter',
                '--profile',
                userData,
                '--yes',
                '--json',
            ],
            {
                CAXRI_AGENT_ENDPOINT_HOST_ID: controllerCapture.credential.hostId,
                CAXRI_AGENT_ENDPOINT_ID: controllerCapture.credential.endpointId,
                CAXRI_AGENT_ENDPOINT_GENERATION: String(controllerCapture.credential.generation),
                CAXRI_AGENT_ENDPOINT_TOKEN: controllerCapture.credential.token,
                CAXRI_USER_DATA_DIR: userData,
            },
        );
        expect(deniedCli.code).not.toBe(0);
        expect(JSON.parse(deniedCli.stderr)).toMatchObject({ code: 'FORBIDDEN' });

        await expect(
            controller.request('agent.control.stop', {
                endpoint: currentTarget.context.endpoint.ref,
            }),
        ).resolves.toMatchObject({ outcome: 'signaled' });
        await expect
            .poll(async () => {
                const state = await pageRequest<{
                    terminals: Array<{
                        id: string;
                        lastAgentProcessState?: string;
                        lastProcessState: string;
                    }>;
                }>(running.page, 'app.bootstrap');
                const terminal = state.terminals.find(({ id }) => id === firstDispatch.terminalId);
                return Boolean(
                    terminal?.lastAgentProcessState &&
                    terminal.lastAgentProcessState !== 'running' &&
                    terminal.lastProcessState === 'running',
                );
            })
            .toBe(true);

        const unavailable = await controller.request('agent.message.send', {
            to: currentTarget.context.endpoint.ref,
            body: 'ordinary stopped delivery',
        });
        expect(unavailable.status).toBe('unavailable');
        const wakeBody = 'agent-message-wake peer sentinel';
        const wakeInput = {
            to: currentTarget.context.endpoint.ref,
            body: wakeBody,
            wake: true,
        };
        const wakeReceipt = agentMessageReceiptSchema.parse(
            await controller.requestWithId('wake-idempotent', 'agent.message.send', wakeInput),
        );
        const duplicateWake = await controller.requestWithId(
            'wake-idempotent',
            'agent.message.send',
            wakeInput,
        );
        expect(duplicateWake).toEqual(wakeReceipt);
        expect(wakeReceipt).toMatchObject({
            dispatchId: expect.stringMatching(/^dispatch-[0-9a-f]{64}$/u),
            status: 'waiting',
        });
        await expect
            .poll(async () => (await jsonLines<EndpointCapture>(capturePath)).length)
            .toBe(4);
        const awakenedTarget = (await jsonLines<EndpointCapture>(capturePath)).at(3);
        if (!awakenedTarget) throw new Error('Awakened Endpoint capture missing');
        awakened = await ServerClient.connect(manifest, 2_000, {
            kind: 'agent',
            ...awakenedTarget.credential,
        });
        await expect(
            awakened.request('agent.message.wait', { timeoutMs: 1_000 }),
        ).resolves.toMatchObject({
            outcome: 'message',
            message: { body: wakeBody, origin: 'peer' },
        });
        await expect(
            controller.request('agent.dispatch.status', { dispatchId: wakeReceipt.dispatchId! }),
        ).resolves.toMatchObject({ operation: 'wake', status: 'running' });

        const [inputs, hostLog] = await Promise.all([
            jsonLines<InputCapture>(inputPath),
            readFile(join(userData, 'logs', 'server-core.jsonl'), 'utf8'),
        ]);
        expect(inputs.some(({ text }) => text.includes(`${humanText}\r`))).toBe(true);
        expect(inputs.some(({ text }) => text.includes(deniedText))).toBe(false);
        expect(inputs.some(({ text }) => text.includes(wakeBody))).toBe(false);
        await expect(running.page.locator('.xterm-rows')).not.toContainText(wakeBody);
        expect(hostLog).not.toContain(humanText);
        expect(hostLog).not.toContain(wakeBody);
        expect(hostLog).not.toContain(firstTarget.providerSessionId);
    } finally {
        controller?.close();
        awakened?.close();
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxri,
    openSettingsTab,
    pageRequest,
    revealSettingsSection,
} from './support/helpers.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const cliPath = join(projectRoot, 'apps', 'cli', 'dist', 'caxri.cjs');

interface CliResult {
    code: number;
    stderr: string;
    stdout: string;
}

interface EndpointCapture {
    context: {
        endpoint: {
            projectId: string;
            ref: { endpointId: string; generation: number; hostId: string };
            sessionId: string;
            terminalId: string;
        };
    };
    credential: {
        endpointId: string;
        generation: number;
        hostId: string;
        token: string;
    };
}

function runCli(
    arguments_: readonly string[],
    options: { cwd: string; environment?: NodeJS.ProcessEnv },
): Promise<CliResult> {
    return new Promise((resolve) => {
        const environment = { ...process.env, ...options.environment };
        for (const key of [
            'CAXRI_AGENT_ENDPOINT_HOST_ID',
            'CAXRI_AGENT_ENDPOINT_ID',
            'CAXRI_AGENT_ENDPOINT_GENERATION',
            'CAXRI_AGENT_ENDPOINT_TOKEN',
        ]) {
            if (options.environment?.[key] === undefined) delete environment[key];
        }
        execFile(
            process.execPath,
            [cliPath, ...arguments_],
            { cwd: options.cwd, env: environment, maxBuffer: 2 * 1024 * 1024, timeout: 15_000 },
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

async function captures(path: string): Promise<EndpointCapture[]> {
    try {
        return (await readFile(path, 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as EndpointCapture);
    } catch {
        return [];
    }
}

function endpointEnvironment(
    capture: EndpointCapture,
    userData: string,
    base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
    return {
        ...base,
        CAXRI_AGENT_ENDPOINT_GENERATION: String(capture.credential.generation),
        CAXRI_AGENT_ENDPOINT_HOST_ID: capture.credential.hostId,
        CAXRI_AGENT_ENDPOINT_ID: capture.credential.endpointId,
        CAXRI_AGENT_ENDPOINT_TOKEN: capture.credential.token,
        CAXRI_USER_DATA_DIR: userData,
    };
}

function endpointReference(capture: EndpointCapture): string {
    const { endpointId, generation, hostId } = capture.context.endpoint.ref;
    return `${hostId}:${endpointId}:${generation}`;
}

test('versioned Agent skill works offline and drives scoped business, debug, and peer pull workflows', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-skill-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const capturePath = join(testDirectory, 'endpoint-captures.jsonl');
    const terminalInputPath = join(testDirectory, 'terminal-input.bin');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-agent-skill-test 1.0\n');
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
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  context: JSON.parse(invocation.stdout),
  credential: {
    hostId: process.env.CAXRI_AGENT_ENDPOINT_HOST_ID,
    endpointId: process.env.CAXRI_AGENT_ENDPOINT_ID,
    generation: Number(process.env.CAXRI_AGENT_ENDPOINT_GENERATION),
    token: process.env.CAXRI_AGENT_ENDPOINT_TOKEN,
  },
}) + '\n');
process.stdin.on('data', (chunk) => fs.appendFileSync(${JSON.stringify(terminalInputPath)}, chunk));
process.stdout.write('Skill Agent ready\r\n');
process.stdin.resume();
`,
            },
        },
    });
    let running: Awaited<ReturnType<typeof launchCaxri>> | undefined;
    try {
        const offlineEnvironment = { ...agentMode.environment, CAXRI_USER_DATA_DIR: userData };
        const foreignSkill = join(root, '.agents', 'skills', 'foreign-skill', 'SKILL.md');
        await mkdir(resolve(foreignSkill, '..'), { recursive: true });
        await writeFile(foreignSkill, 'foreign skill\n', 'utf8');
        const offline = await runCli(['skills', 'get', 'caxri-cli', '--full', '--json'], {
            cwd: root,
            environment: offlineEnvironment,
        });
        expect(offline).toMatchObject({ code: 0, stderr: '' });
        const bundled = JSON.parse(offline.stdout) as {
            bundledVersion: string;
            content: string;
            contentHash: string;
        };
        expect(bundled.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(bundled.content).toContain('caxri agent-context --json');
        expect(bundled.content).not.toContain(userData);

        const installArguments = [
            'skills',
            'install',
            'caxri-cli',
            '--provider',
            'codex',
            '--local',
            '--yes',
            '--json',
        ] as const;
        const installed = await runCli(installArguments, {
            cwd: root,
            environment: offlineEnvironment,
        });
        const repeated = await runCli(installArguments, {
            cwd: root,
            environment: offlineEnvironment,
        });
        expect(JSON.parse(installed.stdout)).toMatchObject({ changed: true });
        expect(JSON.parse(repeated.stdout)).toMatchObject({ changed: false });
        expect(await readFile(foreignSkill, 'utf8')).toBe('foreign skill\n');

        const markerPath = join(root, '.agents', 'skills', 'caxri-cli', '.caxri-skill.json');
        const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
        marker.schemaVersion = 99;
        marker.installedVersion = '99.0.0';
        await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
        const conflict = await runCli(
            ['skills', 'status', '--provider', 'codex', '--local', '--json'],
            { cwd: root, environment: offlineEnvironment },
        );
        expect(JSON.parse(conflict.stdout)).toMatchObject({
            installations: [
                {
                    installedSchemaVersion: 99,
                    reason: 'unknown-schema',
                    status: 'conflict',
                },
            ],
        });

        running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
        const sessionId = await createProjectSession(running.page, 'codex');
        const settingsTab = await openSettingsTab(running.page);
        await revealSettingsSection(settingsTab, 'Codex');
        const codexSkill = settingsTab.locator('[data-agent-skill-health="codex"]');
        await expect(codexSkill).toContainText(`Bundled v${bundled.bundledVersion}`);
        await expect(codexSkill.locator('[data-agent-skill-scope="local"]')).toContainText(
            'Project local · Conflict · installed v99.0.0',
        );
        await expect(codexSkill.locator('[data-agent-skill-scope="local"]')).toContainText(
            'Use a Caxri CLI that supports installed marker schema 99',
        );
        const globalSkill = codexSkill.locator('[data-agent-skill-scope="global"]');
        await expect(globalSkill).toContainText('Global · Missing · not installed');
        await expect(globalSkill.locator('code')).toHaveText(
            'caxri skills install caxri-cli --provider codex --global --yes',
        );
        // Settings is a Workbench tab now, not a modal (issue caxri#1289): `Cmd+W` closes it
        // outright — there is no "Close" button to click anymore.
        await running.page.keyboard.press('Meta+w');
        await expect(settingsTab).toHaveCount(0);
        await pageRequest(running.page, 'terminal.create', { sessionId, kind: 'codex' });
        await expect.poll(async () => (await captures(capturePath)).length).toBe(2);
        await expect(running.page.locator('.xterm-rows')).toContainText('Skill Agent ready');
        // `.at()` (not array destructuring, which types both bindings as always-defined) types
        // each capture as possibly `undefined`: the `.poll(...).toBe(2)` above is a runtime
        // expectation, not a type-level guarantee that the array actually has 2 entries.
        const skillCaptures = await captures(capturePath);
        const first = skillCaptures.at(0);
        const second = skillCaptures.at(1);
        if (!first || !second) throw new Error('Skill Agent Endpoint captures are missing');
        await pageRequest(running.page, 'agent.grant', {
            endpoint: first.context.endpoint.ref,
            policy: 'debug:read',
            ttlMs: 60_000,
        });
        await pageRequest(running.page, 'agent.grant', {
            endpoint: first.context.endpoint.ref,
            policy: 'business:write',
            ttlMs: 60_000,
        });
        const firstEnvironment = endpointEnvironment(first, userData, agentMode.environment);
        const secondEnvironment = endpointEnvironment(second, userData, agentMode.environment);

        const context = await runCli(['agent-context', '--json'], {
            cwd: root,
            environment: firstEnvironment,
        });
        const status = await runCli(['status', '--json'], {
            cwd: root,
            environment: firstEnvironment,
        });
        const capabilities = await runCli(['capabilities', '--json'], {
            cwd: root,
            environment: firstEnvironment,
        });
        expect([context.code, status.code, capabilities.code]).toEqual([0, 0, 0]);
        expect(JSON.parse(context.stdout)).toMatchObject({
            capabilities: expect.arrayContaining(['settings.write', 'diagnostics.read']),
            endpoint: { projectId: first.context.endpoint.projectId },
            status: 'active',
        });
        expect(JSON.parse(status.stdout)).toMatchObject({
            principal: { endpointId: first.credential.endpointId, kind: 'agent' },
            status: 'ready',
        });
        expect(status.stdout).not.toContain('profileId');
        expect(JSON.parse(capabilities.stdout)).toMatchObject({
            endpoint: {
                capabilities: expect.arrayContaining(['settings.write', 'diagnostics.read']),
            },
        });

        const project = await runCli(['project', 'current', '--json'], {
            cwd: root,
            environment: firstEnvironment,
        });
        const settings = await runCli(
            ['settings', 'validate', '--set', 'terminal.scrollback=10000', '--json'],
            { cwd: root, environment: firstEnvironment },
        );
        const diagnostics = await runCli(['diagnostics', 'snapshot', '--json'], {
            cwd: root,
            environment: firstEnvironment,
        });
        expect(JSON.parse(project.stdout)).toMatchObject({
            projects: [{ id: first.context.endpoint.projectId }],
            view: 'agent',
        });
        expect(JSON.parse(settings.stdout)).toMatchObject({ dryRun: true, errors: [] });
        expect(JSON.parse(diagnostics.stdout)).toMatchObject({ runtimeStatus: 'ready' });

        const body = 'skill-peer-pull-sentinel';
        const sent = await runCli(
            [
                'agent',
                'message',
                'send',
                '--to',
                endpointReference(second),
                '--body',
                body,
                '--request-id',
                'skill-peer-send',
                '--json',
            ],
            { cwd: root, environment: firstEnvironment },
        );
        const sentReceipt = JSON.parse(sent.stdout) as { messageId: string; status: string };
        expect(sentReceipt.status).toBe('waiting');
        expect(sent.stdout).not.toContain(body);

        const pulled = await runCli(['agent', 'message', 'wait', '--timeout', '30000', '--json'], {
            cwd: root,
            environment: secondEnvironment,
        });
        const pulledValue = JSON.parse(pulled.stdout) as {
            message: {
                body: string;
                from: { ref: { endpointId: string; generation: number; hostId: string } };
                id: string;
                origin: string;
            };
            outcome: string;
        };
        expect(pulledValue).toMatchObject({
            message: { body, origin: 'peer' },
            outcome: 'message',
        });
        const empty = await runCli(['agent', 'message', 'check', '--json'], {
            cwd: root,
            environment: secondEnvironment,
        });
        expect(JSON.parse(empty.stdout)).toEqual({ message: null, outcome: 'empty' });

        const from = pulledValue.message.from.ref;
        const replyTarget = `${from.hostId}:${from.endpointId}:${from.generation}`;
        const replyBody = 'skill-peer-reply-sentinel';
        const replied = await runCli(
            [
                'agent',
                'message',
                'reply',
                '--to',
                replyTarget,
                '--reply-to',
                pulledValue.message.id,
                '--body',
                replyBody,
                '--request-id',
                'skill-peer-reply',
                '--json',
            ],
            { cwd: root, environment: secondEnvironment },
        );
        expect(JSON.parse(replied.stdout)).toMatchObject({ replyTo: pulledValue.message.id });
        const reply = await runCli(['agent', 'message', 'wait', '--timeout', '30000', '--json'], {
            cwd: root,
            environment: firstEnvironment,
        });
        expect(JSON.parse(reply.stdout)).toMatchObject({
            message: { body: replyBody, origin: 'peer', replyTo: pulledValue.message.id },
            outcome: 'message',
        });
        const receipt = await runCli(
            ['agent', 'message', 'receipt', sentReceipt.messageId, '--json'],
            { cwd: root, environment: firstEnvironment },
        );
        expect(JSON.parse(receipt.stdout)).toMatchObject({ status: 'delivered' });
        let terminalInput: Buffer;
        try {
            terminalInput = await readFile(terminalInputPath);
        } catch {
            terminalInput = Buffer.alloc(0);
        }
        expect(terminalInput.includes(Buffer.from(body))).toBe(false);
        expect(terminalInput.includes(Buffer.from(replyBody))).toBe(false);
    } finally {
        try {
            await running?.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { force: true, recursive: true });
    }
});

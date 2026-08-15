import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { discoverHostManifest, HostClient } from '@caxri/cli';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    typeTerminal,
} from './support/helpers.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const cliPath = join(projectRoot, 'packages', 'cli', 'dist', 'caxri.cjs');

interface EndpointCapture {
    context: {
        status: 'active';
        endpoint: {
            ref: { hostId: string; endpointId: string; generation: number };
            projectId: string;
            sessionId: string;
            terminalId: string;
            provider: string;
        };
        capabilities: string[];
        grants: unknown[];
    };
    credential: {
        hostId: string;
        endpointId: string;
        generation: number;
        token: string;
    };
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

test('direct Agent Endpoint is scoped, grantable, private, and fenced on restart', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-endpoint-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const capturePath = join(testDirectory, 'endpoint-captures.jsonl');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-test 1.0\n');
  process.exit(0);
}
const invocation = spawnSync(process.execPath, [${JSON.stringify(cliPath)}, 'agent-context', '--json'], {
  encoding: 'utf8',
  env: process.env,
});
const context = JSON.parse(invocation.stdout);
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  context,
  credential: {
    hostId: process.env.CAXRI_AGENT_ENDPOINT_HOST_ID,
    endpointId: process.env.CAXRI_AGENT_ENDPOINT_ID,
    generation: Number(process.env.CAXRI_AGENT_ENDPOINT_GENERATION),
    token: process.env.CAXRI_AGENT_ENDPOINT_TOKEN,
  },
}) + '\n');
process.stdout.write('Agent Endpoint ' + context.status + ' generation ' + context.endpoint.ref.generation + '\r\n');
process.stdin.resume();
`,
            },
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const sessionId = await createProjectSession(running.page, 'codex');
        await expect(running.page.locator('.xterm-rows')).toContainText(
            'Agent Endpoint active generation 1',
        );
        await expect.poll(async () => (await captures(capturePath)).length).toBe(1);
        const first = (await captures(capturePath))[0];
        expect(first.context).toMatchObject({
            status: 'active',
            endpoint: {
                projectId: expect.any(String),
                sessionId,
                terminalId: expect.any(String),
                provider: 'codex',
                ref: { generation: 1 },
            },
            grants: [],
        });
        expect(JSON.stringify(first.context)).not.toContain(first.credential.token);
        const agent = await HostClient.connect(await discoverHostManifest(userData), 2_000, {
            kind: 'agent',
            ...first.credential,
        });
        await expect(agent.request('diagnostics.snapshot')).rejects.toMatchObject({
            code: 'FORBIDDEN',
        });
        await pageRequest(running.page, 'agent.grant', {
            endpoint: first.context.endpoint.ref,
            policy: 'debug:read',
            ttlMs: 60_000,
        });
        await expect(agent.request('diagnostics.snapshot')).resolves.toMatchObject({
            runtimeStatus: 'ready',
        });

        await pageRequest(running.page, 'terminal.restart', {
            terminalId: first.context.endpoint.terminalId,
            mode: 'fresh',
        });
        await expect.poll(async () => (await captures(capturePath)).length).toBe(2);
        const second = (await captures(capturePath))[1];
        expect(second.context.endpoint.ref).toMatchObject({ generation: 2 });
        expect(second.context.grants).toEqual([]);
        await expect(agent.request('agent.context')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        agent.close();

        const [database, hostLog, runtimeLog, snapshot] = await Promise.all([
            readFile(join(userData, 'caxri.db')),
            readFile(join(userData, 'logs', 'host.jsonl'), 'utf8'),
            readFile(join(userData, 'logs', 'runtime.jsonl'), 'utf8'),
            pageRequest<{ payload: string }>(running.page, 'terminal.snapshot', {
                terminalId: second.context.endpoint.terminalId,
            }),
        ]);
        for (const token of [first.credential.token, second.credential.token]) {
            expect(database.includes(Buffer.from(token))).toBe(false);
            expect(hostLog).not.toContain(token);
            expect(runtimeLog).not.toContain(token);
            expect(snapshot.payload).not.toContain(token);
        }
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Shell-promoted Agent has no managed Endpoint credential', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-shell-endpoint-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const claudeState = join(userData, 'e2e-agents', 'claude', 'sessions');
    await Promise.all([mkdir(root, { recursive: true }), mkdir(claudeState, { recursive: true })]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: String.raw`#!/bin/zsh
if [ "$1" = "--version" ]; then
  printf 'claude-test 1.0\n'
  exit 0
fi
"${process.execPath}" ${JSON.stringify(cliPath)} agent-context --json
now_ms="$(date +%s)999"
printf '{"cwd":${JSON.stringify(root)},"name":"Shell Claude","sessionId":"shell-agent","startedAt":%s,"updatedAt":%s,"status":"busy"}\n' "$now_ms" "$now_ms" > "$CLAUDE_CONFIG_DIR/sessions/current.json"
exec -a claude /bin/zsh -c 'while :; do printf "shell-agent-tick\n"; sleep 1; done'
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: { SHELL: '/bin/zsh' },
    });
    try {
        await createShellSession(running.page);
        await typeTerminal(running.page, 'claude');
        await expect(running.page.locator('.xterm-rows')).toContainText(
            '"reason":"endpoint-credential-missing"',
        );
        await expect(running.page.getByRole('tab', { name: 'Claude Code' })).toBeVisible();
        await expect
            .poll(async () => {
                const state = await pageRequest<{ terminals: Array<{ kind: string }> }>(
                    running.page,
                    'app.bootstrap',
                );
                return state.terminals[0]?.kind;
            })
            .toBe('claude');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

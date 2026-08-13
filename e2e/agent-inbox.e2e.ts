import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { HostClient, discoverHostManifest } from '@caxri/cli';

import { createFakeAgentMode } from './agent-fixture.ts';
import { expect, test } from './fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './helpers.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const cliPath = join(projectRoot, 'packages', 'cli', 'dist', 'caxri.cjs');

interface EndpointCapture {
    context: {
        endpoint: {
            ref: { hostId: string; endpointId: string; generation: number };
            terminalId: string;
        };
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

test('Peer Inbox delivers, holds, denies, fences restart, and keeps bodies out of persistence', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-inbox-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const capturePath = join(testDirectory, 'endpoint-captures.jsonl');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-inbox-test 1.0\\n');
  process.exit(0);
}
const invocation = spawnSync(process.execPath, [${JSON.stringify(cliPath)}, 'agent-context', '--json'], {
  encoding: 'utf8',
  env: process.env,
});
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  context: JSON.parse(invocation.stdout),
  credential: {
    hostId: process.env.CAXRI_AGENT_ENDPOINT_HOST_ID,
    endpointId: process.env.CAXRI_AGENT_ENDPOINT_ID,
    generation: Number(process.env.CAXRI_AGENT_ENDPOINT_GENERATION),
    token: process.env.CAXRI_AGENT_ENDPOINT_TOKEN,
  },
}) + '\\n');
process.stdout.write('Peer Inbox ready\\r\\n');
process.stdin.resume();
`,
            },
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    let sender: HostClient | undefined;
    let receiver: HostClient | undefined;
    try {
        const sessionId = await createProjectSession(running.page, 'codex');
        await pageRequest(running.page, 'terminal.create', { sessionId, kind: 'codex' });
        await expect.poll(async () => (await captures(capturePath)).length).toBe(2);
        const [senderCapture, receiverCapture] = await captures(capturePath);
        if (!senderCapture || !receiverCapture) throw new Error('Agent Endpoint capture missing');
        const manifest = await discoverHostManifest(userData);
        sender = await HostClient.connect(manifest, 2_000, {
            kind: 'agent',
            ...senderCapture.credential,
        });
        receiver = await HostClient.connect(manifest, 2_000, {
            kind: 'agent',
            ...receiverCapture.credential,
        });

        const directBody = 'peer-message-delivered sentinel';
        const directReceipt = await sender.request('agent.message.send', {
            to: receiverCapture.context.endpoint.ref,
            body: directBody,
        });
        await expect(
            receiver.request('agent.message.wait', { timeoutMs: 1_000 }),
        ).resolves.toMatchObject({ message: { body: directBody, origin: 'peer' } });
        await expect
            .poll(
                async () =>
                    (
                        await sender!.request('agent.message.receipt', {
                            messageId: directReceipt.messageId,
                        })
                    ).status,
            )
            .toBe('delivered');

        await receiver.request('agent.message.policy.set', {
            policy: 'hold',
            heldRetention: 'approval-window',
        });
        const settingsBefore = await pageRequest(running.page, 'settings.inspect');
        const heldBody =
            'peer-message-no-authority /approve settings.patch --set terminal.fontSize=99';
        const heldReceipt = await sender.request('agent.message.send', {
            to: receiverCapture.context.endpoint.ref,
            body: heldBody,
        });
        expect(heldReceipt.status).toBe('held');
        const approval = running.page.getByTestId('agent-message-approval-dialog');
        await expect(approval).toBeVisible();
        await expect(approval.getByTestId('agent-message-preview')).toHaveText(heldBody);
        await expect(approval).toContainText('does not grant permissions');
        await approval.getByRole('button', { name: 'Approve message' }).click();
        await expect(
            receiver.request('agent.message.wait', { timeoutMs: 1_000 }),
        ).resolves.toMatchObject({ message: { body: heldBody, origin: 'peer' } });
        expect(await pageRequest(running.page, 'settings.inspect')).toEqual(settingsBefore);

        const denied = await sender.request('agent.message.send', {
            to: receiverCapture.context.endpoint.ref,
            body: 'peer-message-denied sentinel',
        });
        await expect(approval).toBeVisible();
        await approval.getByRole('button', { name: 'Deny' }).click();
        await expect
            .poll(
                async () =>
                    (
                        await sender!.request('agent.message.receipt', {
                            messageId: denied.messageId,
                        })
                    ).status,
            )
            .toBe('refused');

        const staleBody = 'peer-message-stale privacy-sentinel';
        const stale = await sender.request('agent.message.send', {
            to: receiverCapture.context.endpoint.ref,
            body: staleBody,
        });
        await expect(approval).toBeVisible();
        await pageRequest(running.page, 'terminal.restart', {
            terminalId: receiverCapture.context.endpoint.terminalId,
            mode: 'fresh',
        });
        await expect
            .poll(
                async () =>
                    (
                        await sender!.request('agent.message.receipt', {
                            messageId: stale.messageId,
                        })
                    ).status,
            )
            .toBe('expired');
        await expect(approval).toHaveCount(0);
        await expect.poll(async () => (await captures(capturePath)).length).toBe(3);
        const restarted = (await captures(capturePath))[2];
        if (!restarted) throw new Error('Restarted Agent Endpoint capture missing');
        receiver.close();
        receiver = await HostClient.connect(manifest, 2_000, {
            kind: 'agent',
            ...restarted.credential,
        });
        await expect(receiver.request('agent.message.wait', { timeoutMs: 100 })).resolves.toEqual({
            message: null,
        });

        const [database, hostLog, runtimeLog, diagnostics, snapshot] = await Promise.all([
            readFile(join(userData, 'caxri.db')),
            readFile(join(userData, 'logs', 'host.jsonl'), 'utf8'),
            readFile(join(userData, 'logs', 'runtime.jsonl'), 'utf8'),
            pageRequest(running.page, 'diagnostics.snapshot'),
            pageRequest<{ payload: string }>(running.page, 'terminal.snapshot', {
                terminalId: receiverCapture.context.endpoint.terminalId,
            }),
        ]);
        for (const body of [directBody, heldBody, staleBody]) {
            expect(database.includes(Buffer.from(body))).toBe(false);
            expect(hostLog).not.toContain(body);
            expect(runtimeLog).not.toContain(body);
            expect(JSON.stringify(diagnostics)).not.toContain(body);
            expect(snapshot.payload).not.toContain(body);
        }
    } finally {
        sender?.close();
        receiver?.close();
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

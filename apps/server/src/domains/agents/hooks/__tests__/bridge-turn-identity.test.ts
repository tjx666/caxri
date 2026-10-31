import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { stageAgentHookBridge } from '../bridge';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Every payload carries every provider's turn key with a distinct value, so reading another provider's key shows.
 */
const everyTurnKey = {
    prompt_id: 'claude-prompt-id',
    turn_id: 'codex-turn-id',
    turnId: 'codex-camel-turn-id',
    promptId: 'grok-prompt-id',
};

/**
 * Keyed by `AgentProvider` so a newly catalogued provider fails to compile here until its turn key is pinned.
 */
const ownTurnId: Record<AgentProvider, string | undefined> = {
    claude: 'claude-prompt-id',
    codex: 'codex-turn-id',
    grok: 'grok-prompt-id',
    // Antigravity names no turn, so no other provider's key may stand in for one.
    antigravity: undefined,
};

async function deliver(
    provider: AgentProvider,
    payload: Record<string, unknown>,
    phase = 'turnStarted',
    environment: Record<string, string> = {},
): Promise<Array<Record<string, unknown>>> {
    const sharedPath = await mkdtemp(join(tmpdir(), 'caxri-turn-bridge-'));
    temporaryDirectories.push(sharedPath);
    const bridgePath = await stageAgentHookBridge(sharedPath);
    const socketPath = join(sharedPath, 'turn.sock');
    const packets: Array<Record<string, unknown>> = [];
    const server = createServer((socket) => {
        socket.setEncoding('utf8');
        let source = '';
        socket.on('data', (chunk: string) => {
            source += chunk;
        });
        socket.on('end', () => {
            packets.push(JSON.parse(source) as Record<string, unknown>);
            socket.end('{"ok":true}\n');
        });
    });
    server.listen(socketPath);
    await once(server, 'listening');
    try {
        const invocation = execFileAsync(bridgePath, ['--provider', provider, '--phase', phase], {
            env: {
                CAXRI_HOOK_LAUNCH_ID: 'turn-launch',
                CAXRI_HOOK_RUNTIME: process.execPath,
                CAXRI_HOOK_SOCKET: socketPath,
                CAXRI_HOOK_TERMINAL_ID: 'turn-terminal',
                CAXRI_HOOK_TOKEN: 'turn-token',
                PATH: process.env.PATH,
                ...environment,
            },
        });
        /**
         * An oversized payload is truncated and the bridge stops reading, so the unfinished write ends in `EPIPE`.
         */
        invocation.child.stdin?.on('error', (cause: NodeJS.ErrnoException) => {
            if (cause.code !== 'EPIPE') throw cause;
        });
        invocation.child.stdin?.end(JSON.stringify(payload));
        await invocation;
        return packets;
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

describe('hook bridge turn identity', () => {
    it.each(agentProviderIds)(
        'reads the %s turn identity from its own payload key',
        async (provider) => {
            const packets = await deliver(provider, {
                session_id: 'fixture-session',
                // Antigravity forwards only a main conversation's first model call.
                lastUserInput: 'fixture prompt',
                invocationNum: 0,
                ...everyTurnKey,
            });
            expect(packets).toHaveLength(1);
            expect(packets[0]?.agentTurnId).toBe(ownTurnId[provider]);
        },
    );

    it('falls back to the camel-case Codex turn key', async () => {
        const packets = await deliver('codex', {
            prompt_id: everyTurnKey.prompt_id,
            turnId: everyTurnKey.turnId,
            promptId: everyTurnKey.promptId,
        });
        expect(packets[0]?.agentTurnId).toBe('codex-camel-turn-id');
    });

    it.each(['claude', 'codex'] as const)(
        'recovers the %s turn identity from a truncated payload',
        async (provider) => {
            const packets = await deliver(provider, {
                ...everyTurnKey,
                tool_calls: [{ tool_response: 'private-result'.repeat(8_000) }],
            });
            expect(packets).toHaveLength(1);
            expect(packets[0]?.agentTurnId).toBe(ownTurnId[provider]);
            expect(JSON.stringify(packets[0])).not.toContain('private-result');
        },
    );
});

describe('Antigravity hook bridge', () => {
    const conversationId = '49cc1001-2b93-4bb3-9ee8-104e8dcdd683';
    const main = { conversationId, lastUserInput: 'Synthetic prompt', invocationNum: 0 };

    it('identifies the conversation from its first model call without forwarding the prompt', async () => {
        const [packet] = await deliver('antigravity', main);
        expect(packet).toMatchObject({ phase: 'turnStarted', agentSessionId: conversationId });
        expect(JSON.stringify(packet)).not.toContain('Synthetic prompt');
        expect(await deliver('antigravity', { ...main, invocationNum: 1 })).toEqual([]);
    });

    it('names the turn by the steps before it and digests the submitted prompt for delegation', async () => {
        const [packet] = await deliver(
            'antigravity',
            { ...main, initialNumSteps: 4 },
            'turnStarted',
            { CAXRI_HOOK_DIGEST: '1' },
        );
        expect(packet).toMatchObject({
            agentTurnId: 'step-4',
            agentPromptDigest: createHash('sha256').update('Synthetic prompt').digest('hex'),
        });
        expect(JSON.stringify(packet)).not.toContain('Synthetic prompt');
        const [stop] = await deliver(
            'antigravity',
            { ...main, initialNumSteps: 4, terminationReason: 'NO_TOOL_CALL', fullyIdle: true },
            'turnFinished',
        );
        // Stop's step count has moved on, so Server Core, not the bridge, names its turn.
        expect(stop.agentTurnId).toBeUndefined();
    });

    it("ignores a subagent's events, which carry no user input", async () => {
        const subagent = { conversationId: 'subagent-conversation', invocationNum: 0 };
        expect(await deliver('antigravity', subagent)).toEqual([]);
        expect(await deliver('antigravity', subagent, 'turnFinished')).toEqual([]);
    });

    it('ends a turn only once fully idle, and as failed when it stopped on an error', async () => {
        const stop = { ...main, terminationReason: 'NO_TOOL_CALL', fullyIdle: true };
        expect(await deliver('antigravity', stop, 'turnFinished')).toMatchObject([
            { phase: 'turnFinished', agentSessionId: conversationId },
        ]);
        expect(await deliver('antigravity', { ...stop, fullyIdle: false }, 'turnFinished')).toEqual(
            [],
        );
        expect(
            await deliver('antigravity', { ...stop, terminationReason: 'ERROR' }, 'turnFinished'),
        ).toMatchObject([{ phase: 'turnFailed' }]);
        expect(
            await deliver(
                'antigravity',
                { ...stop, terminationReason: 'USER_CANCELED' },
                'turnFinished',
            ),
        ).toMatchObject([{ phase: 'turnFailed' }]);
    });
});

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
const ownTurnId: Record<AgentProvider, string> = {
    claude: 'claude-prompt-id',
    codex: 'codex-turn-id',
    grok: 'grok-prompt-id',
};

async function deliver(
    provider: AgentProvider,
    payload: Record<string, unknown>,
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
        const invocation = execFileAsync(
            bridgePath,
            ['--provider', provider, '--phase', 'turnStarted'],
            {
                env: {
                    CAXRI_HOOK_LAUNCH_ID: 'turn-launch',
                    CAXRI_HOOK_RUNTIME: process.execPath,
                    CAXRI_HOOK_SOCKET: socketPath,
                    CAXRI_HOOK_TERMINAL_ID: 'turn-terminal',
                    CAXRI_HOOK_TOKEN: 'turn-token',
                    PATH: process.env.PATH,
                },
            },
        );
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

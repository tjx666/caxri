import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

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
 * Runs the staged bridge for one phase against a socket that answers `ack`, and returns what it printed to the
 * provider.
 */
async function invoke(phase: string, ack: string): Promise<string> {
    const sharedPath = await mkdtemp(join(tmpdir(), 'caxri-context-bridge-'));
    temporaryDirectories.push(sharedPath);
    const bridgePath = await stageAgentHookBridge(sharedPath);
    const socketPath = join(sharedPath, 'context.sock');
    const server = createServer((socket) => {
        socket.resume();
        socket.on('end', () => socket.end(ack));
    });
    server.listen(socketPath);
    await once(server, 'listening');
    try {
        const invocation = execFileAsync(bridgePath, ['--provider', 'codex', '--phase', phase], {
            env: {
                CAXRI_HOOK_LAUNCH_ID: 'context-launch',
                CAXRI_HOOK_RUNTIME: process.execPath,
                CAXRI_HOOK_SOCKET: socketPath,
                CAXRI_HOOK_TERMINAL_ID: 'context-terminal',
                CAXRI_HOOK_TOKEN: 'context-token',
                PATH: process.env.PATH,
            },
        });
        invocation.child.stdin?.end(JSON.stringify({ session_id: 'fixture-session' }));
        const { stdout, stderr } = await invocation;
        expect(stderr).toBe('');
        return stdout;
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

describe('hook bridge turn context', () => {
    it('hands the context of a turnStarted ack to the provider as UserPromptSubmit context', async () => {
        const context = 'Use "$CAXRI_CLI" to start work in another Session.'.repeat(30);
        const stdout = await invoke('turnStarted', `${JSON.stringify({ ok: true, context })}\n`);
        expect(JSON.parse(stdout)).toEqual({
            hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
        });
    });

    it('prints nothing when the ack carries no context', async () => {
        expect(await invoke('turnStarted', '{"ok":true}\n')).toBe('');
    });

    it('never prints context for a phase whose provider output is not prompt context', async () => {
        const ack = `${JSON.stringify({ ok: true, context: 'unexpected' })}\n`;
        expect(await invoke('turnFinished', ack)).toBe('');
    });
});

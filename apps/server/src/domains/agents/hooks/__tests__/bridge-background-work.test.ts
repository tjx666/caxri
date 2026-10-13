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

async function sharedDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hook-background-'));
    temporaryDirectories.push(directory);
    return directory;
}

/**
 * Claude's `Stop` lists in-flight background work. Only work that wakes the Agent again marks the finish as waiting,
 * and the task's description or command never crosses the bridge.
 */
describe('agent hook bridge background work', () => {
    it.each([
        { tasks: [{ type: 'subagent', status: 'running' }], expected: true },
        { tasks: [{ type: 'workflow', status: 'pending' }], expected: true },
        { tasks: [{ type: 'monitor' }], expected: true },
        { tasks: [{ type: 'shell', status: 'running', command: 'synthetic' }], expected: false },
        { tasks: [{ type: 'subagent', status: 'completed' }], expected: false },
        { tasks: [], expected: false },
        { tasks: [{ type: 'subagent', status: 'running' }], agentId: 'child', expected: false },
    ])(
        'flags a Claude Stop that waits on work that wakes the Agent: %j',
        async ({ tasks, agentId, expected }) => {
            const sharedPath = await sharedDirectory();
            const bridgePath = await stageAgentHookBridge(sharedPath);
            const socketPath = join(sharedPath, 'background.sock');
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
                    ['--provider', 'claude', '--phase', 'turnFinished'],
                    {
                        env: {
                            CAXRI_HOOK_LAUNCH_ID: 'fixture-launch',
                            CAXRI_HOOK_RUNTIME: process.execPath,
                            CAXRI_HOOK_SOCKET: socketPath,
                            CAXRI_HOOK_TERMINAL_ID: 'fixture-terminal',
                            CAXRI_HOOK_TOKEN: 'fixture-token',
                            PATH: process.env.PATH,
                        },
                    },
                );
                invocation.child.stdin?.end(
                    JSON.stringify({
                        session_id: 'fixture-session',
                        hook_event_name: agentId ? 'SubagentStop' : 'Stop',
                        background_tasks: tasks,
                        ...(agentId && { agent_id: agentId }),
                    }),
                );
                await invocation;
                expect(packets).toHaveLength(1);
                if (expected) expect(packets[0]?.agentBackgroundWork).toBe(true);
                else expect(packets[0]).not.toHaveProperty('agentBackgroundWork');
                expect(JSON.stringify(packets)).not.toContain('synthetic');
            } finally {
                server.close();
            }
        },
    );
});

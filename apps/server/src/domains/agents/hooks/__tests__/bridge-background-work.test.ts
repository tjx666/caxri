import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
 * Claude's `Stop` lists in-flight background work. Work that wakes the Agent again, and a background shell that matches
 * no long-running pattern, marks the finish as waiting; the task's description or command never crosses the bridge.
 */
describe('agent hook bridge background work', () => {
    it.each([
        { tasks: [{ type: 'subagent', status: 'running' }], expected: true },
        { tasks: [{ type: 'workflow', status: 'pending' }], expected: true },
        { tasks: [{ type: 'monitor' }], expected: true },
        { tasks: [{ type: 'subagent', status: 'completed' }], expected: false },
        { tasks: [], expected: false },
        { tasks: [{ type: 'subagent', status: 'running' }], agentId: 'child', expected: false },
        // A Server Core that predates the pattern file does not count shells.
        { tasks: [{ type: 'shell', status: 'running', command: 'synthetic' }], expected: false },
        {
            tasks: [{ type: 'shell', status: 'running', command: 'synthetic --watch' }],
            patterns: ['bun run dev'],
            expected: true,
        },
        {
            tasks: [
                { type: 'shell', status: 'running', command: 'cd app && synthetic --port 3000' },
            ],
            patterns: ['synthetic'],
            expected: false,
        },
        {
            tasks: [{ type: 'shell', status: 'completed', command: 'synthetic' }],
            patterns: [],
            expected: false,
        },
        // A shell that cannot be classified does not hold the turn, as before shells counted at all.
        { tasks: [{ type: 'shell', status: 'running' }], patterns: ['synthetic'], expected: false },
        {
            tasks: [{ type: 'shell', status: 'running', command: 'synthetic' }],
            patterns: 'unreadable',
            expected: false,
        },
    ])(
        'flags a Claude Stop that waits on work that wakes the Agent: %j',
        async ({ tasks, agentId, patterns, expected }) => {
            const sharedPath = await sharedDirectory();
            const bridgePath = await stageAgentHookBridge(sharedPath);
            const patternsPath = join(sharedPath, 'long-running-shell-commands.json');
            if (Array.isArray(patterns)) await writeFile(patternsPath, JSON.stringify(patterns));
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
                            ...(patterns !== undefined && {
                                CAXRI_HOOK_LONG_RUNNING_COMMANDS: patternsPath,
                            }),
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

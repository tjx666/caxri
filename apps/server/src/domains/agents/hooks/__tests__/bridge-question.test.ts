import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';
import { expect, it } from 'vitest';

import { stageAgentHookBridge } from '../bridge';

it.each(
    [8, 9].flatMap((schema) =>
        ['attentionRequested', 'attentionResolved'].map((phase) => ({ schema, phase })),
    ),
)('forwards question identity only to supported live Servers: %j', async ({ schema, phase }) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-question-bridge-'));
    const bridge = await stageAgentHookBridge(directory);
    const socketPath = join(directory, 'hook.sock');
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
        const invocation = execFileAsync(bridge, ['--provider', 'codex', '--phase', phase], {
            env: {
                CAXRI_HOOK_SCHEMA_CODEX: String(schema),
                CAXRI_HOOK_LAUNCH_ID: 'fixture-launch',
                CAXRI_HOOK_RUNTIME: process.execPath,
                CAXRI_HOOK_SOCKET: socketPath,
                CAXRI_HOOK_TERMINAL_ID: 'fixture-terminal',
                CAXRI_HOOK_TOKEN: 'fixture-token',
                PATH: process.env.PATH,
            },
        });
        invocation.child.stdin?.end(
            JSON.stringify({
                tool_use_id: 'question-1',
                tool_input: { questions: ['synthetic-private-question'] },
                tool_response: { answers: ['synthetic-private-answer'] },
            }),
        );
        await invocation;
        expect(packets).toHaveLength(1);
        expect(packets[0]).toMatchObject({ phase });
        if (schema >= 9) expect(packets[0]).toHaveProperty('agentToolUseId', 'question-1');
        else expect(packets[0]).not.toHaveProperty('agentToolUseId');
        expect(packets[0]).not.toHaveProperty('worktreeCreateIntent');
        expect(packets[0]).not.toHaveProperty('tool_input');
        expect(packets[0]).not.toHaveProperty('tool_response');
        expect(JSON.stringify(packets)).not.toContain('synthetic-private');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
    }
});

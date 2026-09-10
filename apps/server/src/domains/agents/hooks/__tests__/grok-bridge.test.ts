import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';
import { expect, it } from 'vitest';

import { stageAgentHookBridge } from '../bridge';

it('correlates Grok turns and filters shutdown, children, malformed payloads and inherited Claude hooks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-grok-bridge-'));
    const bridge = await stageAgentHookBridge(directory);
    const socketPath = join(directory, 'hook.sock');
    const packets: Array<Record<string, unknown>> = [];
    const server = createServer((socket) => {
        let source = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
            source += chunk;
        });
        socket.on('end', () => {
            packets.push(JSON.parse(source) as Record<string, unknown>);
            socket.end('{"ok":true}');
        });
    });
    server.listen(socketPath);
    await once(server, 'listening');
    const invoke = async (phase: string, payload: unknown, provider = 'grok') => {
        const result = execFileAsync(bridge, ['--provider', provider, '--phase', phase], {
            env: {
                PATH: process.env.PATH,
                CAXRI_HOOK_RUNTIME: process.execPath,
                CAXRI_HOOK_SOCKET: socketPath,
                CAXRI_HOOK_TOKEN: 'fixture',
                CAXRI_HOOK_LAUNCH_ID: 'launch',
                CAXRI_HOOK_TERMINAL_ID: 'terminal',
                GROK_SESSION_ID: 'session',
            },
        });
        result.child.stdin?.end(JSON.stringify(payload));
        await result;
    };
    try {
        await invoke('sessionIdentified', { sessionId: 'session-a', source: 'new' });
        await invoke('sessionIdentified', { sessionId: 'session-b', source: 'load' });
        await invoke('turnFinished', {
            sessionId: 'session-b',
            promptId: 'turn-b',
            reason: 'end_turn',
        });
        await invoke('turnFailed', { sessionId: 'session-b', promptId: 'turn-c' });
        await invoke('turnFinished', { sessionId: 'session-a', reason: 'shutdown' });
        await invoke('turnFinished', {
            sessionId: 'session-b',
            promptId: 'turn-b',
            reason: 'end_turn',
            agentId: 'child',
        });
        await invoke('turnFinished', {
            sessionId: 'session-b',
            promptId: 'turn-b',
            reason: 'end_turn',
            backgroundTasks: [{}],
        });
        await invoke('turnStarted', { sessionId: 'session-b' }, 'claude');
        await invoke('turnStarted', {
            sessionId: 'session-b',
            promptId: 'long-turn',
            prompt: 'x'.repeat(70_000),
        });
        expect(packets).toHaveLength(5);
        expect(packets[4]).toMatchObject({
            agentSessionId: 'session-b',
            agentTurnId: 'long-turn',
            phase: 'turnStarted',
        });
        expect(packets[0]).toMatchObject({
            agentSessionId: 'session-a',
            phase: 'sessionIdentified',
        });
        expect(packets[1]).toMatchObject({
            agentSessionId: 'session-b',
            phase: 'sessionIdentified',
        });
        expect(packets[2]).toMatchObject({ agentTurnId: 'turn-b', phase: 'turnFinished' });
        expect(packets[3]).toMatchObject({ agentTurnId: 'turn-c', phase: 'turnFailed' });
        await invoke('turnFinished', {
            sessionId: 'session-b',
            promptId: 'unicode-turn',
            reason: 'end_turn',
            lastAssistantMessage: '合成'.repeat(25_000),
        });
        expect(packets).toHaveLength(6);
        expect(packets[5]).toMatchObject({
            agentSessionId: 'session-b',
            agentTurnId: 'unicode-turn',
            phase: 'turnFinished',
        });
        expect(JSON.stringify(packets)).not.toContain('合成');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
    }
});

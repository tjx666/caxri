import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';
import { describe, expect, it } from 'vitest';

import { stageAgentHookBridge } from '../bridge';

describe('blocking Claude hook bridge', () => {
    it('returns the exact question answer through an authenticated blocking hook', async () => {
        const originalQuestion = `Which? ${'Q'.repeat(500)}`;
        const displayQuestion = originalQuestion.slice(0, 500);
        const sharedPath = await mkdtemp(join(tmpdir(), 'caxri-hook-attention-'));
        const bridgePath = await stageAgentHookBridge(sharedPath);
        const socketPath = join(sharedPath, 'attention.sock');
        const packets: Array<Record<string, unknown>> = [];
        const server = createServer({ allowHalfOpen: true }, (socket) => {
            let source = '';
            socket.setEncoding('utf8');
            socket.on('data', (chunk: string) => {
                source += chunk;
            });
            socket.on('end', () => {
                packets.push(JSON.parse(source) as Record<string, unknown>);
                socket.end(
                    `${JSON.stringify({ ok: true, answers: { [displayQuestion]: 'A' } })}\n`,
                );
            });
        });
        server.listen(socketPath);
        await once(server, 'listening');
        try {
            const invocation = execFileAsync(
                bridgePath,
                [
                    '--provider',
                    'claude',
                    '--phase',
                    'attentionRequested',
                    '--interactive',
                    'question',
                ],
                {
                    env: {
                        CAXRI_HOOK_LAUNCH_ID: 'launch',
                        CAXRI_HOOK_RUNTIME: process.execPath,
                        CAXRI_HOOK_SOCKET: socketPath,
                        CAXRI_HOOK_TERMINAL_ID: 'terminal',
                        CAXRI_HOOK_TOKEN: 'token',
                        PATH: process.env.PATH,
                    },
                },
            );
            invocation.child.stdin?.end(
                JSON.stringify({
                    tool_name: 'AskUserQuestion',
                    tool_input: {
                        questions: [
                            {
                                question: originalQuestion,
                                header: 'Choice',
                                options: [{ label: 'A' }],
                                multiSelect: false,
                            },
                        ],
                    },
                }),
            );
            const result = await invocation;
            expect(packets[0]).toMatchObject({
                kind: 'attention',
                attentionKind: 'question',
                toolName: 'AskUserQuestion',
                questions: [{ question: displayQuestion }],
            });
            expect(JSON.parse(result.stdout)).toEqual({
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow',
                    updatedInput: {
                        questions: [
                            {
                                question: originalQuestion,
                                header: 'Choice',
                                options: [{ label: 'A' }],
                                multiSelect: false,
                            },
                        ],
                        answers: { [originalQuestion]: 'A' },
                    },
                },
            });
        } finally {
            server.close();
            await rm(sharedPath, { recursive: true, force: true });
        }
    });
});

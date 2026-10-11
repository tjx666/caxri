import { describe, expect, it } from 'vitest';

import { claudeChatSettings, codexChatSettings, grokChatSettings } from '../launch-settings';

const launch = (arguments_: string[]) => ({ executable: 'codex', args: arguments_ });

describe('codexChatSettings', () => {
    it('keeps the autonomy flag meaning: no approvals and no sandbox', () => {
        expect(codexChatSettings(launch(['--dangerously-bypass-approvals-and-sandbox']))).toEqual({
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            sandbox: 'danger-full-access',
            rootArgs: [],
        });
    });

    it('asks for approval inside the workspace sandbox without it', () => {
        expect(codexChatSettings(launch([]))).toEqual({
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            sandbox: 'workspace-write',
            rootArgs: [],
        });
    });

    it('carries structured options and drops TUI-only flags', () => {
        expect(
            codexChatSettings(
                launch([
                    '--model=gpt-x',
                    '-c',
                    'model_reasoning_effort=high',
                    '--profile work',
                    '--sandbox',
                    'read-only',
                    '-a',
                    'untrusted',
                    '--search',
                    '--no-alt-screen',
                ]),
            ),
        ).toEqual({
            approvalPolicy: 'untrusted',
            approvalsReviewer: 'user',
            sandbox: 'read-only',
            model: 'gpt-x',
            rootArgs: ['-c', 'model_reasoning_effort=high', '--profile', 'work'],
        });
    });
});

describe('claudeChatSettings', () => {
    it('keeps manual approvals by default', () => {
        expect(claudeChatSettings(launch([]))).toEqual({
            permissionMode: 'default',
            additionalDirectories: [],
            allowedTools: [],
            disallowedTools: [],
        });
    });

    it('keeps the autonomy flag meaning: every tool runs without asking', () => {
        expect(claudeChatSettings(launch(['--dangerously-skip-permissions']))).toMatchObject({
            permissionMode: 'bypassPermissions',
        });
    });

    it('carries structured options and drops TUI-only flags', () => {
        expect(
            claudeChatSettings(
                launch([
                    '--model=opus',
                    '--permission-mode',
                    'acceptEdits',
                    '--add-dir',
                    '../shared',
                    '--allowedTools',
                    'Bash(git:*) Read',
                    '--disallowed-tools=WebFetch',
                    '--verbose',
                ]),
            ),
        ).toEqual({
            permissionMode: 'acceptEdits',
            model: 'opus',
            additionalDirectories: ['../shared'],
            allowedTools: ['Bash(git:*)', 'Read'],
            disallowedTools: ['WebFetch'],
        });
    });
});

describe('grokChatSettings', () => {
    it('keeps the autonomy flag meaning, under either spelling', () => {
        expect(grokChatSettings(launch(['--yolo']))).toEqual({
            rootArgs: [],
            agentArgs: ['--always-approve'],
        });
        expect(grokChatSettings(launch(['--always-approve'])).agentArgs).toEqual([
            '--always-approve',
        ]);
    });

    it('leaves approvals to Grok Build without it', () => {
        expect(grokChatSettings(launch([]))).toEqual({ rootArgs: [], agentArgs: [] });
    });

    it('places root and agent options where the CLI accepts them and drops TUI-only flags', () => {
        expect(
            grokChatSettings(
                launch([
                    '-m',
                    'grok-x',
                    '--effort=high',
                    '--sandbox workspace',
                    '--permission-mode=acceptEdits',
                    '--no-alt-screen',
                    '--minimal',
                ]),
            ),
        ).toEqual({
            rootArgs: ['--sandbox', 'workspace', '--permission-mode', 'acceptEdits'],
            agentArgs: ['--model', 'grok-x', '--reasoning-effort', 'high'],
        });
    });
});

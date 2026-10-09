import { describe, expect, it } from 'vitest';

import { codexChatSettings } from '../launch-settings';

const launch = (arguments_: string[]) => ({ executable: 'codex', args: arguments_ });

describe('codexChatSettings', () => {
    it('keeps the autonomy flag meaning: no approvals and no sandbox', () => {
        expect(codexChatSettings(launch(['--dangerously-bypass-approvals-and-sandbox']))).toEqual({
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
            rootArgs: [],
        });
    });

    it('asks for approval inside the workspace sandbox without it', () => {
        expect(codexChatSettings(launch([]))).toEqual({
            approvalPolicy: 'on-request',
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
            sandbox: 'read-only',
            model: 'gpt-x',
            rootArgs: ['-c', 'model_reasoning_effort=high', '--profile', 'work'],
        });
    });
});

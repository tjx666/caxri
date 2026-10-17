import { applyAgentChatOperation, emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentChatSessionHost } from '../chat-provider';
import { onClaudeTranscriptOutput } from '../claude-system-notices';

function harness() {
    let snapshot = emptyAgentChatSnapshot('terminal-1');
    const host: Pick<AgentChatSessionHost, 'apply' | 'lifecycle' | 'read'> = {
        read: () => snapshot,
        apply: (operations) => {
            snapshot = operations.reduce(applyAgentChatOperation, snapshot);
        },
        lifecycle: () => {},
    };
    return host;
}

describe('Claude system output visibility', () => {
    it.each([
        { subtype: 'hook_started', hook_name: 'Example' },
        {
            subtype: 'hook_progress',
            stdout: 'Routine hook output.',
            stderr: 'Diagnostic.',
            output: '{}',
        },
        { subtype: 'hook_response', outcome: 'success', stdout: '{}', stderr: '', output: '{}' },
        {
            subtype: 'hook_response',
            outcome: 'success',
            stdout: JSON.stringify({
                hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
            }),
            output: '',
        },
        { subtype: 'hook_response', outcome: 'cancelled', stdout: 'Cancelled.', exit_code: 130 },
        { subtype: 'unknown_diagnostic', content: 'Provider diagnostic.' },
    ])('keeps $subtype diagnostics out of the conversation', (frame) => {
        const host = harness();
        onClaudeTranscriptOutput(host, frame);
        expect(host.read().items).toEqual([]);
    });

    it('summarizes a failed hook once without any raw output', () => {
        const host = harness();
        onClaudeTranscriptOutput(host, {
            subtype: 'hook_response',
            hook_name: 'Example',
            outcome: 'error',
            exit_code: 1,
            output: 'Raw merged diagnostic.',
            stdout: '{}',
            stderr: 'Raw error diagnostic.',
        });
        expect(host.read().items).toEqual([
            expect.objectContaining({
                type: 'notice',
                kind: 'error',
                message: 'Hook "Example" failed (exit code 1).',
            }),
        ]);
    });

    it.each(['informational', 'model_refusal_fallback', 'model_refusal_no_fallback'])(
        'preserves explicit %s feedback',
        (subtype) => {
            const host = harness();
            onClaudeTranscriptOutput(host, {
                subtype,
                content: 'Explicit feedback.',
                stdout: '{}',
            });
            expect(host.read().items).toEqual([
                expect.objectContaining({ type: 'notice', message: 'Explicit feedback.' }),
            ]);
        },
    );

    it('preserves explicit local command results as a reply', () => {
        const host = harness();
        onClaudeTranscriptOutput(host, {
            subtype: 'local_command_output',
            content: 'Command result.',
        });
        expect(host.read().items).toEqual([
            expect.objectContaining({
                type: 'agentMessage',
                text: 'Command result.',
                streaming: false,
            }),
        ]);
    });

    it('preserves long explicit feedback without turning unrelated fields into content', () => {
        const host = harness();
        const content = 'Synthetic feedback. '.repeat(250);
        onClaudeTranscriptOutput(host, {
            subtype: 'informational',
            content,
            output: 'Diagnostic.',
        });
        expect(
            host
                .read()
                .items.map((item) => (item.type === 'notice' ? item.message : ''))
                .join(''),
        ).toBe(content);
    });
});

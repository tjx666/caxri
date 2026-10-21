import { applyAgentChatOperation, emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentChatSessionHost } from '../chat-provider';
import { didApplyClaudeFeedback, onClaudeApiRetry } from '../claude-system-notices';

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
        didApplyClaudeFeedback(host, frame);
        expect(host.read().items).toEqual([]);
    });

    it('keeps readable failure details without control JSON', () => {
        const host = harness();
        didApplyClaudeFeedback(host, {
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
                title: 'Session Hook "Example" failed (exit code 1)',
                message: 'Raw error diagnostic.',
            }),
        ]);
    });

    it.each(['informational', 'model_refusal_fallback', 'model_refusal_no_fallback'])(
        'preserves explicit %s feedback',
        (subtype) => {
            const host = harness();
            didApplyClaudeFeedback(host, {
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
        didApplyClaudeFeedback(host, {
            subtype: 'local_command_output',
            content: 'Command result.',
        });
        expect(host.read().items).toEqual([
            expect.objectContaining({
                type: 'notice',
                kind: 'output',
                title: 'Command output',
                message: 'Command result.',
            }),
        ]);
    });

    it('preserves long explicit feedback without turning unrelated fields into content', () => {
        const host = harness();
        const content = 'Synthetic feedback. '.repeat(250);
        didApplyClaudeFeedback(host, {
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

describe('Claude API retries', () => {
    it.each([
        [{ error_status: null, error: 'unknown' }, 'connection'],
        [{ error_status: 429, error: 'rate_limit' }, 'rateLimit'],
        [{ error_status: 529, error: 'overloaded' }, 'overloaded'],
        [{ error_status: 500, error: 'server_error' }, 'server'],
        [{ error_status: 400, error: 'invalid_request' }, 'other'],
    ])('names the cause of %o as %s, with the attempt against the limit', (failure, cause) => {
        const host = harness();
        host.apply([{ op: 'state', state: { activeTurnId: 'turn-1' } }]);
        onClaudeApiRetry(host, { attempt: 2, max_retries: 10, ...failure });
        expect(host.read().items).toEqual([
            {
                id: 'turn-1:retry',
                turnId: 'turn-1',
                type: 'notice',
                kind: 'retrying',
                retry: { cause, attempt: 2, maxAttempts: 10 },
            },
        ]);
    });
});

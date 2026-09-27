import { describe, expect, it } from 'vitest';

import {
    codexDelegationAdapter,
    codexPrimaryTurnFailure,
    extractCodexDelegationCompletion,
} from '../delegation';

const evidence = {
    sessionId: 'synthetic-session',
    turnId: 'owned-turn',
    promptDigest: 'a'.repeat(64),
};
const event = (payload: Record<string, unknown>) => JSON.stringify({ type: 'event_msg', payload });
const complete = (text: string, turnId = evidence.turnId) =>
    event({ type: 'task_complete', turn_id: turnId, last_agent_message: text });

describe('Codex delegation completion', () => {
    it('uses only the exact final native event, including after nonfinal Stop answers', () => {
        const content = [
            complete('Earlier answer', 'earlier-turn'),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Intermediate answer' }],
                },
            }),
            complete('Final synthetic answer'),
        ].join('\n');
        expect(
            extractCodexDelegationCompletion(content, {
                ...evidence,
                answerDigest: 'b'.repeat(64),
            }),
        ).toEqual({ kind: 'answer', text: 'Final synthetic answer', messageId: evidence.turnId });
    });
    it('does not guess completion from an assistant message or another turn', () => {
        expect(
            extractCodexDelegationCompletion(complete('Other', 'other-turn'), evidence),
        ).toBeUndefined();
        expect(
            extractCodexDelegationCompletion(
                JSON.stringify({
                    type: 'response_item',
                    payload: { role: 'assistant', content: 'Synthetic answer' },
                }),
                evidence,
            ),
        ).toBeUndefined();
    });
    it('rejects duplicate terminal evidence for the same turn', () => {
        expect(
            extractCodexDelegationCompletion(
                [complete('One'), complete('Two')].join('\n'),
                evidence,
            ),
        ).toEqual({ kind: 'failed', failure: 'correlation_missing' });
    });
    it.each([
        ['rate_limit_exceeded', 'rate_limited'],
        ['unauthorized', 'authentication_failed'],
        ['usage_limit_exceeded', 'quota_exhausted'],
        ['unknown_future_error', 'provider_failed'],
    ])('closes provider error %s without copying its message', (code, failure) => {
        const content = event({
            type: 'task_complete',
            turn_id: evidence.turnId,
            last_agent_message: null,
            error: { codex_error_info: code, message: 'Synthetic private diagnostic' },
        });
        expect(extractCodexDelegationCompletion(content, evidence)).toEqual({
            kind: 'failed',
            failure,
        });
    });
    it('settles missing answers and native cancellation without claiming success', () => {
        expect(
            extractCodexDelegationCompletion(
                event({
                    type: 'task_complete',
                    turn_id: evidence.turnId,
                    last_agent_message: null,
                }),
                evidence,
            ),
        ).toEqual({ kind: 'failed', failure: 'result_missing' });
        expect(
            extractCodexDelegationCompletion(
                event({ type: 'turn_aborted', turn_id: evidence.turnId }),
                evidence,
            ),
        ).toEqual({ kind: 'failed', failure: 'provider_failed' });
    });
});

describe('codexPrimaryTurnFailure', () => {
    // Issue #1345: Codex has no StopFailure-class hook event, so a login expiry or rate limit during the primary
    // turn still fires a plain `Stop`. This generalizes `extractCodexDelegationCompletion`'s rollout-JSONL
    // correlation so that turn can be reported as failed instead of completed.
    it.each([
        ['rate_limit_exceeded', 'rate_limit'],
        ['unauthorized', 'authentication_failed'],
        ['usage_limit_exceeded', 'billing_error'],
        ['session_budget_exceeded', 'billing_error'],
        ['context_window_exceeded', 'max_output_tokens'],
        ['unknown_future_error', 'provider_failed'],
    ])('maps an explicit %s provider error to %s', (code, agentFailure) => {
        const content = event({
            type: 'task_complete',
            turn_id: evidence.turnId,
            last_agent_message: null,
            error: { codex_error_info: code, message: 'Synthetic private diagnostic' },
        });
        expect(codexPrimaryTurnFailure(content, evidence.turnId)).toBe(agentFailure);
    });
    it('maps a native abort to a provider failure', () => {
        const content = event({ type: 'turn_aborted', turn_id: evidence.turnId });
        expect(codexPrimaryTurnFailure(content, evidence.turnId)).toBe('provider_failed');
    });
    it('leaves an ordinary completed turn unclassified', () => {
        expect(
            codexPrimaryTurnFailure(complete('Final synthetic answer'), evidence.turnId),
        ).toBeUndefined();
    });
    it('does not guess a failure from an inconclusive or unrelated read', () => {
        // Stop fired but the rollout has no matching completion text and no error: a correlation gap, not a proven
        // provider error, so this must stay `turnFinished` rather than report a failure it cannot prove.
        expect(
            codexPrimaryTurnFailure(
                event({
                    type: 'task_complete',
                    turn_id: evidence.turnId,
                    last_agent_message: null,
                }),
                evidence.turnId,
            ),
        ).toBeUndefined();
        // More than one terminal event for the same turn id is a correlation problem, not evidence of failure.
        expect(
            codexPrimaryTurnFailure([complete('One'), complete('Two')].join('\n'), evidence.turnId),
        ).toBeUndefined();
        // No matching turn id at all.
        expect(
            codexPrimaryTurnFailure(complete('Other', 'other-turn'), evidence.turnId),
        ).toBeUndefined();
    });
});

describe('Codex delegation launch ownership', () => {
    it.each(['-c', '--config'])(
        'accepts only the bounded model effort configuration through %s',
        (flag) => {
            expect(() =>
                codexDelegationAdapter.validateLaunch({
                    executable: 'codex',
                    args: [flag, 'model_reasoning_effort="xhigh"'],
                }),
            ).not.toThrow();
            for (const value of [
                'hooks.enabled=false',
                'model_reasoning_effort="high"\nhooks.enabled=false',
                'model_reasoning_effort=unexpected',
            ])
                expect(() =>
                    codexDelegationAdapter.validateLaunch({
                        executable: 'codex',
                        args: [flag, value],
                    }),
                ).toThrow();
        },
    );
    it('preserves the existing explicitly configured bypass without adding one', () => {
        const launch = {
            executable: 'codex',
            args: ['--dangerously-bypass-approvals-and-sandbox'],
        };
        expect(() => codexDelegationAdapter.validateLaunch(launch)).not.toThrow();
        expect(
            codexDelegationAdapter.freshLaunch!(launch, 'Synthetic pointer', '/private/tasks').args,
        ).toEqual([...launch.args, '--', 'Synthetic pointer']);
    });
    it('submits the pointer without granting directory write access or inventing native identity', () => {
        const launch = {
            executable: 'codex',
            args: ['--sandbox', 'read-only', '--ask-for-approval', 'never'],
        };
        expect(() => codexDelegationAdapter.validateLaunch(launch)).not.toThrow();
        expect(codexDelegationAdapter.createSessionId()).toBeUndefined();
        expect(
            codexDelegationAdapter.freshLaunch!(launch, 'Synthetic pointer', '/private/tasks'),
        ).toEqual({ ...launch, args: [...launch.args, '--', 'Synthetic pointer'] });
        expect(codexDelegationAdapter.resumeLaunch!(launch, '/private/tasks')).toEqual(launch);
    });
    it.each([
        ['-c', 'features.hooks=false'],
        ['--profile', 'other'],
        ['--dangerously-bypass-hook-trust'],
        ['--add-dir', '/outside'],
        ['resume', 'other'],
        ['--model', '--search'],
        ['unowned prompt'],
    ])('rejects an argument that changes authority or evidence: %j', (...arguments_) => {
        expect(() =>
            codexDelegationAdapter.validateLaunch({ executable: 'codex', args: arguments_ }),
        ).toThrow(/unsupported|Only model reasoning effort/u);
    });
    it('requires the verified native CLI line', () => {
        expect(() => codexDelegationAdapter.verifyVersion('codex-cli 0.153.4')).not.toThrow();
        expect(() => codexDelegationAdapter.verifyVersion('codex-cli 0.152.0')).toThrow(/0.153.4/u);
        expect(() => codexDelegationAdapter.verifyVersion('codex-cli 1.0.0')).toThrow(/0.153.4/u);
    });
});

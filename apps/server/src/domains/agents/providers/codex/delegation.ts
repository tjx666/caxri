import { CaxriError } from '@caxri/protocol';
import { coerce, gte } from 'semver';

import type {
    AgentDelegationAdapter,
    DelegationCompletion,
    DelegationEvidence,
} from '../../delegation-contract';
import { replaceDelegationArguments, validateDelegationArguments } from '../../delegation-contract';
import { extractCodexDelegationUsage } from './delegation-usage';

const valueFlags = new Set(['--model', '--sandbox', '--ask-for-approval', '-c', '--config']);
const booleanFlags = new Set([
    '--search',
    '--no-alt-screen',
    '--dangerously-bypass-approvals-and-sandbox',
]);

function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/**
 * Stop hooks may block and continue the same Codex turn. Only the persisted terminal event proves its final answer; the
 * authenticated UserPromptSubmit already bound the exact turn to the private task pointer.
 *
 * @see https://github.com/openai/codex/blob/fc7d34ad/codex-rs/core/src/tasks/mod.rs
 * @see https://github.com/openai/codex/blob/fc7d34ad/codex-rs/core/src/session/turn.rs
 */
export function extractCodexDelegationCompletion(
    content: string,
    evidence: DelegationEvidence,
): DelegationCompletion | undefined {
    if (!evidence.turnId) return;
    let completion: DelegationCompletion | undefined;
    for (const line of content.split('\n')) {
        let row: Record<string, unknown> | undefined;
        try {
            row = object(JSON.parse(line));
        } catch {
            continue;
        }
        if (row?.type !== 'event_msg') continue;
        const event = object(row.payload);
        if (!event || event.turn_id !== evidence.turnId) continue;
        if (!['task_complete', 'turn_complete', 'turn_aborted'].includes(String(event.type)))
            continue;
        if (completion) return { kind: 'failed', failure: 'correlation_missing' };
        if (event.type === 'turn_aborted') {
            completion = { kind: 'failed', failure: 'provider_failed' };
            continue;
        }
        if (event.error !== undefined && event.error !== null) {
            const code = object(event.error)?.codex_error_info;
            const failures = {
                rate_limit_exceeded: 'rate_limited',
                unauthorized: 'authentication_failed',
                usage_limit_exceeded: 'quota_exhausted',
                session_budget_exceeded: 'quota_exhausted',
                context_window_exceeded: 'output_limit',
            } as const;
            completion = {
                kind: 'failed',
                failure:
                    typeof code === 'string' && Object.hasOwn(failures, code)
                        ? failures[code as keyof typeof failures]
                        : 'provider_failed',
            };
        } else if (
            typeof event.last_agent_message !== 'string' ||
            event.last_agent_message.length === 0
        ) {
            completion = { kind: 'failed', failure: 'result_missing' };
        } else {
            completion = {
                kind: 'answer',
                text: event.last_agent_message,
                messageId: evidence.turnId,
            };
        }
    }
    return completion;
}

export const codexDelegationAdapter: AgentDelegationAdapter = {
    extractUsage: extractCodexDelegationUsage,
    completion: 'native-completion',
    createSessionId: () => {},
    validateLaunch: (launch) => {
        validateDelegationArguments(launch, valueFlags, booleanFlags);
        for (let index = 0; index < launch.args.length; index++) {
            const argument = launch.args[index];
            const flag = argument.split('=', 1)[0];
            if (flag !== '-c' && flag !== '--config') continue;
            const value = argument.includes('=')
                ? argument.slice(flag.length + 1)
                : launch.args[++index];
            if (
                !/^model_reasoning_effort=(?:low|medium|high|xhigh|max|ultra|"(?:low|medium|high|xhigh|max|ultra)")$/u.test(
                    value,
                )
            )
                throw new CaxriError(
                    'CONFLICT',
                    'Only model reasoning effort may be configured for delegation',
                );
        }
    },
    selectLaunch: (launch, selection) =>
        replaceDelegationArguments(launch, new Set(['--model', '-c', '--config']), [
            ...(selection.model ? ['--model', selection.model] : []),
            ...(selection.effort
                ? ['-c', `model_reasoning_effort=${JSON.stringify(selection.effort)}`]
                : []),
        ]),
    verifyVersion: (source) => {
        const version = coerce(source ?? '');
        if (version?.major !== 0 || !gte(version, '0.153.4'))
            throw new CaxriError(
                'UNAVAILABLE',
                'Visible delegation requires Codex CLI 0.153.4+ within major 0',
            );
    },
    /**
     * Codex add-dir grants write access; a read-only task pointer must not add that grant.
     */
    freshLaunch: (launch, pointer) => ({ ...launch, args: [...launch.args, '--', pointer] }),
    resumeLaunch: (launch) => launch,
    extractCompletion: extractCodexDelegationCompletion,
};

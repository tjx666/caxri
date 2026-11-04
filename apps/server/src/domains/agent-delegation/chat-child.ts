import { createHash } from 'node:crypto';

import type {
    AgentDelegationReceipt,
    AgentLaunchSettings,
    AgentProvider,
    TerminalSurface,
} from '@caxri/protocol';
import { canUseAgentChat, CaxriError, isCaxriError } from '@caxri/protocol';

import type { AgentDispatchStartOptions } from '../agent-dispatch';
import type { DelegationCompletion } from '../agents';
import type { StoredAgentDelegation } from '../db';
import { delegationResumeLaunch } from './launch';
import type { AgentDelegationServiceOptions } from './service-options';

/**
 * Providers whose Chat reports what a visible delegation needs: the prompt digest when the task's turn starts, the
 * turn's end, and (for Claude Code, which has no native completion record) the answer digest. Grok Build's Chat does
 * not, so its children keep the PTY Terminal.
 */
const CHAT_CHILD_PROVIDERS: ReadonlySet<AgentProvider> = new Set(['claude', 'codex']);

/**
 * Whether a Chat of this provider can carry a Caxri Bot task: it reports the prompt digest and turn end that correlate
 * the task. Shared by visible children and Caxri Bot hand-overs, so a Grok Build Chat is never accepted as
 * continuable.
 */
export function canChatCorrelateTask(provider: AgentProvider): boolean {
    return CHAT_CHILD_PROVIDERS.has(provider);
}

/**
 * What a Chat's projection knows about the task's turn; mirrors `ChatTurnAnswer` in the Agent Chat domain.
 */
export type DelegationChatTurn =
    | { status: 'unavailable' | 'missing' | 'running' }
    | {
          status: 'finished';
          outcome: 'completed' | 'interrupted' | 'failed';
          answer?: { id: string; text: string };
          isTruncated: boolean;
      };

/**
 * Refuses a forced Chat child that cannot run: the provider's Chat does not report the task (Grok Build, Antigravity),
 * or this Server has no Agent Chat. A caller that forces `chat` waits on `transcript` and parent approval, so a silent
 * Terminal downgrade would leave it waiting on reads that can never succeed. Throws before any record exists, so no
 * failed task is stored and the closed failure enum is unchanged.
 */
export function assertChatChildAvailable(
    options: Pick<AgentDelegationServiceOptions, 'hasAgentChat'>,
    provider: AgentProvider,
): void {
    if (
        options.hasAgentChat?.() !== true ||
        !canChatCorrelateTask(provider) ||
        !canUseAgentChat(provider)
    )
        throw new CaxriError('UNAVAILABLE', 'A Chat child is unavailable for this Agent', {
            reason: 'forced_chat_unavailable',
        });
}

/**
 * The surface a new visible child opens on: the caller's forced `surface` when given, else Chat when
 * `session.openAgentsInChat` is on and the provider's Chat can carry the task, else the PTY Terminal. A forced `pty`
 * never consults the setting; a forced `chat` works with the setting off and is refused when unsatisfiable. Resolved
 * once at admission and stored on the receipt, so the caller reads what the child actually got.
 */
export function resolveChildSurface(
    options: Pick<AgentDelegationServiceOptions, 'hasAgentChat' | 'opensAgentsInChat'>,
    provider: AgentProvider,
    requested: TerminalSurface | undefined,
): TerminalSurface {
    if (requested === 'chat') assertChatChildAvailable(options, provider);
    if (requested) return requested;
    return options.opensAgentsInChat?.() &&
        canChatCorrelateTask(provider) &&
        canUseAgentChat(provider)
        ? 'chat'
        : 'pty';
}

/**
 * The dispatch launch of a new visible child, on the surface the task was admitted with (`receipt.surface`). A Chat
 * child starts with the task's frozen launch settings plus read access to the task directory (the same launch a
 * `--resume` uses), and receives the task pointer as its first message instead of in argv. Claude Code also presets the
 * conversation id the task was admitted with. A Terminal child keeps the PTY launch unchanged, including the hooks
 * check, whether it was forced or chosen by the setting.
 */
export function delegationChildLaunch(
    options: Pick<
        AgentDelegationServiceOptions,
        'hasAgentChat' | 'hasLifecycleHooks' | 'opensAgentsInChat' | 'userDataPath'
    >,
    record: StoredAgentDelegation,
    prepared: {
        launch: AgentLaunchSettings;
        pointer: string;
        initialPrompt?: string;
        assignedAgentSessionId?: string;
    },
): Pick<
    AgentDispatchStartOptions,
    'assignedAgentSessionId' | 'initialPrompt' | 'launch' | 'surface'
> {
    const { provider } = record.receipt;
    const surface =
        record.receipt.surface ?? resolveChildSurface(options, provider, record.input.surface);
    if (surface === 'pty') {
        assertTerminalChildHooks(options, provider);
        return {
            launch: prepared.launch,
            initialPrompt: prepared.initialPrompt,
            assignedAgentSessionId: prepared.assignedAgentSessionId,
        };
    }
    return {
        surface: 'chat',
        launch: delegationResumeLaunch(record, options.userDataPath),
        initialPrompt: prepared.pointer,
        assignedAgentSessionId: record.providerSessionId,
    };
}

/**
 * Throws for a Terminal child whose provider's lifecycle hooks are off, checked before the launch and again on its
 * `environment` once it has one. A Terminal child reports its prompt digest and turn end only through those hooks, and
 * a hook token does not prove they are on: any enabled provider gives every Agent launch credentials, while signals of
 * a disabled provider are ignored, so the task would wait forever. A Chat child reports through its provider protocol
 * and never needs them.
 */
export function assertTerminalChildHooks(
    options: Pick<AgentDelegationServiceOptions, 'hasLifecycleHooks'>,
    provider: AgentProvider | undefined,
    environment?: NodeJS.ProcessEnv,
): void {
    if (
        (environment && !environment.CAXRI_HOOK_TOKEN) ||
        (provider && options.hasLifecycleHooks?.(provider) === false)
    )
        throw new CaxriError('UNAVAILABLE', 'Visible delegation requires active lifecycle hooks', {
            reason: 'lifecycle_hooks_required',
        });
}

/**
 * The receipt failure for a child launch that threw: `hooks_required` names the one cause the caller can fix.
 */
export function childLaunchFailure(error: unknown): AgentDelegationReceipt['failure'] {
    return isCaxriError(error) && error.details?.reason === 'lifecycle_hooks_required'
        ? 'hooks_required'
        : 'launch_failed';
}

/**
 * A Chat child's completion, read from the Chat's projection instead of a provider transcript: the projection holds the
 * turn's final assistant message, which is what a PTY child's transcript proves. Claude Code's answer must also match
 * the digest its `turnFinished` carried. A Chat this Server Core no longer holds (closed while collecting) proves
 * nothing, so its answer is missing rather than guessed from another source.
 */
export function chatDelegationCompletion(
    record: StoredAgentDelegation,
    turn: DelegationChatTurn,
): DelegationCompletion | undefined {
    if (turn.status === 'running') return undefined;
    if (turn.status !== 'finished') return { kind: 'failed', failure: 'result_missing' };
    if (turn.outcome !== 'completed') return { kind: 'failed', failure: 'provider_failed' };
    if (!turn.answer) return { kind: 'failed', failure: 'result_missing' };
    if (turn.isTruncated) return { kind: 'failed', failure: 'payload_overflow' };
    if (
        record.responseDigest &&
        createHash('sha256').update(turn.answer.text).digest('hex') !== record.responseDigest
    )
        return { kind: 'failed', failure: 'correlation_missing' };
    return { kind: 'answer', text: turn.answer.text, messageId: turn.answer.id };
}

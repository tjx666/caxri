import { createHash } from 'node:crypto';

import type { AgentLaunchSettings, AgentProvider } from '@caxri/protocol';
import { canUseAgentChat } from '@caxri/protocol';

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
 * Whether a Chat of this provider can carry a Commander task: it reports the prompt digest and turn end that correlate
 * the task. Shared by visible children and Commander hand-overs, so a Grok Build Chat is never accepted as
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
 * The dispatch launch of a new visible child. With `session.openAgentsInChat` on, a Claude Code or Codex child opens as
 * an Agent Chat: it starts with the task's frozen launch settings plus read access to the task directory (the same
 * launch a `--resume` uses), and receives the task pointer as its first message instead of in argv. Claude Code also
 * presets the conversation id the task was admitted with. Every other child keeps the PTY launch unchanged.
 */
export function delegationChildLaunch(
    options: Pick<AgentDelegationServiceOptions, 'opensAgentsInChat' | 'userDataPath'>,
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
    if (
        !options.opensAgentsInChat?.() ||
        !canChatCorrelateTask(provider) ||
        !canUseAgentChat(provider)
    )
        return {
            launch: prepared.launch,
            initialPrompt: prepared.initialPrompt,
            assignedAgentSessionId: prepared.assignedAgentSessionId,
        };
    return {
        surface: 'chat',
        launch: delegationResumeLaunch(record, options.userDataPath),
        initialPrompt: prepared.pointer,
        assignedAgentSessionId: record.providerSessionId,
    };
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

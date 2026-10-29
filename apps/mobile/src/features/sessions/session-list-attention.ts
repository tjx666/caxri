import { isAgentChatTerminal } from '../agent-chat/agent-chat-model';
import type { MobileSessionItem } from './session-model';

/**
 * Where a waiting Session's approval is answered in the Sessions list. A Chat keeps its requests in the Agent Chat
 * projection (`mobile.agentChat.requests`) and a PTY Terminal Agent in the hook-registered attention list
 * (`mobile.attention.list`); the two never overlap, so a Chat must not fall back to the Terminal it does not have.
 */
export type SessionListAttentionSource = 'chat' | 'terminal';

export const sessionListAttentionSource = (
    session: Pick<MobileSessionItem, 'primaryTerminal'>,
): SessionListAttentionSource =>
    isAgentChatTerminal(session.primaryTerminal) ? 'chat' : 'terminal';

/**
 * Whether a Terminal Session with no request listed points the user at its Terminal. Claude Code registers every
 * request through hooks, so an empty list there only means the poll has not caught up; other providers may be waiting
 * on a prompt only the Terminal shows.
 */
export const shouldListFallbackToTerminal = (
    session: Pick<MobileSessionItem, 'primaryTerminal'>,
): boolean =>
    sessionListAttentionSource(session) === 'terminal' &&
    session.primaryTerminal?.provider !== 'claude';

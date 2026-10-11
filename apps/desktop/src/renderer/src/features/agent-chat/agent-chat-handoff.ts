import type { AgentProvider } from '@caxri/protocol';

/**
 * What the new Chat needs to find and continue the previous one.
 */
export interface AgentChatHandoff {
    providerName: string;
    provider: AgentProvider | undefined;
    title: string;
    agentSessionId: string | undefined;
    transcriptPath: string;
    cwd: string;
    /**
     * The composer's unsent draft, which the new Chat handles once it has caught up.
     */
    pendingRequest: string;
}

/**
 * The cheap model the reader subagent runs on. The transcript of an expired Chat is large by definition, and only a
 * concise handoff of it has to reach the new Chat's context.
 */
const readerModel = (provider: AgentProvider | undefined): string =>
    provider === 'claude' ? 'the Haiku model' : 'your fastest, lowest-cost model';

/**
 * The first message of the continuing Chat. It points at the previous transcript instead of pasting it, and has a cheap
 * subagent condense it, so the new Chat starts from a short handoff rather than rewriting the expired context.
 */
export function agentChatHandoffPrompt(handoff: AgentChatHandoff): string {
    const pendingRequest = handoff.pendingRequest.trim();
    return [
        'Continue the unfinished work from a previous Agent conversation. Its prompt cache expired, so this new conversation picks the work up with a fresh context instead of paying to rewrite the old one.',
        '',
        `Previous conversation: ${handoff.title}`,
        `Previous Agent: ${handoff.providerName}`,
        `Previous session ID: ${handoff.agentSessionId ?? 'unknown'}`,
        `Previous transcript: ${handoff.transcriptPath}`,
        `Working directory: ${handoff.cwd}`,
        '',
        `First, dispatch exactly one subagent on ${readerModel(handoff.provider)}. Have it read the previous transcript and return a concise handoff covering the goal, the user's corrections, scope and authorization, completed work, current repository and external state, running processes, verification, blockers, and the exact next step. Do not load the full transcript yourself before that handoff arrives.`,
        '',
        'After the subagent returns, re-verify any state that may have changed, keep unrelated work intact, and continue the original task. Do not redo work that is already done.',
        '',
        pendingRequest
            ? `The user's new request, to handle after catching up:\n${pendingRequest}`
            : 'The user has no new request yet: continue where the previous conversation left off.',
    ].join('\n');
}

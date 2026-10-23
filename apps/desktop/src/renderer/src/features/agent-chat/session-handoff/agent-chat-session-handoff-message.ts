import type { SessionRecord, TerminalRecord } from '@caxri/protocol';
import {
    agentChatSessionHandoffText,
    delegationProviderSchema,
    parseAgentChatSessionHandoffCommand,
} from '@caxri/protocol';

/**
 * The text the composer sends for `sent`: the hand-off instructions for a `/new-session [next task]` draft
 * (`agentChatSessionHandoffText`), naming the Chat's own Project and provider so the new Session continues with the
 * same Agent; any other draft unchanged. A Chat whose Session or provider is unknown sends the draft as typed rather
 * than instructions that would name the wrong Project.
 */
export function agentChatSessionHandoffMessage(
    sent: string,
    terminal: Pick<TerminalRecord, 'kind' | 'provider' | 'sessionId'> | undefined,
    sessions: ReadonlyArray<Pick<SessionRecord, 'id' | 'projectId'>> | undefined,
): string {
    const note = parseAgentChatSessionHandoffCommand(sent);
    if (note === undefined || !terminal) return sent;
    const provider = delegationProviderSchema.safeParse(terminal.provider ?? terminal.kind);
    const projectId = sessions?.find((session) => session.id === terminal.sessionId)?.projectId;
    if (!projectId || !provider.success) return sent;
    return agentChatSessionHandoffText({ note, projectId, provider: provider.data });
}

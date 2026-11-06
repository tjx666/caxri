import type { TerminalRecord } from '@caxri/protocol';

import { FreshChatHeading } from '../session/fresh-chat-heading';
import { useIsFreshChatSession } from '../session/fresh-chat-session';

/**
 * What an empty Chat says in place of a timeline, and the hint under it on what the composer accepts. A Chat handed
 * over to another client takes no input here, so it shows no hint.
 *
 * A fresh Chat (`useIsFreshChatSession`) replaces the message line with its Project and Agent picker while nothing was
 * sent yet; the pane passes `freshChatTerminal` only while no message is pending, so the picker leaves with the first
 * send instead of waiting for the reply. A Chat that takes no input here (no `hint`) offers no picker either.
 */
export function AgentChatEmptyState({
    freshChatTerminal,
    hint,
    message,
}: {
    freshChatTerminal: TerminalRecord | undefined;
    hint: string | false;
    message: string | undefined;
}) {
    const isFresh = useIsFreshChatSession(freshChatTerminal?.sessionId);
    if (!message) return null;
    return (
        <div className="flex flex-col items-center gap-1.5 py-8 text-center">
            {isFresh && freshChatTerminal && hint ? (
                <FreshChatHeading terminal={freshChatTerminal} />
            ) : (
                <p className="m-0 text-[13px] text-muted">{message}</p>
            )}
            {hint && <p className="m-0 text-[11px] leading-4 text-muted">{hint}</p>}
        </div>
    );
}

import { Forward } from 'lucide-react';

import { useTranslation } from '../../../../i18n';
import { useSessionById, useTerminal } from '../../../../stores/selectors';
import { sessionTitleForDisplay } from '../../../session/session-title';
import { AgentChatOriginParentLink } from '../agent-chat-origin-parent-link';
import { useCanShowDelegatedSessions } from '../hooks/use-can-show-delegated-sessions';
import { independentOrigin } from './agent-chat-independent-origin';

/**
 * The first row of the composer strip in a Chat an Agent started as an independent Session: who started it, whose name
 * is the way back to that Session. It says nothing of results, takeover, or hand-back, because the Session is the
 * user's own. An archived creator is named without a way back. Renders nothing for any other Session.
 */
export function AgentChatIndependentOriginRow({ terminalId }: { terminalId: string }) {
    const { t } = useTranslation();
    const canShow = useCanShowDelegatedSessions();
    const session = useSessionById(useTerminal(terminalId)?.sessionId);
    const parent = useSessionById(session?.createdBySessionId);
    const origin = canShow && session ? independentOrigin(session, parent) : undefined;
    if (!origin) return null;
    const title = sessionTitleForDisplay(origin.parent.title, t);
    return (
        <div
            className="flex min-w-0 items-center gap-2 border-0 border-b border-solid border-border px-3 py-1.5 text-xs leading-5 text-muted"
            data-agent-chat-composer-strip-row=""
            data-agent-chat-independent-origin=""
        >
            <Forward aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
                {t('delegation.origin.startedFrom')}{' '}
                <AgentChatOriginParentLink
                    isArchived={origin.isParentArchived}
                    parentId={origin.parent.id}
                    title={title}
                />
            </span>
        </div>
    );
}

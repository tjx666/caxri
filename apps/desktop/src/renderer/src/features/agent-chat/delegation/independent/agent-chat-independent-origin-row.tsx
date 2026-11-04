import { Forward } from 'lucide-react';

import { useTranslation } from '../../../../i18n';
import { useSessionById, useTerminal } from '../../../../stores/selectors';
import { openSession } from '../../../session/session-commands';
import { sessionTitleForDisplay } from '../../../session/session-title';
import { useCanShowDelegatedSessions } from '../hooks/use-can-show-delegated-sessions';
import { independentOrigin } from './agent-chat-independent-origin';

/**
 * The first row of the composer strip in a Chat an Agent started as an independent Session: who started it, and a way
 * back to that Session. It says nothing of results, takeover, or hand-back, because the Session is the user's own. An
 * archived creator is named without a way back. Renders nothing for any other Session.
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
                {t('delegation.origin.startedFrom', { title })}
            </span>
            {!origin.isParentArchived && (
                <button
                    className="ml-auto max-w-3/5 min-w-0 shrink-0 cursor-pointer truncate border-0 bg-transparent p-0 text-xs text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                    type="button"
                    onClick={() => openSession(origin.parent.id)}
                >
                    {t('delegation.origin.back', { title })}
                </button>
            )}
        </div>
    );
}

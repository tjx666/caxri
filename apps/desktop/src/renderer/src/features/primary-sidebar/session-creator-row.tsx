import type { SessionRecord } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { useCaxriQuery } from '../../queries/client';
import { useSessions } from '../../stores/selectors';
import { useCommanderManagedSessions } from '../agent-commander/hooks/use-commander-managed-sessions';
import { openSession } from '../session/session-commands';
import { sessionTitleForDisplay } from '../session/session-title';
import { resolveSessionCreator } from './session-creator';

/**
 * The detail card's "Created by" row for a Session an Agent created. Mounted only while the card is open, so its
 * Workbench and Commander reads never re-render the tree's rows. An open creating Session is a link that selects it; an
 * archived one is plain text, because navigating there must not silently restore it.
 */
export function SessionCreatorRow({ session }: { session: SessionRecord }) {
    const { t } = useTranslation();
    const sessions = useSessions();
    useCommanderManagedSessions();
    const commanderSessionId = useCaxriQuery(
        'commander.managedSessions',
        {},
        {
            refetchOnMount: false,
            select: (managed) => managed.commanderSessionId,
            staleTime: Infinity,
        },
    ).data;
    const creator = resolveSessionCreator(session, sessions ?? [], commanderSessionId);
    if (!creator) return null;
    return (
        <div className="session-card-creator mt-2 flex items-center justify-between gap-3 text-[11px] text-muted">
            <span className="flex-none">{t('primarySidebar.card.createdBy')}</span>
            {creator.kind === 'session' ? (
                <button
                    className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-right text-[11px] text-foreground underline-offset-2 hover:underline"
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        openSession(creator.session.id);
                    }}
                >
                    {sessionTitleForDisplay(creator.session.displayTitle, t)}
                </button>
            ) : (
                <span className="min-w-0 truncate text-right text-foreground">
                    {creator.kind === 'commander'
                        ? t('primarySidebar.card.createdByCommander')
                        : t('primarySidebar.card.createdByArchived', {
                              title: sessionTitleForDisplay(creator.title, t),
                          })}
                </span>
            )}
        </div>
    );
}

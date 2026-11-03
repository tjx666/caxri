import { Forward } from 'lucide-react';

import { useTranslation } from '../../../i18n';
import { useProjectById, useSessionById, useTerminal } from '../../../stores/selectors';
import { DelegationRetryControls } from '../../delegation/delegation-retry-controls';
import { openSession } from '../../session/session-commands';
import { sessionTitleForDisplay } from '../../session/session-title';
import { useDelegationOrigin } from './hooks/use-delegation-origin';

/**
 * The first row of the composer strip in a Chat another Session delegated its work to: who delegated, that the result
 * goes back on its own, and a way back to that Session. Until the user takes the Session over it also warns that
 * sending a message, Stop, or Rewind here does so; afterwards it says the replies no longer go back. An archived parent
 * is named without a way back, because navigating to it never restores it. Renders nothing for a hand-off, an unrelated
 * Session, or a parent that is gone.
 *
 * Not collapsible: it is the Session's standing context, and folding it would hide the warning exactly when it matters.
 */
export function AgentChatDelegationOriginRow({ terminalId }: { terminalId: string }) {
    const { t } = useTranslation();
    const { origin, task } = useDelegationOrigin(terminalId);
    const sessionId = useTerminal(terminalId)?.sessionId;
    const session = useSessionById(sessionId);
    const project = useProjectById(session?.projectId);
    if (!origin) return null;
    const title = sessionTitleForDisplay(origin.parent.title, t);
    return (
        <div
            className="flex min-w-0 flex-col gap-0.5 border-0 border-b border-solid border-border px-3 py-1.5 text-[12px] leading-5 text-muted"
            data-agent-chat-composer-strip-row=""
            data-agent-chat-delegation-origin={origin.isTakenOver ? 'taken-over' : 'delegated'}
        >
            <span className="flex min-w-0 items-center gap-2">
                <Forward aria-hidden="true" className="size-3.5 shrink-0" />
                {origin.isTakenOver ? (
                    <span className="min-w-0 truncate">
                        <span className="text-foreground">{t('delegation.origin.takenOver')}</span>
                        {' · '}
                        {t('delegation.origin.takenOverDetail', { title })}
                    </span>
                ) : (
                    <>
                        <span className="min-w-0 truncate">
                            <span className="text-foreground">
                                {t('delegation.origin.from', { title })}
                            </span>
                            {!origin.isParentArchived && (
                                <>
                                    {' · '}
                                    {t('delegation.origin.autoReturn')}
                                </>
                            )}
                        </span>
                        {!origin.isParentArchived && (
                            <button
                                className="ml-auto max-w-[40%] shrink-0 cursor-pointer truncate border-0 bg-transparent p-0 text-[12px] text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                                type="button"
                                onClick={() => openSession(origin.parent.id)}
                            >
                                {t('delegation.origin.back', { title })}
                            </button>
                        )}
                    </>
                )}
            </span>
            {!origin.isTakenOver && !origin.isParentArchived && (
                <span className="min-w-0 pl-5">{t('delegation.origin.hint', { title })}</span>
            )}
            {task && (
                <DelegationRetryControls
                    className="pl-5"
                    entry={task}
                    projectTitle={project?.title ?? ''}
                    sessionTitle={sessionTitleForDisplay(session?.title ?? '', t)}
                />
            )}
        </div>
    );
}

import { Forward } from 'lucide-react';

import { useTranslation } from '../../../i18n';
import { useProjectById, useSessionById, useTerminal } from '../../../stores/selectors';
import { DelegationPresetChip } from '../../delegation/delegation-preset-chip';
import { DelegationQuestionCard } from '../../delegation/delegation-question-card';
import { DelegationRetryControls } from '../../delegation/delegation-retry-controls';
import { openSession } from '../../session/session-commands';
import { sessionTitleForDisplay } from '../../session/session-title';
import type { DelegationOrigin } from './agent-chat-delegation-origin';
import { originReturnNoteKey } from './agent-chat-delegation-origin';
import { AgentChatHandBackButton } from './hand-back/agent-chat-hand-back-button';
import { AgentChatHandBackReason } from './hand-back/agent-chat-hand-back-reason';
import { AgentChatTakenOverDetail as TakenOverDetail } from './hand-back/agent-chat-taken-over-detail';
import { useDelegationOrigin } from './hooks/use-delegation-origin';

/**
 * What a not-yet-taken-over origin row says after the parent's name: that the result goes back on its own, that the
 * Agent which delegated this is answering a question or deciding a permission request, or (amber) that it is the user's
 * to answer.
 */
function OriginReturnNote({
    hasApproval,
    isEscalated,
    isWaitingOnParent,
    title,
}: {
    hasApproval: boolean;
    isEscalated: boolean;
    isWaitingOnParent: boolean;
    title: string;
}) {
    const { t } = useTranslation();
    const text = t(originReturnNoteKey({ hasApproval, isEscalated, isWaitingOnParent }), {
        title,
    });
    return isEscalated ? <span className="text-warning">{text}</span> : text;
}

/**
 * The left side of a not-yet-taken-over origin row: who delegated, the preset, and what happens to the result.
 */
function DelegatedSummary({
    isEscalated,
    origin,
    task,
    title,
}: {
    isEscalated: boolean;
    origin: DelegationOrigin;
    task: ReturnType<typeof useDelegationOrigin>['task'];
    title: string;
}) {
    const { t } = useTranslation();
    return (
        <span className="min-w-0 truncate">
            <span className="text-foreground">{t('delegation.origin.from', { title })}</span>
            {task?.selection?.preset && ' '}
            <DelegationPresetChip isDetailVisible selection={task?.selection} />
            {!origin.isParentArchived && (
                <>
                    {' · '}
                    <OriginReturnNote
                        hasApproval={task?.approval !== undefined}
                        isEscalated={isEscalated}
                        isWaitingOnParent={origin.isWaitingOnParent}
                        title={title}
                    />
                </>
            )}
        </span>
    );
}

/**
 * The first row of the composer strip in a Chat another Session delegated its work to: who delegated, that the result
 * goes back on its own, and a way back to that Session. Until the user takes the Session over it also warns that
 * sending a message, Stop, or Rewind here does so; afterwards it says the replies no longer go back, and the way back
 * stays. An archived parent is named without a way back, because navigating to it never restores it. Renders nothing
 * for a hand-off, an unrelated Session, or a parent that is gone.
 *
 * Not collapsible: it is the Session's standing context, and folding it would hide the warning exactly when it matters.
 */
export function AgentChatDelegationOriginRow({
    isBusy,
    terminalId,
}: {
    /**
     * Whether this Chat is in a turn or holds queued messages, which blocks handing the Session back.
     */
    isBusy: boolean;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const { origin, task } = useDelegationOrigin(terminalId);
    const sessionId = useTerminal(terminalId)?.sessionId;
    const session = useSessionById(sessionId);
    const project = useProjectById(session?.projectId);
    if (!origin) return null;
    const title = sessionTitleForDisplay(origin.parent.title, t);
    const isEscalated = !origin.isTakenOver && task?.waitingOn === 'user';
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
                        <TakenOverDetail
                            isBusy={isBusy}
                            origin={origin}
                            terminalId={terminalId}
                            title={title}
                        />
                    </span>
                ) : (
                    <DelegatedSummary
                        isEscalated={isEscalated}
                        origin={origin}
                        task={task}
                        title={title}
                    />
                )}
                <span className="ml-auto flex max-w-[60%] shrink-0 items-center gap-3">
                    {origin.isTakenOver && (
                        <AgentChatHandBackButton
                            delegationId={task?.delegationId}
                            isBusy={isBusy}
                            origin={origin}
                            terminalId={terminalId}
                            title={title}
                        />
                    )}
                    {!origin.isParentArchived && (
                        <button
                            className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-[12px] text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                            type="button"
                            onClick={() => openSession(origin.parent.id)}
                        >
                            {t('delegation.origin.back', { title })}
                        </button>
                    )}
                </span>
            </span>
            {origin.isTakenOver && (
                <AgentChatHandBackReason
                    isBusy={isBusy}
                    origin={origin}
                    terminalId={terminalId}
                    title={title}
                />
            )}
            {!origin.isTakenOver && !origin.isParentArchived && (
                <span className="min-w-0 pl-5">{t('delegation.origin.hint', { title })}</span>
            )}
            {task && <DelegationQuestionCard className="pl-5" entry={task} parentTitle={title} />}
            {task && (
                <DelegationRetryControls
                    className="pl-5"
                    entry={task}
                    projectId={session?.projectId}
                    projectTitle={project?.title ?? ''}
                    sessionTitle={sessionTitleForDisplay(session?.title ?? '', t)}
                />
            )}
        </div>
    );
}

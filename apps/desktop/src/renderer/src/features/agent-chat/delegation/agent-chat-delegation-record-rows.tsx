import type {
    AgentChatCommandDelegation,
    AgentChatWorkItem,
    AgentDelegationStatusEntry,
} from '@caxri/protocol';
import { Forward } from 'lucide-react';

import { useClockTick } from '@/hooks/use-clock-tick';

import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { useProjectById, useSessionById } from '../../../stores/selectors';
import { delegationCopy, delegationCopyInput } from '../../delegation/delegation-copy';
import { useDelegationStatuses } from '../../delegation/hooks/use-delegation-statuses';
import { openSession } from '../../session/session-commands';
import { sessionTitleForDisplay } from '../../session/session-title';
import { AgentChatDelegationGlyph } from './agent-chat-delegation-glyph';
import { delegationRecordsOf } from './agent-chat-delegation-records';
import { useIsDelegationLive } from './hooks/use-is-delegation-live';

const NO_IDS: readonly string[] = [];

const ROW_CLASS_NAME =
    'flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-[12px] leading-5 text-muted';

/**
 * One delegation in the timeline: "Delegated to <child title> · <child Project>", with the state of that task (not of
 * the Session's newest one) as the glyph. The row opens the child. A child the Workbench no longer lists reads as
 * unavailable and does not open.
 */
function DelegationRecordRow({
    delegation,
    isLive,
    status,
}: {
    delegation: AgentChatCommandDelegation;
    isLive: boolean;
    status: AgentDelegationStatusEntry | undefined;
}) {
    const { t } = useTranslation();
    const now = useClockTick('minute', isLive);
    const session = useSessionById(delegation.sessionId);
    const project = useProjectById(session?.projectId);
    const copy = delegationCopy(status ? delegationCopyInput(status) : {}, now, t);
    // A task whose state the Server no longer has shows no state rather than the "No task details" headline.
    const glyph = status ? copy.glyph : 'ordinary';
    const title = session ? sessionTitleForDisplay(session.title, t) : undefined;
    const content = (
        <>
            <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                <Forward aria-hidden="true" className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">
                {title === undefined ? (
                    t('delegation.record.unavailable')
                ) : (
                    <>
                        {t('delegation.record.label', { title })}
                        {project && ` · ${project.title}`}
                    </>
                )}
            </span>
            <AgentChatDelegationGlyph glyph={glyph} label={copy.headline} />
        </>
    );
    return title === undefined ? (
        <div className={ROW_CLASS_NAME} data-agent-chat-delegation-record={delegation.delegationId}>
            {content}
        </div>
    ) : (
        <button
            aria-label={
                status
                    ? t('delegation.record.openAria', { status: copy.headline, title })
                    : t('delegation.record.openAriaUnknown', { title })
            }
            className={cn(
                ROW_CLASS_NAME,
                'cursor-pointer border-0 bg-transparent text-left hover:bg-list-hover-background hover:text-list-hover-foreground focus-visible:outline focus-visible:outline-accent',
            )}
            data-agent-chat-delegation-record={delegation.delegationId}
            type="button"
            onClick={() => openSession(delegation.sessionId)}
        >
            {content}
        </button>
    );
}

/**
 * The record rows of one command that delegated work, in place of its ordinary command row. The tasks' states are read
 * together, once for the command, by task ID; the rows hold IDs only and the titles, Projects, and states are joined
 * here at render time, so no answer text or summary ever reaches the transcript.
 *
 * A Chat kept alive behind another Session reads no states and ticks no clock (`DelegationLiveContext`): it asks for no
 * task IDs, so the pushes that refresh them re-render nothing here, and showing the Session reads the cached states
 * again.
 */
export function AgentChatDelegationRecordRows({ item }: { item: AgentChatWorkItem }) {
    const delegations = delegationRecordsOf(item);
    const isLive = useIsDelegationLive();
    const statuses = useDelegationStatuses(
        isLive ? delegations.map((delegation) => delegation.delegationId) : NO_IDS,
    );
    return (
        <div className="flex flex-col">
            {delegations.map((delegation) => (
                <DelegationRecordRow
                    delegation={delegation}
                    isLive={isLive}
                    key={delegation.delegationId}
                    status={statuses.get(delegation.delegationId)}
                />
            ))}
        </div>
    );
}

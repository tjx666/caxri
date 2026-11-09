import { CircleX } from 'lucide-react';

import { useClockTick } from '@/hooks/use-clock-tick';

import { Empty, EmptyMedia, EmptyTitle } from '../../../../components/ui/empty';
import { useTranslation } from '../../../../i18n';
import { useProjectById, useSessionById } from '../../../../stores/selectors';
import {
    delegationCopy,
    delegationCopyInput,
    isDelegationCopyClockDependent,
} from '../../../delegation/delegation-copy';
import { DelegationRetryControls } from '../../../delegation/delegation-retry-controls';
import { sessionTitleForDisplay } from '../../../session/session-title';
import type { DelegationOriginState } from '../hooks/use-delegation-origin';

/**
 * The empty Session page of a delegated task that failed before it launched anything: the failure and its next steps
 * ("Enable hooks", Retry), the same ones the asking Chat's strip offers, instead of a bare "No terminals" page that
 * says nothing about why. The caller decides when it applies, from the same origin read.
 */
export function AgentChatDelegationFailedPane({
    sessionId,
    task,
}: {
    sessionId: string;
    task: NonNullable<DelegationOriginState['task']>;
}) {
    const { t } = useTranslation();
    const session = useSessionById(sessionId);
    const project = useProjectById(session?.projectId);
    const copyInput = delegationCopyInput(task);
    // Only a usage-limit reset or a scheduled retry ages; any other failure reads no clock.
    const now = useClockTick('minute', isDelegationCopyClockDependent(copyInput));
    const copy = delegationCopy(copyInput, now, t);
    return (
        <Empty className="empty-work h-full flex-1" data-delegation-failed-pane={task.delegationId}>
            <EmptyMedia>
                <CircleX className="text-danger" size={30} />
            </EmptyMedia>
            <EmptyTitle>{copy.headline}</EmptyTitle>
            {copy.detail && <p className="m-0 text-xs text-muted">{copy.detail}</p>}
            <DelegationRetryControls
                className="justify-center text-xs"
                entry={task}
                projectId={session?.projectId}
                projectTitle={project?.title ?? ''}
                sessionTitle={sessionTitleForDisplay(session?.title ?? '', t)}
            />
        </Empty>
    );
}

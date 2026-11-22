import type { AgentDelegationSession } from '@caxri/protocol';
import { formatNoticeableDuration } from '@caxri/protocol';

import { useClockTick } from '@/hooks/use-clock-tick';

import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { AgentIdentityIcon } from '../../../icons/agents/agent-identity-icon';
import { cn } from '../../../lib/utilities';
import { useProjectById, useSessionById } from '../../../stores/selectors';
import type { DelegationGlyph } from '../../delegation/delegation-copy';
import {
    delegationCopy,
    delegationCopyInput,
    isDelegationCopyClockDependent,
} from '../../delegation/delegation-copy';
import { delegationElapsedMs } from '../../delegation/delegation-feed';
import { delegationPresetSummary } from '../../delegation/delegation-preset';
import { DelegationPresetChip } from '../../delegation/delegation-preset-chip';
import { DelegationRetryControls } from '../../delegation/delegation-retry-controls';
import { sessionTitleForDisplay } from '../../session/session-title';
import { AgentChatStripDismissButton } from '../composer/strip/agent-chat-strip-dismiss-button';
import { AgentChatStripRowSlot } from '../composer/strip/agent-chat-strip-row-slot';
import { AgentChatDelegationGlyph } from './agent-chat-delegation-glyph';
import type { DelegatedCostLabel } from './cost/agent-chat-delegated-cost';
import { useCanOpenDelegatedChild } from './hooks/use-can-open-delegated-child';
import { openDelegatedChild } from './side-view/delegated-child-opener';

/**
 * The status text's tone: amber for a task waiting on the user, red for a failure or for any other state that needs
 * them (an interruption draws no glyph of its own), muted otherwise.
 */
function statusTone(glyph: DelegationGlyph, requiresUser: boolean): string | undefined {
    if (glyph === 'needsInput') return 'text-warning';
    if (glyph === 'failed' || requiresUser) return 'text-danger';
    return undefined;
}

/**
 * The row's visible content on one line: the Agent, title, Project, preset, attempt, the parent it sits under, the
 * state in words unless it is simply running, then cost and elapsed time. The running step is left out: the row says
 * which work is open, and opening it shows what it is doing.
 */
function DelegatedSessionRowContent({
    attempt,
    cost,
    elapsed,
    entry,
    glyph,
    isPresetDetailVisible,
    requiresUser,
    projectTitle,
    status,
    title,
    viaTitle,
}: {
    attempt?: number;
    cost?: DelegatedCostLabel;
    elapsed: string | null;
    entry: AgentDelegationSession;
    glyph: DelegationGlyph;
    /**
     * Prints the preset's provider, model and effort in the row, for a row with no tooltip to carry them.
     */
    isPresetDetailVisible: boolean;
    requiresUser: boolean;
    projectTitle?: string;
    /**
     * The state in words, absent while the task simply runs.
     */
    status?: string;
    title: string;
    /**
     * The direct child a deeper row sits under, titled; absent for a direct child.
     */
    viaTitle?: string;
}) {
    const { t } = useTranslation();
    return (
        <>
            <span className="flex size-4 shrink-0 items-center justify-center">
                <AgentIdentityIcon identity={entry.provider} size={14} />
            </span>
            <span className="min-w-0 truncate text-foreground">{title}</span>
            {projectTitle && <span className="min-w-0 shrink truncate">{projectTitle}</span>}
            <DelegationPresetChip
                isDetailVisible={isPresetDetailVisible}
                selection={entry.selection}
            />
            {attempt !== undefined && (
                <span className="shrink-0">
                    {t('delegation.retry.attempt', { number: attempt })}
                </span>
            )}
            {viaTitle !== undefined && (
                <span className="min-w-0 shrink truncate">
                    {t('delegation.strip.via', { title: viaTitle })}
                </span>
            )}
            {status && (
                <span className={cn('min-w-0 shrink truncate', statusTone(glyph, requiresUser))}>
                    {status}
                </span>
            )}
            <span className="ml-auto flex shrink-0 gap-2 pl-1 tabular-nums">
                {cost && (
                    <span>
                        <span aria-hidden="true">{cost.text}</span>
                        <span className="sr-only">{cost.description}</span>
                    </span>
                )}
                {elapsed && <span>{elapsed}</span>}
            </span>
        </>
    );
}

const ROW_CLASS_NAME =
    'flex min-w-0 flex-1 items-center gap-2 rounded border-0 bg-transparent px-2 py-0.5 text-left text-[12px] leading-5 text-muted';

/**
 * One child Session in the composer strip's Background work list, on one line: the Agent, the child's title and
 * Project, its state in words when it is not simply running, its cost and elapsed time, and the state glyph. The row
 * opens the child; a failed task's Retry action sits under it as its own control, and a failure or interruption the
 * user has seen gives way to Dismiss (`onDismiss`) on hover or focus. The button has no `aria-label` of its own: its
 * content names it, so assistive technology hears what a sighted user reads. A child the Workbench no longer lists
 * (deleted, or in a hidden Project), or a failed one that never launched a Terminal, stays as a plain row.
 */
export function AgentChatDelegatedSessionRow({
    attempt,
    cost,
    entry,
    requiresUser,
    viaSessionId,
    onDismiss,
}: {
    /**
     * Which attempt this task is when it retries a failed one (2 or more); `undefined` for a first attempt.
     */
    attempt?: number;
    /**
     * What the child's work cost, as an estimate (`delegatedCostLabel`); absent when it has no usage yet.
     */
    cost?: DelegatedCostLabel;
    entry: AgentDelegationSession;
    requiresUser: boolean;
    /**
     * The direct child this row sits under, for a deeper Session the roll-up lists; absent for a direct child.
     */
    viaSessionId?: string;
    /**
     * Dismisses a failure or interruption from the list; absent for a row the user cannot dismiss.
     */
    onDismiss?: () => void;
}) {
    const { t } = useTranslation();
    const session = useSessionById(entry.sessionId);
    const viaSession = useSessionById(viaSessionId);
    const project = useProjectById(session?.projectId);
    const isOpenable = useCanOpenDelegatedChild(entry.sessionId, entry.status === 'failed');
    const copyInput = delegationCopyInput(entry);
    // A minute tick ages the elapsed label of a running task and expires a reset or retry time in the status words; a
    // settled task with neither reads no clock at all.
    const now = useClockTick(
        'minute',
        entry.settledAt === undefined || isDelegationCopyClockDependent(copyInput),
    );
    const copy = delegationCopy(copyInput, now, t);
    const title = session
        ? sessionTitleForDisplay(session.title, t)
        : t('delegation.strip.unavailable');
    const presetSummary = delegationPresetSummary(entry.selection, t);
    const content = (
        <DelegatedSessionRowContent
            attempt={attempt}
            cost={cost}
            elapsed={formatNoticeableDuration(delegationElapsedMs(entry, now), t)}
            entry={entry}
            glyph={copy.glyph}
            isPresetDetailVisible={!session}
            requiresUser={requiresUser}
            projectTitle={project?.title}
            status={
                copy.glyph === 'running'
                    ? undefined
                    : [copy.headline, copy.detail].filter(Boolean).join(' · ')
            }
            title={title}
            viaTitle={
                viaSessionId === undefined
                    ? undefined
                    : viaSession
                      ? sessionTitleForDisplay(viaSession.title, t)
                      : t('delegation.strip.unavailable')
            }
        />
    );
    return (
        <li
            className="group/row flex min-w-0 list-none flex-col"
            data-agent-chat-delegated-session={entry.sessionId}
        >
            <span
                className={cn(
                    'flex min-w-0 items-center gap-1 rounded',
                    isOpenable && 'hover:bg-list-hover-background',
                )}
            >
                {isOpenable ? (
                    <Tooltip content={presetSummary} disabled={presetSummary === undefined}>
                        <button
                            className={cn(
                                ROW_CLASS_NAME,
                                'cursor-pointer hover:text-list-hover-foreground focus-visible:outline focus-visible:outline-accent',
                            )}
                            data-agent-chat-delegated-open=""
                            type="button"
                            onClick={() => openDelegatedChild(entry.sessionId)}
                        >
                            {content}
                        </button>
                    </Tooltip>
                ) : (
                    <div className={ROW_CLASS_NAME}>{content}</div>
                )}
                <AgentChatStripRowSlot
                    action={
                        onDismiss ? (
                            <AgentChatStripDismissButton title={title} onDismiss={onDismiss} />
                        ) : undefined
                    }
                    glyph={<AgentChatDelegationGlyph glyph={copy.glyph} label={copy.headline} />}
                />
            </span>
            {session && (
                <DelegationRetryControls
                    className="pl-8 leading-5"
                    entry={entry}
                    projectId={session.projectId}
                    projectTitle={project?.title ?? ''}
                    sessionTitle={title}
                />
            )}
        </li>
    );
}

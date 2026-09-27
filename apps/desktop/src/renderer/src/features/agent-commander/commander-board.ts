import type {
    AgentActivityState,
    AgentDelegationReceipt,
    CommanderBoardGroupId,
    CommanderBoardRow,
    ProcessState,
} from '@caxri/protocol';
import { agentProviderCatalog, commanderBoardGroupIds } from '@caxri/protocol';

import type { AgentActivityGlyphId } from '../agent-activity/agent-activity-glyph';
import type { SessionActivityPresentation } from '../primary-sidebar/session-activity';
import {
    sessionActivityPresentation,
    sessionUnreadTone,
} from '../primary-sidebar/session-activity';
import {
    sessionPullRequestPresentation,
    sessionPullRequestToneClassName,
} from '../primary-sidebar/session-pull-request';

/**
 * The Workbench Activity view's group names, so the same Session reads the same in both windows.
 */
const GROUP_LABELS: Record<CommanderBoardGroupId, string> = {
    attention: 'Needs attention',
    failed: 'Failed',
    finished: 'Recently finished',
    idle: 'Idle',
    waiting: 'Waiting',
    working: 'Working',
};

interface CommanderBoardSection {
    id: CommanderBoardGroupId;
    label: string;
    rows: readonly CommanderBoardRow[];
}

/**
 * Buckets board rows into the protocol's display order and drops empty groups. Rows keep the Server's order within a
 * group, which is already most recent first.
 */
export function commanderBoardSections(
    rows: readonly CommanderBoardRow[],
): CommanderBoardSection[] {
    const rowsByGroup = Map.groupBy(rows, (row) => row.group);
    return commanderBoardGroupIds.flatMap((id) => {
        const groupRows = rowsByGroup.get(id);
        return groupRows ? [{ id, label: GROUP_LABELS[id], rows: groupRows }] : [];
    });
}

/**
 * The same shape per state as the Activity view, so a glyph means one thing everywhere.
 */
const GLYPH_BY_STATE: Record<AgentActivityState, AgentActivityGlyphId> = {
    completed: 'check',
    failed: 'x',
    idle: 'hollow',
    running: 'spinner',
    unknown: 'dashed',
    waiting: 'question',
};

const TONE_TEXT_CLASSNAME: Record<SessionActivityPresentation['tone'], string> = {
    danger: 'text-danger',
    neutral: 'text-muted',
    success: 'text-success',
    warning: 'text-warning',
};

/**
 * A Terminal that is not running cannot be doing what its last activity says, so its process state wins the phrase.
 * `running` is absent on purpose: a live process is described by its Agent activity instead.
 */
const PROCESS_PHRASES: Partial<Record<ProcessState, string>> = {
    dead: 'Exited',
    detached: 'Detached',
    failed: 'Failed to start',
    interrupted: 'Interrupted',
    starting: 'Starting',
    stopped: 'Exited',
    suspended: 'Suspended',
};

interface CommanderRowPresentation {
    /**
     * Which Agent CLI the row's Terminal runs, or `Shell` for a plain shell.
     */
    agentLabel: string;
    glyph: AgentActivityGlyphId;
    /**
     * The glyph's accessible name and hover title.
     */
    glyphLabel: string;
    /**
     * What the Agent is doing, as the row prints it.
     */
    statePhrase: string;
    toneClassName: string;
}

/**
 * Presents one board row. Tone follows the Activity view's two-tier rule: apart from a live turn's green spinner, only
 * a row that asks the user for something (unread, failed) is tinted, so color on the board always means "look here".
 */
export function commanderRowPresentation(row: CommanderBoardRow): CommanderRowPresentation {
    const { agent } = row;
    /**
     * A turn or question recorded before the Agent exited is not happening any more. Without a live Agent the row reads
     * idle, as the Server groups it, instead of spinning next to `Exited`.
     */
    const isAgentAlive = agent?.processState === 'running' || agent?.processState === 'starting';
    const activityState =
        isAgentAlive || (row.activityState !== 'running' && row.activityState !== 'waiting')
            ? row.activityState
            : 'idle';
    const activity = sessionActivityPresentation(
        activityState,
        isAgentAlive ? agent.operation : undefined,
    );
    const processPhrase = agent ? PROCESS_PHRASES[agent.processState] : undefined;
    const statePhrase = agent ? (processPhrase ?? activity.label) : 'No Terminal';
    const agentLabel =
        !agent || agent.kind === 'shell' ? 'Shell' : agentProviderCatalog[agent.kind].displayName;
    if (agent?.processState === 'detached')
        return {
            agentLabel,
            glyph: 'unplug',
            glyphLabel: statePhrase,
            statePhrase,
            toneClassName: TONE_TEXT_CLASSNAME.neutral,
        };
    const isLive =
        activityState === 'running' || (isAgentAlive && agent.operation === 'compacting');
    const glyph = isLive ? 'spinner' : GLYPH_BY_STATE[activityState];
    const tone: SessionActivityPresentation['tone'] = isLive
        ? 'success'
        : row.group === 'attention' && row.hasUnread
          ? sessionUnreadTone(activityState)
          : row.group === 'failed'
            ? 'danger'
            : 'neutral';
    return {
        agentLabel,
        glyph,
        glyphLabel: row.hasUnread ? `Unread. ${activity.label}` : activity.label,
        statePhrase,
        toneClassName: TONE_TEXT_CLASSNAME[tone],
    };
}

interface CommanderPullRequestBadge {
    ariaLabel: string;
    checksLabel?: string;
    checksToneClassName?: string;
    /**
     * `#123`.
     */
    numberLabel: string;
    stateLabel: string;
    title: string;
    toneClassName: string;
    url: string;
}

/**
 * The board's pull request chip: number, lifecycle, and CI, reusing the PrimarySidebar's presentation so a PR reads the
 * same in both windows. Lifecycle and checks keep separate tones, because a red open PR was once mistaken for a closed
 * one. A failed lookup hides the chip, as the Activity view does, since the cached state and checks may be stale.
 */
export function commanderPullRequestBadge({
    pullRequest,
    pullRequestUnavailable,
}: Pick<CommanderBoardRow, 'pullRequest' | 'pullRequestUnavailable'>):
    CommanderPullRequestBadge | undefined {
    if (!pullRequest || pullRequestUnavailable) return undefined;
    const presentation = sessionPullRequestPresentation(pullRequest);
    return {
        ariaLabel: `${presentation.ariaLabel} Open in browser.`,
        ...(presentation.checksLabel && { checksLabel: presentation.checksLabel }),
        ...(presentation.checksTone && {
            checksToneClassName: sessionPullRequestToneClassName(presentation.checksTone),
        }),
        numberLabel: `#${pullRequest.number}`,
        stateLabel: presentation.label,
        title: pullRequest.title,
        toneClassName: sessionPullRequestToneClassName(presentation.tone),
        url: pullRequest.url,
    };
}

/**
 * The task label collapses the delegation lifecycle into what the user acts on. Only a task that needs someone is
 * tinted: a blocked task waits for an answer (usually the Commander's), and a failed one must be retried. `completed`
 * reads `Answered`, not `Done`: it means the Agent gave its final answer, which the Commander still has to verify.
 */
const TASK_PRESENTATION: Record<
    AgentDelegationReceipt['status'],
    { label: string; tone: SessionActivityPresentation['tone'] }
> = {
    answer_unavailable: { label: 'Failed', tone: 'danger' },
    awaiting_ready: { label: 'Starting', tone: 'neutral' },
    blocked: { label: 'Blocked', tone: 'warning' },
    collecting: { label: 'Running', tone: 'neutral' },
    completed: { label: 'Answered', tone: 'neutral' },
    failed: { label: 'Failed', tone: 'danger' },
    human_intervened: { label: 'Taken over', tone: 'neutral' },
    interrupted: { label: 'Stopped', tone: 'neutral' },
    launching: { label: 'Starting', tone: 'neutral' },
    requested: { label: 'Starting', tone: 'neutral' },
    running: { label: 'Running', tone: 'neutral' },
    submitting: { label: 'Starting', tone: 'neutral' },
};

interface CommanderTaskBadge {
    label: string;
    /**
     * Names the delegation so the user can find it in the Commander conversation, plus the failure reason.
     */
    title: string;
    toneClassName: string;
}

/**
 * The current Commander task in a row's Session, or nothing when the Commander never delegated there.
 */
export function commanderTaskBadge(
    task: CommanderBoardRow['task'],
): CommanderTaskBadge | undefined {
    if (!task) return undefined;
    if (task.status === 'blocked' && task.failure === 'startup_waiting')
        return {
            label: 'Needs you',
            title: `Commander task ${task.delegationId}: the Agent is waiting at startup, usually on a first-run prompt such as folder trust or sign-in. Open the Session to answer it; the task continues on its own.`,
            toneClassName: TONE_TEXT_CLASSNAME.warning,
        };
    const { label, tone } = TASK_PRESENTATION[task.status];
    const reason = task.failure ? ` (${task.failure.replaceAll('_', ' ')})` : '';
    return {
        label,
        title: `Commander task ${task.delegationId}: ${label}${reason}`,
        toneClassName: TONE_TEXT_CLASSNAME[tone],
    };
}

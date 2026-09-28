import type {
    AgentActivityState,
    AgentDelegationReceipt,
    CommanderBoard,
    CommanderBoardGroupId,
    CommanderBoardRow,
    ProcessState,
    SessionPullRequests,
} from '@caxri/protocol';
import { agentProviderCatalog, commanderBoardGroupIds } from '@caxri/protocol';
import { isEqual, omit } from 'es-toolkit';

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
 * Which Sessions the Commander window lists. `commander`, the default, is only the Sessions the Commander created: the
 * Workbench already shows every Session, and the user's hand-run Sessions mixed in here buried the work the Commander
 * dispatched. `all` is the whole Workbench, a toggle away. The Server's board (and `caxri commander board`) always
 * covers every Session, so the Commander itself still sees the whole Workbench.
 */
export type CommanderBoardScope = 'all' | 'commander';

/**
 * The rows a scope shows, keeping the Server's order.
 */
export function commanderBoardRowsInScope(
    rows: readonly CommanderBoardRow[],
    scope: CommanderBoardScope,
): readonly CommanderBoardRow[] {
    return scope === 'all' ? rows : rows.filter((row) => row.commanderSession);
}

/**
 * Applies a fresh `session.pullRequests` snapshot to the rows of the named Sessions only, the way the Server's
 * `commanderBoard` projection would have filled their `pullRequest` and `pullRequestUnavailable` fields.
 *
 * Every other row keeps its object, and so does a named row whose pull request did not actually change; a board whose
 * rows all stayed the same comes back as the same object. React Query hands that identity straight to the board, so a
 * pull-request change re-renders the rows it touched and nothing else (issue caxri#1411). A named Session that is not
 * on the board is skipped: the Server decides which Sessions get a row, and the board's own poll adds it.
 */
export function patchCommanderBoardPullRequests(
    board: CommanderBoard,
    snapshot: SessionPullRequests,
    sessionIds: ReadonlySet<string>,
): CommanderBoard {
    const rows = board.rows.map((row) => {
        if (!sessionIds.has(row.sessionId)) return row;
        // The record omits every Session without a pull request, which its index type does not admit.
        const pullRequest = snapshot.pullRequests[row.sessionId] as
            CommanderBoardRow['pullRequest'] | undefined;
        const pullRequestUnavailable = snapshot.unavailable?.[row.sessionId];
        if (
            isEqual(row.pullRequest, pullRequest) &&
            isEqual(row.pullRequestUnavailable, pullRequestUnavailable)
        )
            return row;
        return {
            ...omit(row, ['pullRequest', 'pullRequestUnavailable']),
            ...(pullRequest && { pullRequest }),
            ...(pullRequestUnavailable && { pullRequestUnavailable }),
        };
    });
    return rows.some((row, index) => row !== board.rows[index])
        ? { ...board, pullRequestsRefreshedAt: snapshot.refreshedAt, rows }
        : board;
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
 * The shape a task chip draws, so each status is recognizable before its label is read.
 */
export type CommanderTaskIconId =
    'answered' | 'blocked' | 'failed' | 'running' | 'starting' | 'stopped' | 'taken-over';

/**
 * The task label collapses the delegation lifecycle into what the user acts on. Only a task that needs someone is
 * tinted: a blocked task waits for an answer (usually the Commander's), a failed one must be retried, and a taken-over
 * one is out of the Commander's hands until the user hands it back. `completed` reads `Answered`, not `Done`: it means
 * the Agent gave its final answer, which the Commander still has to verify.
 */
const TASK_PRESENTATION: Record<
    AgentDelegationReceipt['status'],
    {
        description: string;
        icon: CommanderTaskIconId;
        label: string;
        tone: SessionActivityPresentation['tone'];
    }
> = {
    answer_unavailable: {
        description: 'The Agent finished, but its answer could not be read back.',
        icon: 'failed',
        label: 'Failed',
        tone: 'danger',
    },
    awaiting_ready: {
        description: 'The Agent is starting and has not begun the task yet.',
        icon: 'starting',
        label: 'Starting',
        tone: 'neutral',
    },
    blocked: {
        description: 'The Agent stopped to ask a question, usually one the Commander answers.',
        icon: 'blocked',
        label: 'Blocked',
        tone: 'warning',
    },
    collecting: {
        description: 'The Agent finished its turn; the Commander is reading its answer.',
        icon: 'running',
        label: 'Running',
        tone: 'neutral',
    },
    completed: {
        description:
            'The Agent gave its final answer. The Commander still verifies it before reporting.',
        icon: 'answered',
        label: 'Answered',
        tone: 'neutral',
    },
    failed: {
        description: 'The task failed.',
        icon: 'failed',
        label: 'Failed',
        tone: 'danger',
    },
    human_intervened: {
        description:
            'You typed into this Session while the task ran, so it is yours now. The Commander no longer drives it or sends it follow-ups.',
        icon: 'taken-over',
        label: 'Taken over by you',
        tone: 'warning',
    },
    interrupted: {
        description: 'The task stopped before the Agent finished.',
        icon: 'stopped',
        label: 'Stopped',
        tone: 'neutral',
    },
    launching: {
        description: 'The Commander is launching an Agent for this task.',
        icon: 'starting',
        label: 'Starting',
        tone: 'neutral',
    },
    requested: {
        description: 'The Commander is launching an Agent for this task.',
        icon: 'starting',
        label: 'Starting',
        tone: 'neutral',
    },
    running: {
        description: 'The Agent is working on the task.',
        icon: 'running',
        label: 'Running',
        tone: 'neutral',
    },
    submitting: {
        description: 'The Commander is handing the task to the Agent.',
        icon: 'starting',
        label: 'Starting',
        tone: 'neutral',
    },
};

interface CommanderTaskBadge {
    icon: CommanderTaskIconId;
    label: string;
    /**
     * What the status means for the user, the failure reason, and the delegation ID so the user can find the task in
     * the Commander conversation.
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
            icon: 'blocked',
            label: 'Needs you',
            title: `The Agent is waiting at startup, usually on a first-run prompt such as folder trust or sign-in. Open the Session to answer it; the task continues on its own. Task ${task.delegationId}.`,
            toneClassName: TONE_TEXT_CLASSNAME.warning,
        };
    const { description, icon, label, tone } = TASK_PRESENTATION[task.status];
    // A takeover's reason is the takeover itself; every other failure names its cause.
    const reason =
        task.failure && task.status !== 'human_intervened'
            ? ` Reason: ${task.failure.replaceAll('_', ' ')}.`
            : '';
    return {
        icon,
        label,
        title: `${description}${reason} Task ${task.delegationId}.`,
        toneClassName: TONE_TEXT_CLASSNAME[tone],
    };
}

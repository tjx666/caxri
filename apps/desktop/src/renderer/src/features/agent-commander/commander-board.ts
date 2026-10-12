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

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import type { AgentActivityGlyphId } from '../agent-activity/agent-activity-glyph';
import type { SessionActivityPresentation } from '../primary-sidebar/session-activity';
import {
    sessionActivityPresentation,
    sessionUnreadTone,
} from '../primary-sidebar/session-activity';
import type { SessionPullRequestPresentation } from '../primary-sidebar/session-pull-request';
import {
    sessionPullRequestPresentation,
    sessionPullRequestToneClassName,
} from '../primary-sidebar/session-pull-request';

/**
 * The Workbench Activity view's group names, so the same Session reads the same in both windows.
 */
const GROUP_LABEL_KEYS: Record<CommanderBoardGroupId, TranslationKey> = {
    attention: 'agentCommander.board.group.attention',
    failed: 'agentCommander.board.group.failed',
    finished: 'agentCommander.board.group.finished',
    idle: 'agentCommander.board.group.idle',
    waiting: 'agentCommander.board.group.waiting',
    working: 'agentCommander.board.group.working',
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
    t: Translate = translate,
): CommanderBoardSection[] {
    const rowsByGroup = Map.groupBy(rows, (row) => row.group);
    return commanderBoardGroupIds.flatMap((id) => {
        const groupRows = rowsByGroup.get(id);
        return groupRows ? [{ id, label: t(GROUP_LABEL_KEYS[id]), rows: groupRows }] : [];
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
 * The shape a row draws for an Agent process that is not running, so `Suspended` and `Exited` read as an icon instead
 * of a word that crowds the Project name out of the metadata line.
 */
export type CommanderProcessIconId = 'exited' | 'failed' | 'interrupted' | 'starting' | 'suspended';

/**
 * A Terminal that is not running cannot be doing what its last activity says, so its process state wins the phrase.
 * `running` is absent on purpose: a live process is described by its Agent activity instead. `detached` has no icon:
 * the row's glyph already turns into the unplugged shape for it.
 */
const PROCESS_PRESENTATION: Partial<
    Record<ProcessState, { icon?: CommanderProcessIconId; phraseKey: TranslationKey }>
> = {
    dead: { icon: 'exited', phraseKey: 'agentCommander.board.process.exited' },
    detached: { phraseKey: 'agentCommander.board.process.detached' },
    failed: { icon: 'failed', phraseKey: 'agentCommander.board.process.failed' },
    interrupted: { icon: 'interrupted', phraseKey: 'agentCommander.board.process.interrupted' },
    starting: { icon: 'starting', phraseKey: 'agentCommander.board.process.starting' },
    stopped: { icon: 'exited', phraseKey: 'agentCommander.board.process.exited' },
    suspended: { icon: 'suspended', phraseKey: 'agentCommander.board.process.suspended' },
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
     * The Agent process state when it is not running, drawn as an icon whose label is {@link statePhrase}.
     */
    processIcon?: CommanderProcessIconId;
    /**
     * What the Agent is doing, as the row's accessible text and hover tooltips read it.
     */
    statePhrase: string;
    toneClassName: string;
}

/**
 * Presents one board row. Only a row that asks the user for something (unread, failed) is tinted, so color on the board
 * always means "look here". A live turn is the sidebar's monochrome running ring in `--muted`, not a green spinner: the
 * same Session reads the same in both windows, and a board of several working Agents does not turn into a wall of
 * green.
 */
export function commanderRowPresentation(
    row: CommanderBoardRow,
    t: Translate = translate,
): CommanderRowPresentation {
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
    const process = agent ? PROCESS_PRESENTATION[agent.processState] : undefined;
    const statePhrase = agent
        ? process
            ? t(process.phraseKey)
            : activity.label
        : t('agentCommander.board.noTerminal');
    const processIcon = process?.icon;
    const agentLabel =
        !agent || agent.kind === 'shell'
            ? t('agentCommander.board.shell')
            : agentProviderCatalog[agent.kind].displayName;
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
        ? 'neutral'
        : row.group === 'attention' && row.hasUnread
          ? sessionUnreadTone(activityState)
          : row.group === 'failed'
            ? 'danger'
            : 'neutral';
    return {
        agentLabel,
        glyph,
        glyphLabel: row.hasUnread
            ? t('agentCommander.board.unread', { state: activity.label })
            : activity.label,
        ...(processIcon && { processIcon }),
        statePhrase,
        toneClassName: TONE_TEXT_CLASSNAME[tone],
    };
}

/**
 * The CI result a pull request chip draws beside its number. Absent for a closed or merged pull request, whose checks
 * are stale.
 */
export type CommanderChecksIconId = 'failed' | 'passed' | 'pending';

interface CommanderPullRequestBadge {
    ariaLabel: string;
    checksIcon?: CommanderChecksIconId;
    checksLabel?: string;
    checksToneClassName?: string;
    /**
     * `#123`.
     */
    numberLabel: string;
    stateLabel: string;
    /**
     * The hover text: lifecycle, CI, and the pull request's title, since the chip itself shows only icons and the
     * number.
     */
    title: string;
    toneClassName: string;
    url: string;
}

const CHECKS_ICONS: Partial<
    Record<NonNullable<SessionPullRequestPresentation['checksTone']>, CommanderChecksIconId>
> = {
    danger: 'failed',
    success: 'passed',
    warning: 'pending',
};

/**
 * The board's pull request chip: number, lifecycle, and CI, reusing the PrimarySidebar's presentation so a PR reads the
 * same in both windows. Lifecycle and checks keep separate tones, because a red open PR was once mistaken for a closed
 * one. A failed lookup hides the chip, as the Activity view does, since the cached state and checks may be stale.
 */
export function commanderPullRequestBadge(
    {
        pullRequest,
        pullRequestUnavailable,
    }: Pick<CommanderBoardRow, 'pullRequest' | 'pullRequestUnavailable'>,
    t: Translate = translate,
): CommanderPullRequestBadge | undefined {
    if (!pullRequest || pullRequestUnavailable) return undefined;
    const presentation = sessionPullRequestPresentation(pullRequest);
    const checksIcon = presentation.checksTone && CHECKS_ICONS[presentation.checksTone];
    const status = [`#${pullRequest.number} ${presentation.label}`, presentation.checksLabel]
        .filter(Boolean)
        .join(' · ');
    return {
        ariaLabel: t('agentCommander.board.pullRequestOpen', { label: presentation.ariaLabel }),
        ...(checksIcon && { checksIcon }),
        ...(presentation.checksLabel && { checksLabel: presentation.checksLabel }),
        ...(presentation.checksTone && {
            checksToneClassName: sessionPullRequestToneClassName(presentation.checksTone),
        }),
        numberLabel: `#${pullRequest.number}`,
        stateLabel: presentation.label,
        title: `${status}: ${pullRequest.title}`,
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
        descriptionKey: TranslationKey;
        icon: CommanderTaskIconId;
        labelKey: TranslationKey;
        tone: SessionActivityPresentation['tone'];
    }
> = {
    answer_unavailable: {
        descriptionKey: 'agentCommander.task.description.answerUnavailable',
        icon: 'failed',
        labelKey: 'agentCommander.task.label.failed',
        tone: 'danger',
    },
    awaiting_ready: {
        descriptionKey: 'agentCommander.task.description.awaitingReady',
        icon: 'starting',
        labelKey: 'agentCommander.task.label.starting',
        tone: 'neutral',
    },
    blocked: {
        descriptionKey: 'agentCommander.task.description.blocked',
        icon: 'blocked',
        labelKey: 'agentCommander.task.label.blocked',
        tone: 'warning',
    },
    collecting: {
        descriptionKey: 'agentCommander.task.description.collecting',
        icon: 'running',
        labelKey: 'agentCommander.task.label.running',
        tone: 'neutral',
    },
    completed: {
        descriptionKey: 'agentCommander.task.description.completed',
        icon: 'answered',
        labelKey: 'agentCommander.task.label.answered',
        tone: 'neutral',
    },
    failed: {
        descriptionKey: 'agentCommander.task.description.failed',
        icon: 'failed',
        labelKey: 'agentCommander.task.label.failed',
        tone: 'danger',
    },
    human_intervened: {
        descriptionKey: 'agentCommander.task.description.humanIntervened',
        icon: 'taken-over',
        labelKey: 'agentCommander.task.label.takenOver',
        tone: 'warning',
    },
    interrupted: {
        descriptionKey: 'agentCommander.task.description.interrupted',
        icon: 'stopped',
        labelKey: 'agentCommander.task.label.stopped',
        tone: 'neutral',
    },
    launching: {
        descriptionKey: 'agentCommander.task.description.launching',
        icon: 'starting',
        labelKey: 'agentCommander.task.label.starting',
        tone: 'neutral',
    },
    requested: {
        descriptionKey: 'agentCommander.task.description.launching',
        icon: 'starting',
        labelKey: 'agentCommander.task.label.starting',
        tone: 'neutral',
    },
    running: {
        descriptionKey: 'agentCommander.task.description.running',
        icon: 'running',
        labelKey: 'agentCommander.task.label.running',
        tone: 'neutral',
    },
    submitting: {
        descriptionKey: 'agentCommander.task.description.submitting',
        icon: 'starting',
        labelKey: 'agentCommander.task.label.starting',
        tone: 'neutral',
    },
};

interface CommanderTaskBadge {
    icon: CommanderTaskIconId;
    label: string;
    /**
     * The status label's key, so the row can expose the English label as a stable `data-*` value in every locale.
     */
    labelKey: TranslationKey;
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
    t: Translate = translate,
): CommanderTaskBadge | undefined {
    if (!task) return undefined;
    if (task.status === 'blocked' && task.failure === 'startup_waiting')
        return {
            icon: 'blocked',
            // Not "Needs you": that names the Commander Inbox column, and this task need not have an Inbox item.
            label: t('agentCommander.task.label.waitingAtStartup'),
            labelKey: 'agentCommander.task.label.waitingAtStartup',
            title: t('agentCommander.task.waitingAtStartupTitle', {
                delegationId: task.delegationId,
            }),
            toneClassName: TONE_TEXT_CLASSNAME.warning,
        };
    const { descriptionKey, icon, labelKey, tone } = TASK_PRESENTATION[task.status];
    const label = t(labelKey);
    // A takeover's reason is the takeover itself; every other failure names its cause.
    const reason =
        task.failure && task.status !== 'human_intervened'
            ? t('agentCommander.task.reason', { reason: task.failure.replaceAll('_', ' ') })
            : '';
    return {
        icon,
        label,
        labelKey,
        title: t('agentCommander.task.title', {
            delegationId: task.delegationId,
            description: t(descriptionKey),
            label,
            reason,
        }),
        toneClassName: TONE_TEXT_CLASSNAME[tone],
    };
}

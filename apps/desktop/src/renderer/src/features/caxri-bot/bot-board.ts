import type {
    AgentActivityState,
    AgentDelegationReceipt,
    BotBoard,
    BotBoardGroupId,
    BotBoardRow,
    ProcessState,
    SessionPullRequests,
} from '@caxri/protocol';
import { agentProviderCatalog, botBoardGroupIds } from '@caxri/protocol';
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
const GROUP_LABEL_KEYS: Record<BotBoardGroupId, TranslationKey> = {
    attention: 'caxriBot.board.group.attention',
    failed: 'caxriBot.board.group.failed',
    finished: 'caxriBot.board.group.finished',
    idle: 'caxriBot.board.group.idle',
    waiting: 'caxriBot.board.group.waiting',
    working: 'caxriBot.board.group.working',
};

interface BotBoardSection {
    id: BotBoardGroupId;
    label: string;
    rows: readonly BotBoardRow[];
}

/**
 * Buckets board rows into the protocol's display order and drops empty groups. Rows keep the Server's order within a
 * group, which is already most recent first.
 */
export function botBoardSections(
    rows: readonly BotBoardRow[],
    t: Translate = translate,
): BotBoardSection[] {
    const rowsByGroup = Map.groupBy(rows, (row) => row.group);
    return botBoardGroupIds.flatMap((id) => {
        const groupRows = rowsByGroup.get(id);
        return groupRows ? [{ id, label: t(GROUP_LABEL_KEYS[id]), rows: groupRows }] : [];
    });
}

/**
 * Which Sessions the Caxri Bot window lists. `bot`, the default, is only the Sessions Caxri Bot created: the Workbench
 * already shows every Session, and the user's hand-run Sessions mixed in here buried the work Caxri Bot dispatched.
 * `all` is the whole Workbench, a toggle away. The Server's board (and `caxri bot board`) always covers every Session,
 * so Caxri Bot itself still sees the whole Workbench.
 */
export type BotBoardScope = 'all' | 'bot';

/**
 * The rows a scope shows, keeping the Server's order.
 */
export function botBoardRowsInScope(
    rows: readonly BotBoardRow[],
    scope: BotBoardScope,
): readonly BotBoardRow[] {
    return scope === 'all' ? rows : rows.filter((row) => row.botSession);
}

/**
 * Applies a fresh `session.pullRequests` snapshot to the rows of the named Sessions only, the way the Server's
 * `botBoard` projection would have filled their `pullRequest` and `pullRequestUnavailable` fields.
 *
 * Every other row keeps its object, and so does a named row whose pull request did not actually change; a board whose
 * rows all stayed the same comes back as the same object. React Query hands that identity straight to the board, so a
 * pull-request change re-renders the rows it touched and nothing else (issue caxri#1411). A named Session that is not
 * on the board is skipped: the Server decides which Sessions get a row, and the board's own poll adds it.
 */
export function patchBotBoardPullRequests(
    board: BotBoard,
    snapshot: SessionPullRequests,
    sessionIds: ReadonlySet<string>,
): BotBoard {
    const rows = board.rows.map((row) => {
        if (!sessionIds.has(row.sessionId)) return row;
        // The record omits every Session without a pull request, which its index type does not admit.
        const pullRequest = snapshot.pullRequests[row.sessionId] as
            BotBoardRow['pullRequest'] | undefined;
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
export type BotProcessIconId = 'exited' | 'failed' | 'interrupted' | 'starting' | 'suspended';

/**
 * A Terminal that is not running cannot be doing what its last activity says, so its process state wins the phrase.
 * `running` is absent on purpose: a live process is described by its Agent activity instead. `detached` has no icon:
 * the row's glyph already turns into the unplugged shape for it.
 */
const PROCESS_PRESENTATION: Partial<
    Record<ProcessState, { icon?: BotProcessIconId; phraseKey: TranslationKey }>
> = {
    dead: { icon: 'exited', phraseKey: 'caxriBot.board.process.exited' },
    detached: { phraseKey: 'caxriBot.board.process.detached' },
    failed: { icon: 'failed', phraseKey: 'caxriBot.board.process.failed' },
    interrupted: { icon: 'interrupted', phraseKey: 'caxriBot.board.process.interrupted' },
    starting: { icon: 'starting', phraseKey: 'caxriBot.board.process.starting' },
    stopped: { icon: 'exited', phraseKey: 'caxriBot.board.process.exited' },
    suspended: { icon: 'suspended', phraseKey: 'caxriBot.board.process.suspended' },
};

interface BotRowPresentation {
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
    processIcon?: BotProcessIconId;
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
export function botRowPresentation(row: BotBoardRow, t: Translate = translate): BotRowPresentation {
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
        : t('caxriBot.board.noTerminal');
    const processIcon = process?.icon;
    const agentLabel =
        !agent || agent.kind === 'shell'
            ? t('caxriBot.board.shell')
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
    const glyph = isLive
        ? agent?.operation === 'background'
            ? 'background'
            : 'spinner'
        : GLYPH_BY_STATE[activityState];
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
            ? t('caxriBot.board.unread', { state: activity.label })
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
export type BotChecksIconId = 'failed' | 'passed' | 'pending';

interface BotPullRequestBadge {
    ariaLabel: string;
    checksIcon?: BotChecksIconId;
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
    Record<NonNullable<SessionPullRequestPresentation['checksTone']>, BotChecksIconId>
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
export function botPullRequestBadge(
    {
        pullRequest,
        pullRequestUnavailable,
    }: Pick<BotBoardRow, 'pullRequest' | 'pullRequestUnavailable'>,
    t: Translate = translate,
): BotPullRequestBadge | undefined {
    if (!pullRequest || pullRequestUnavailable) return undefined;
    const presentation = sessionPullRequestPresentation(pullRequest);
    const checksIcon = presentation.checksTone && CHECKS_ICONS[presentation.checksTone];
    const status = [`#${pullRequest.number} ${presentation.label}`, presentation.checksLabel]
        .filter(Boolean)
        .join(' · ');
    return {
        ariaLabel: t('caxriBot.board.pullRequestOpen', { label: presentation.ariaLabel }),
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
export type BotTaskIconId =
    'answered' | 'blocked' | 'failed' | 'running' | 'starting' | 'stopped' | 'taken-over';

/**
 * The task label collapses the delegation lifecycle into what the user acts on. Only a task that needs someone is
 * tinted: a blocked task waits for an answer (usually Caxri Bot's), a failed one must be retried, and a taken-over one
 * is out of Caxri Bot's hands until the user hands it back. `completed` reads `Answered`, not `Done`: it means the
 * Agent gave its final answer, which Caxri Bot still has to verify.
 */
const TASK_PRESENTATION: Record<
    AgentDelegationReceipt['status'],
    {
        descriptionKey: TranslationKey;
        icon: BotTaskIconId;
        labelKey: TranslationKey;
        tone: SessionActivityPresentation['tone'];
    }
> = {
    answer_unavailable: {
        descriptionKey: 'caxriBot.task.description.answerUnavailable',
        icon: 'failed',
        labelKey: 'caxriBot.task.label.failed',
        tone: 'danger',
    },
    awaiting_ready: {
        descriptionKey: 'caxriBot.task.description.awaitingReady',
        icon: 'starting',
        labelKey: 'caxriBot.task.label.starting',
        tone: 'neutral',
    },
    blocked: {
        descriptionKey: 'caxriBot.task.description.blocked',
        icon: 'blocked',
        labelKey: 'caxriBot.task.label.blocked',
        tone: 'warning',
    },
    collecting: {
        descriptionKey: 'caxriBot.task.description.collecting',
        icon: 'running',
        labelKey: 'caxriBot.task.label.running',
        tone: 'neutral',
    },
    completed: {
        descriptionKey: 'caxriBot.task.description.completed',
        icon: 'answered',
        labelKey: 'caxriBot.task.label.answered',
        tone: 'neutral',
    },
    failed: {
        descriptionKey: 'caxriBot.task.description.failed',
        icon: 'failed',
        labelKey: 'caxriBot.task.label.failed',
        tone: 'danger',
    },
    human_intervened: {
        descriptionKey: 'caxriBot.task.description.humanIntervened',
        icon: 'taken-over',
        labelKey: 'caxriBot.task.label.takenOver',
        tone: 'warning',
    },
    interrupted: {
        descriptionKey: 'caxriBot.task.description.interrupted',
        icon: 'stopped',
        labelKey: 'caxriBot.task.label.stopped',
        tone: 'neutral',
    },
    launching: {
        descriptionKey: 'caxriBot.task.description.launching',
        icon: 'starting',
        labelKey: 'caxriBot.task.label.starting',
        tone: 'neutral',
    },
    requested: {
        descriptionKey: 'caxriBot.task.description.launching',
        icon: 'starting',
        labelKey: 'caxriBot.task.label.starting',
        tone: 'neutral',
    },
    running: {
        descriptionKey: 'caxriBot.task.description.running',
        icon: 'running',
        labelKey: 'caxriBot.task.label.running',
        tone: 'neutral',
    },
    submitting: {
        descriptionKey: 'caxriBot.task.description.submitting',
        icon: 'starting',
        labelKey: 'caxriBot.task.label.starting',
        tone: 'neutral',
    },
};

interface BotTaskBadge {
    icon: BotTaskIconId;
    label: string;
    /**
     * The status label's key, so the row can expose the English label as a stable `data-*` value in every locale.
     */
    labelKey: TranslationKey;
    /**
     * What the status means for the user, the failure reason, and the delegation ID so the user can find the task in
     * Caxri Bot's conversation.
     */
    title: string;
    toneClassName: string;
}

/**
 * The current Caxri Bot task in a row's Session, or nothing when Caxri Bot never delegated there.
 */
export function botTaskBadge(
    task: BotBoardRow['task'],
    t: Translate = translate,
): BotTaskBadge | undefined {
    if (!task) return undefined;
    if (task.status === 'blocked' && task.failure === 'startup_waiting')
        return {
            icon: 'blocked',
            // Not "Needs you": that names the Bot Inbox column, and this task need not have an Inbox item.
            label: t('caxriBot.task.label.waitingAtStartup'),
            labelKey: 'caxriBot.task.label.waitingAtStartup',
            title: t('caxriBot.task.waitingAtStartupTitle'),
            toneClassName: TONE_TEXT_CLASSNAME.warning,
        };
    const { descriptionKey, icon, labelKey, tone } = TASK_PRESENTATION[task.status];
    const label = t(labelKey);
    // A takeover's reason is the takeover itself; every other failure names its cause.
    const reason =
        task.failure && task.status !== 'human_intervened'
            ? t('caxriBot.task.reason', { reason: task.failure.replaceAll('_', ' ') })
            : '';
    return {
        icon,
        label,
        labelKey,
        title: t('caxriBot.task.title', {
            description: t(descriptionKey),
            label,
            reason,
        }),
        toneClassName: TONE_TEXT_CLASSNAME[tone],
    };
}

/**
 * A handed-over Session Caxri Bot has not continued yet: whether it has a conversation to continue, for the row's
 * tooltip. Once the first task continues it, the row shows that task instead.
 */
export function botHandoverDescription(
    handover: BotBoardRow['handover'],
    t: Translate = translate,
): string | undefined {
    if (!handover) return undefined;
    return t(
        handover.state === 'continuable'
            ? 'caxriBot.board.handoverContinuable'
            : 'caxriBot.board.handoverOwnershipOnly',
    );
}

import type {
    AgentChatFailureReason,
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatModel,
    AgentChatPlan,
    AgentChatRequest,
    AgentChatSnapshot,
    ProcessState,
} from '@caxri/protocol';
import { agentToolActiveLabel, describeAgentTool, findAgentChatModel } from '@caxri/protocol';

import { projectRelativePath } from '../../lib/file-path';
import { getTerminalExitPresentation } from '../terminal/terminal-exit-presentation';

/**
 * User-facing copy for each closed failure reason. Provider text never selects the message; `detail` is shown beside it
 * only as supporting context. `providerName` is the provider catalog's display name.
 */
export function agentChatFailureMessage(
    reason: AgentChatFailureReason,
    providerName: string,
): string {
    switch (reason) {
        case 'executable_not_found': {
            return `${providerName} is not installed or is not on your PATH. Install it, then retry.`;
        }
        case 'spawn_failed': {
            return `${providerName} could not be started. Retry, or check that the ${providerName} CLI runs in a terminal.`;
        }
        case 'handshake_failed': {
            return `${providerName} started but did not respond. Retry, or update the ${providerName} CLI.`;
        }
        case 'process_exited': {
            return `${providerName} stopped unexpectedly. Retry to resume the conversation.`;
        }
        case 'resume_failed': {
            return 'The previous conversation could not be resumed.';
        }
        case 'unsupported_version': {
            return `This ${providerName} version does not support Chat. Update the ${providerName} CLI.`;
        }
    }
}

/**
 * Whether the composer accepts a message. A stopped Chat resumes its Agent Session on the next message, a starting one
 * queues the message on Server Core until the provider is ready (opening a Chat and typing at once must not drop the
 * first Enter), and a running turn accepts a message into its queue or as steering. A failed provider, a Chat not
 * loaded yet, or one handed to another client refuses input. The hand-over lives only on the Terminal record
 * (`processState` is its `lastProcessState`): the projection of a detached Chat still reads `stopped`, yet Server Core
 * rejects its input until the user resumes it, so without this check Enter would fail instead of the pane saying why.
 */
export function canSendAgentChatMessage(
    snapshot: AgentChatSnapshot | undefined,
    processState: ProcessState | undefined,
): boolean {
    return snapshot !== undefined && snapshot.status !== 'failed' && processState !== 'detached';
}

/**
 * The placeholder an empty transcript shows, or `undefined` while it should stay blank (still loading or starting). A
 * detached Chat dropped its projection when it stopped, so after a remount it has nothing to show until the Session
 * resumes; saying so, as the phone does, keeps the blank transcript from reading as lost history.
 */
export function agentChatEmptyMessage(
    snapshot: Pick<AgentChatSnapshot, 'items' | 'status'> | undefined,
    processState: ProcessState | undefined,
    providerName: string,
): string | undefined {
    if (!snapshot || snapshot.items.length > 0) return undefined;
    if (processState === 'detached') return 'Messages appear here once the Chat resumes.';
    return snapshot.status === 'ready'
        ? `Send a message to start working with ${providerName}.`
        : undefined;
}

/**
 * Why the Chat cannot continue here, for the banner above the composer. `recovery` is what its one action does:
 * `restart` relaunches the provider on its bound conversation, which clears a failure and ends a hand-over; `reload`
 * reads a projection that never loaded again.
 */
export interface AgentChatRecoveryNotice {
    kind: 'detached' | 'failed';
    message: string;
    detail?: string;
    recovery: 'reload' | 'restart';
}

/**
 * The banner the Chat shows instead of a working composer, or `undefined` when it can continue. A detached Chat uses
 * the PTY recovery bar's copy, so both Terminal surfaces describe a hand-over the same way. The hand-over wins over a
 * provider failure: it is the newer fact, and the same restart recovers both.
 */
export function agentChatRecoveryNotice(
    snapshot: Pick<AgentChatSnapshot, 'failure' | 'status'> | undefined,
    state: { isLoadError: boolean; processState: ProcessState | undefined },
    providerName: string,
): AgentChatRecoveryNotice | undefined {
    if (state.processState === 'detached')
        return {
            kind: 'detached',
            message: getTerminalExitPresentation('detached')?.label ?? 'Detached',
            recovery: 'restart',
        };
    const isFailed = snapshot?.status === 'failed';
    if (!isFailed && !state.isLoadError) return undefined;
    /**
     * A failed provider stays failed on read so a broken CLI is not relaunched by every render; only a restart clears
     * the failure and resumes the bound conversation.
     */
    const recovery = isFailed ? 'restart' : 'reload';
    if (!snapshot?.failure)
        return { kind: 'failed', message: 'The conversation could not be loaded.', recovery };
    return {
        kind: 'failed',
        message: agentChatFailureMessage(snapshot.failure.reason, providerName),
        ...(snapshot.failure.detail && { detail: snapshot.failure.detail }),
        recovery,
    };
}

/**
 * Display names for the effort levels the providers use; an unknown level is shown capitalized.
 */
const EFFORT_LABELS: Record<string, string> = {
    none: 'None',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
};

export function agentChatEffortLabel(effort: string): string {
    return EFFORT_LABELS[effort] ?? `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;
}

/**
 * The model picker's trigger: the model's listed name and the effort the next turn uses, as Codex shows `GPT-5.6 Sol
 * Extra high`. A model the provider did not list keeps its raw identifier.
 */
export function agentChatModelLabel(
    snapshot: Pick<AgentChatSnapshot, 'effort' | 'model' | 'models'> | undefined,
): { model: string; effort?: string } | undefined {
    // Claude Code reports the model in each turn's init message, so a new Chat lists its models before it names the
    // one in use; the picker still opens and reads as the provider default until then.
    if (!snapshot?.model) return snapshot?.models?.length ? { model: 'Default' } : undefined;
    const listed = findAgentChatModel(snapshot.models, snapshot.model);
    const effort =
        snapshot.effort && (listed?.efforts.length ?? 1) > 0
            ? agentChatEffortLabel(snapshot.effort)
            : undefined;
    const model = listed && concreteModelName(snapshot.models ?? [], listed, snapshot.model);
    return { model: model ?? snapshot.model, ...(effort && { effort }) };
}

/**
 * The name the picker shows for the model in use. Claude Code lists its default as an alias, "Default (recommended)",
 * whose description names the model it currently resolves to ("Use the default model (currently Opus 5.5)"); that name
 * says which model actually runs. Failing that, a named entry that resolves to the same model does; the default may add
 * a variant suffix (`claude-opus-5-5[1m]`) the named entry lacks, so the suffix is ignored when matching. With neither
 * the alias reads as plain "Default".
 */
function concreteModelName(
    models: readonly AgentChatModel[],
    listed: AgentChatModel,
    model: string,
): string {
    if (listed.id !== 'default') return listed.displayName;
    const current = /\(currently ([^)]+)\)/.exec(listed.description ?? '')?.[1]?.trim();
    if (current) return current;
    const base = model.replace(/\[[^\]]*\]$/, '');
    const named = models.find(
        (candidate) =>
            candidate.id !== 'default' &&
            [candidate.id, candidate.resolvedId].some((id) => id === model || id === base),
    );
    return named?.displayName ?? listed.displayName.replace(/\s*\(recommended\)$/i, '');
}

/**
 * What a running turn says it is doing. A long turn reads as progress rather than a stall when the line has some life
 * in it, as Claude Code's spinner does; the words stay calm and never claim a specific step.
 */
const WORKING_VERBS = [
    'Pondering',
    'Tinkering',
    'Mulling it over',
    'Connecting the dots',
    'Untangling',
    'Sketching',
    'Percolating',
    'Rummaging',
    'Piecing it together',
    'Noodling',
    'Brewing',
    'Weighing options',
    'Tracing',
    'Sleuthing',
    'Distilling',
    'Simmering',
    'Calibrating',
    'Whittling',
    'Wrangling',
    'Conjuring',
    'Exploring',
    'Cross-checking',
    'Lining things up',
    'Spelunking',
] as const;

/**
 * One verb per turn, chosen from its id so it stays put while the turn runs and every client shows the same one.
 */
export function agentChatWorkingVerb(turnId: string): string {
    let hash = 0;
    for (const character of turnId) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
    return WORKING_VERBS[hash % WORKING_VERBS.length] ?? 'Working';
}

export type AgentChatActivity =
    | { kind: 'starting'; text: string }
    | { kind: 'working'; text: string; startedAt: number | undefined }
    | { kind: 'compacting'; text: string; isStoppable: boolean }
    | { kind: 'waiting'; text: string };

/**
 * What the Chat is doing right now, for the status line on the composer. A pending request means the turn is blocked on
 * the user, not working, so it says so instead of animating. Compacting the context names itself instead of a playful
 * verb, so a `/compact` the user asked for visibly runs; it can happen inside a turn (automatic compaction), which Esc
 * still stops.
 */
export function agentChatActivity(
    snapshot:
        | Pick<AgentChatSnapshot, 'status' | 'activeTurnId' | 'operation' | 'requests' | 'turns'>
        | undefined,
    providerName: string,
): AgentChatActivity | undefined {
    if (!snapshot || snapshot.status === 'starting')
        return { kind: 'starting', text: `Starting ${providerName}…` };
    const turnId = snapshot.activeTurnId;
    if (turnId && snapshot.requests.length > 0)
        return { kind: 'waiting', text: 'Waiting for your answer' };
    if (snapshot.operation === 'compacting')
        return { kind: 'compacting', text: 'Compacting context…', isStoppable: Boolean(turnId) };
    if (!turnId) return undefined;
    return {
        kind: 'working',
        text: `${agentChatWorkingVerb(turnId)}…`,
        startedAt: snapshot.turns.find((turn) => turn.id === turnId)?.startedAt,
    };
}

export interface AgentChatPlanProgress {
    completed: number;
    total: number;
    /**
     * The step the Agent is on: the one in progress, else the first still pending; absent once every step is done.
     */
    current: string | undefined;
}

/**
 * How far the Agent is through its plan, for the collapsed plan row above the composer.
 */
export function agentChatPlanProgress(plan: Pick<AgentChatPlan, 'steps'>): AgentChatPlanProgress {
    const current =
        plan.steps.find((step) => step.status === 'inProgress') ??
        plan.steps.find((step) => step.status === 'pending');
    return {
        completed: plan.steps.filter((step) => step.status === 'completed').length,
        total: plan.steps.length,
        current: current?.step,
    };
}

/**
 * Whether a message sent now would wait in the queue rather than start a turn: a turn is running, the context is
 * compacting, or earlier messages are still queued and not paused (Server Core keeps the queue in order).
 */
export function isAgentChatBusy(
    snapshot:
        Pick<AgentChatSnapshot, 'activeTurnId' | 'operation' | 'queue' | 'queuePaused'> | undefined,
): boolean {
    if (!snapshot) return false;
    return (
        Boolean(snapshot.activeTurnId) ||
        snapshot.operation === 'compacting' ||
        ((snapshot.queue?.length ?? 0) > 0 && !snapshot.queuePaused)
    );
}

export function isAgentChatTurnRunning(snapshot: AgentChatSnapshot | undefined): boolean {
    return Boolean(snapshot?.activeTurnId);
}

/**
 * What submitting the composer does. Enter sends when the Chat is idle and queues while a turn runs or the context is
 * compacting; Cmd+Enter (Ctrl+Enter off macOS) steers the running turn instead. Shift+Enter adds a line, and an IME
 * composition owns Enter until it commits, otherwise confirming a candidate would send a half-typed message.
 * `undefined` means the key is not a submit.
 */
export function agentChatSubmitDelivery(
    event: {
        key: string;
        shiftKey: boolean;
        metaKey: boolean;
        ctrlKey: boolean;
        isComposing: boolean;
    },
    state: { isTurnRunning: boolean; isBusy: boolean },
): 'send' | 'queue' | 'steer' | undefined {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return undefined;
    const isSteerChord = event.metaKey || event.ctrlKey;
    if (isSteerChord && state.isTurnRunning) return 'steer';
    return state.isBusy ? 'queue' : 'send';
}

/**
 * The composer's send affordance for the Chat's state: while a turn runs, Enter queues and Cmd+Enter steers; while the
 * Chat is otherwise busy (compacting, or draining the queue) a message waits its turn.
 */
export function agentChatSendAction(
    state: { isTurnRunning: boolean; isBusy: boolean },
    providerName: string,
): { label: 'Send' | 'Queue message'; tooltip: string; placeholder: string } {
    if (state.isTurnRunning)
        return {
            label: 'Queue message',
            tooltip: 'Queue (Enter) · Steer (⌘Enter)',
            placeholder: 'Queue a follow-up (⌘Enter to steer)',
        };
    if (state.isBusy)
        return { label: 'Queue message', tooltip: 'Queue', placeholder: 'Queue a follow-up' };
    return { label: 'Send', tooltip: 'Send', placeholder: `Message ${providerName}` };
}

/**
 * Escape interrupts a running turn, as it does in the Codex TUI; the draft is kept for the next message. An IME
 * composition owns Escape (it dismisses the candidate list), and a held key must not fire a stream of interrupts.
 */
export function isAgentChatInterruptKey(event: {
    key: string;
    isComposing: boolean;
    repeat: boolean;
}): boolean {
    return event.key === 'Escape' && !event.isComposing && !event.repeat;
}

export type AgentChatStatusTone = 'danger' | 'muted' | 'running' | 'success' | 'warning';

export function agentChatItemStatusTone(status: AgentChatItemStatus): AgentChatStatusTone {
    switch (status) {
        case 'running': {
            return 'running';
        }
        case 'completed': {
            return 'success';
        }
        case 'failed': {
            return 'danger';
        }
        case 'declined':
        case 'interrupted': {
            return 'warning';
        }
    }
}

export function agentChatItemStatusLabel(status: AgentChatItemStatus): string {
    switch (status) {
        case 'running': {
            return 'Running';
        }
        case 'completed': {
            return 'Completed';
        }
        case 'failed': {
            return 'Failed';
        }
        case 'declined': {
            return 'Declined';
        }
        case 'interrupted': {
            return 'Interrupted';
        }
    }
}

/**
 * The caption under a user message in the timeline. A message reaches the timeline only once it was delivered (a
 * pending follow-up waits in the queue cards above the composer), so a queued one is now an ordinary message and a
 * `Queued` caption would read as still pending. Only `Steered` says something still true: it joined a running turn.
 */
export function agentChatDeliveryCaption(
    delivery: 'queued' | 'steered' | undefined,
): 'Steered' | undefined {
    return delivery === 'steered' ? 'Steered' : undefined;
}

export function agentChatNoticeMessage(item: Extract<AgentChatItem, { type: 'notice' }>): string {
    switch (item.kind) {
        case 'compacted': {
            return 'Context compacted';
        }
        case 'retrying': {
            return item.message ? `Retrying: ${item.message}` : 'Retrying';
        }
        case 'error': {
            return item.message ?? 'The Agent reported an error';
        }
        case 'answered': {
            return item.message ? `Answered: ${item.message}` : 'Answered';
        }
    }
}

/**
 * Where an approval's command runs, as the user thinks of it: hidden at the Project root (the usual case, and the one
 * the user already assumes), Project-relative below it, and absolute only when the Agent leaves the Project.
 */
export function agentChatCommandCwd(
    cwd: string | undefined,
    projectRoot: string | undefined,
): string | undefined {
    if (!cwd) return undefined;
    if (projectRoot === undefined) return cwd;
    const relative = projectRelativePath(cwd, projectRoot);
    if (relative === '.') return undefined;
    return relative ?? cwd;
}

/**
 * The approval buttons to show, in a fixed order. The provider may restrict them; `cancel` is never a button here
 * because declining already answers the request without stopping the turn.
 */
export function agentChatApprovalChoices(
    request: Extract<AgentChatRequest, { kind: 'command' | 'fileChange' | 'tool' }>,
): Array<{ decision: 'accept' | 'acceptForSession' | 'decline'; label: string }> {
    const choices = [
        { decision: 'accept', label: 'Accept' },
        { decision: 'acceptForSession', label: 'Accept for this Chat' },
        { decision: 'decline', label: 'Decline' },
    ] as const;
    const allowed = request.decisions;
    return choices.filter((choice) => !allowed || allowed.includes(choice.decision));
}

/**
 * A tool subject longer than this stays out of the approval title; the card shows it in full below.
 */
const REQUEST_TITLE_SUBJECT_LENGTH = 60;

/**
 * What a tool approval asks to do, in the timeline's words rather than the provider's identifier: `Allow editing
 * app.ts?`, `Allow create_issue from github?`. A long or multi-line subject is left to the card body; a tool the shared
 * table does not know keeps its name.
 */
function agentChatToolRequestTitle(request: { name: string; summary?: string }): string {
    const presentation = describeAgentTool(request);
    if (presentation.kind === 'mcp' && presentation.subject)
        return `Allow ${presentation.subject} from ${presentation.label}?`;
    const subject = presentation.subject;
    if (!subject || presentation.kind === 'other') return `Allow ${request.name}?`;
    const gerund = agentToolActiveLabel(presentation);
    const action = `${gerund.charAt(0).toLowerCase()}${gerund.slice(1)}`;
    return subject.length <= REQUEST_TITLE_SUBJECT_LENGTH && !subject.includes('\n')
        ? `Allow ${action} ${subject}?`
        : `Allow ${action}?`;
}

/**
 * The approval card's heading. `providerName` is the provider catalog's display name, which a question names as the one
 * asking.
 */
export function agentChatRequestTitle(request: AgentChatRequest, providerName: string): string {
    switch (request.kind) {
        case 'command': {
            return request.networkHost
                ? `Allow network access to ${request.networkHost}?`
                : 'Run this command?';
        }
        case 'fileChange': {
            return 'Apply these file changes?';
        }
        case 'tool': {
            /**
             * Claude Code asks to leave plan mode through this tool; its summary is the plan.
             */
            return request.name === 'ExitPlanMode'
                ? 'Start with this plan?'
                : agentChatToolRequestTitle(request);
        }
        case 'question': {
            return request.questions.length === 1
                ? `${providerName} has a question`
                : `${providerName} has ${request.questions.length} questions`;
        }
    }
}

/**
 * Builds the `answers` response for a question request. A typed "Other" answer replaces the chosen option for that
 * question; a question left unanswered is omitted, and the provider decides how to treat it.
 */
export function agentChatQuestionAnswers(
    selected: Readonly<Record<string, string | undefined>>,
    other: Readonly<Record<string, string | undefined>>,
): Record<string, string[]> {
    const answers: Record<string, string[]> = {};
    const questionIds = new Set([...Object.keys(selected), ...Object.keys(other)]);
    for (const id of questionIds) {
        const typed = other[id]?.trim();
        const chosen = selected[id];
        if (typed) answers[id] = [typed];
        else if (chosen) answers[id] = [chosen];
    }
    return answers;
}

/**
 * Content keys for a list whose entries have no id (plan steps), numbered per repeated value so two identical steps
 * still get distinct keys while an edit to one step never remounts the others.
 */
export function withOccurrenceKeys<T>(
    items: readonly T[],
    content: (item: T) => string,
): Array<{ item: T; key: string }> {
    const seen = new Map<string, number>();
    return items.map((item) => {
        const value = content(item);
        const occurrence = seen.get(value) ?? 0;
        seen.set(value, occurrence + 1);
        return { item, key: `${value}\0${occurrence}` };
    });
}

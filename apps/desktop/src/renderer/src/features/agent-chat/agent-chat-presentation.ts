import type {
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatPlan,
    AgentChatSnapshot,
    ProcessState,
} from '@caxri/protocol';
import { agentChatFailureMessage, agentChatWaitingText } from '@caxri/protocol';

import { projectRelativePath } from '../../lib/file-path';
import { getTerminalExitPresentation } from '../terminal/terminal-exit-presentation';

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
    return agentChatSendBlock(snapshot, processState) === undefined;
}

/**
 * The placeholder an empty transcript shows, or `undefined` while it should stay blank (still loading or starting). A
 * detached Chat dropped its projection when it stopped, so after a remount it has nothing to show until the Session
 * resumes; saying so keeps the blank transcript from reading as lost history. The phone words its own empty copy
 * (`agentChatEmptyMessage` in the mobile Chat model) because it cannot resume the Session itself.
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
 * The `meta` line under an empty, ready Chat's invitation, naming the composer gestures nobody finds by looking: the
 * `/` and `$` menus, attaching (images only when the provider takes them; any other file is inserted as its path), and
 * Shift+Enter.
 */
export function agentChatEmptyHint(canAttachImages: boolean): string {
    const files = canAttachImages ? 'paste or drop images and files' : 'drop files to insert paths';
    return `Type / for commands, $ for skills · ${files} · ⇧Enter for a new line`;
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
    /**
     * Offers reopening the conversation in the provider's own TUI as a second way out, for a failure the Chat surface
     * cannot explain further (the provider could not resume the conversation).
     */
    canOpenAsTerminal?: true;
}

/**
 * The banner body for a conversation the provider could not resume. The heading already says that it failed, and the
 * provider's own detail only says so again (`Claude could not resume this conversation`), so the body names the cause
 * Caxri knows and the next step instead.
 */
export function agentChatResumeFailureDetail(providerName: string): string {
    return `${providerName} could not reopen its saved record of this conversation. Retry, or open it as a Terminal to see what ${providerName} reports.`;
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
    if (snapshot.failure.reason === 'resume_failed')
        return {
            kind: 'failed',
            message: agentChatFailureMessage('resume_failed', { providerName, surface: 'desktop' }),
            detail: agentChatResumeFailureDetail(providerName),
            recovery,
            canOpenAsTerminal: true,
        };
    return {
        kind: 'failed',
        message: agentChatFailureMessage(snapshot.failure.reason, {
            providerName,
            surface: 'desktop',
        }),
        ...(snapshot.failure.detail && { detail: snapshot.failure.detail }),
        recovery,
    };
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
 * the user, not working, so it says so instead of animating, and says whether it waits on an approval or an answer.
 * Compacting the context names itself instead of a playful verb, so a `/compact` the user asked for visibly runs; it
 * can happen inside a turn (automatic compaction), which Esc still stops. Before the projection is first read, a Chat
 * that already has a conversation is loading it, not starting its Agent, so it says so (`hasConversation` is whether
 * the Terminal is bound to an Agent Session).
 */
export function agentChatActivity(
    snapshot:
        | Pick<AgentChatSnapshot, 'status' | 'activeTurnId' | 'operation' | 'requests' | 'turns'>
        | undefined,
    providerName: string,
    { hasConversation = false }: { hasConversation?: boolean } = {},
): AgentChatActivity | undefined {
    if (!snapshot && hasConversation) return { kind: 'starting', text: 'Loading conversation…' };
    if (!snapshot || snapshot.status === 'starting')
        return { kind: 'starting', text: `Starting ${providerName}…` };
    const turnId = snapshot.activeTurnId;
    if (turnId && snapshot.requests.length > 0)
        return { kind: 'waiting', text: agentChatWaitingText(snapshot.requests) };
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
        return {
            label: 'Queue message',
            tooltip: 'Queue (Enter)',
            placeholder: 'Queue a follow-up',
        };
    return { label: 'Send', tooltip: 'Send (Enter)', placeholder: `Message ${providerName}` };
}

/**
 * Why the Chat itself refuses a message right now (`canSendAgentChatMessage`), or `undefined` when it accepts one.
 */
export function agentChatSendBlock(
    snapshot: Pick<AgentChatSnapshot, 'status'> | undefined,
    processState: ProcessState | undefined,
): 'detached' | 'failed' | 'loading' | undefined {
    if (processState === 'detached') return 'detached';
    if (!snapshot) return 'loading';
    return snapshot.status === 'failed' ? 'failed' : undefined;
}

/**
 * The Send button's tooltip: what it does, or, while it is disabled, why, so a dead button never leaves the user
 * guessing. The Chat's own refusal wins over the composer's state, since no draft or image fixes it.
 */
export function agentChatSendTooltip(
    action: { tooltip: string },
    state: {
        block: ReturnType<typeof agentChatSendBlock>;
        hasContent: boolean;
        isAttaching: boolean;
        isSending: boolean;
    },
): string {
    switch (state.block) {
        case 'loading': {
            return 'Chat loading…';
        }
        case 'failed': {
            return 'Chat stopped. Retry above';
        }
        case 'detached': {
            return 'Chat detached. Resume above';
        }
        case undefined: {
            break;
        }
    }
    if (state.isAttaching) return 'Attaching…';
    if (state.isSending) return 'Sending…';
    if (!state.hasContent) return 'Type a message to send';
    return action.tooltip;
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

/**
 * What Escape does in the composer: stop the running turn first, else cancel an "Edit from here" in progress.
 * `undefined` when Escape has nothing to do or the key is not an interrupt (`isAgentChatInterruptKey`).
 */
export function agentChatEscapeAction(
    event: Parameters<typeof isAgentChatInterruptKey>[0],
    state: { isTurnRunning: boolean; isEditing: boolean },
): 'cancelEdit' | 'stop' | undefined {
    if (!isAgentChatInterruptKey(event)) return undefined;
    if (state.isTurnRunning) return 'stop';
    return state.isEditing ? 'cancelEdit' : undefined;
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

import type { AgentChatSnapshot, AgentProvider, ProcessState } from '@caxri/protocol';
import {
    agentChatFailureMessage,
    agentProviderCatalog,
    CAXRI_SKILL_NAME,
    projectRelativePath,
} from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import { translate } from '../../../i18n';
import type { SuggestionMenuKeyAction } from '../../../lib/suggestion-options';
import { getTerminalExitPresentation } from '../../terminal/terminal-exit-presentation';
import type { AgentChatSendKey } from '../composer/send/agent-chat-send-tooltip';
import { agentChatSendBlock, agentChatSendTooltip } from '../composer/send/agent-chat-send-tooltip';

/**
 * Whether the composer accepts a message. A stopped Chat resumes its Agent Session on the next message, a starting one
 * queues the message on Server Core until the provider is ready (opening a Chat and typing at once must not drop the
 * first Enter), and a running turn accepts a message into its queue or as steering. A failed provider, a Chat not
 * loaded yet, one handed to another client, or one whose account is at the weekly usage guard refuses input. The
 * hand-over lives only on the Terminal record (`processState` is its `lastProcessState`): the projection of a detached
 * Chat still reads `stopped`, yet Server Core rejects its input until the user resumes it, so without this check Enter
 * would fail instead of the pane saying why.
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
    t: Translate = translate,
): string | undefined {
    if (!snapshot || snapshot.items.length > 0) return undefined;
    if (processState === 'detached') return t('agentChat.timeline.emptyDetached');
    return snapshot.status === 'ready'
        ? t('agentChat.timeline.emptyReady', { provider: providerName })
        : undefined;
}

/**
 * Whether the transcript shows the conversation-loading placeholder. Only a Chat bound to an Agent Session has a
 * conversation to load; a new Chat goes straight to its empty state. It loads while the projection is first read, and
 * also while that projection is `starting` with no rows yet: a resumed provider replays its history only once it is
 * ready (Codex returns it from `thread/resume`), so Server Core publishes an empty `starting` snapshot first and the
 * transcript would otherwise sit blank under the status line.
 */
export function isAgentChatConversationLoading(
    snapshot: Pick<AgentChatSnapshot, 'items' | 'status'> | undefined,
    { hasConversation, isPending }: { hasConversation: boolean; isPending: boolean },
): boolean {
    if (!hasConversation) return false;
    if (isPending) return true;
    return snapshot?.status === 'starting' && snapshot.items.length === 0;
}

/**
 * The `meta` line under an empty, ready Chat's invitation, naming the composer gestures nobody finds by looking: the
 * `/` and `$` menus, attaching (images only when the provider takes them; any other file is inserted as its path), and
 * Shift+Enter. Either sigil opens the same list of commands and skills (`agentChatSlashQuery`), `$` leading with
 * skills, so the hint does not promise `$` only skills.
 */
export function agentChatEmptyHint(canAttachImages: boolean, t: Translate = translate): string {
    const files = t(
        canAttachImages
            ? 'agentChat.timeline.emptyHintImages'
            : 'agentChat.timeline.emptyHintPaths',
    );
    return t('agentChat.timeline.emptyHint', { files });
}

/**
 * What `+` → Files says a pick does. A picked image attaches only when the provider takes images; any other file is
 * inserted into the message as its path, so it says both. `canPickFolders` is the local panel that also takes folders
 * (`dialog.selectPaths`), which an SSH Host window does not offer.
 */
export function agentChatAttachLabel(
    canAttachImages: boolean,
    canPickFolders: boolean,
    t: Translate = translate,
): string {
    if (canPickFolders)
        return t(
            canAttachImages
                ? 'agentChat.message.attachImagesOrFolderPaths'
                : 'agentChat.message.insertFolderPaths',
        );
    return t(
        canAttachImages ? 'agentChat.message.attachImagesOrPaths' : 'agentChat.message.insertPaths',
    );
}

/**
 * Why the Chat cannot continue here, for the banner above the composer. `recovery` is what its one action does:
 * `restart` relaunches the provider on its bound conversation, which clears a failure and ends a hand-over; `reload`
 * reads a projection that never loaded again. `inUse` is a conversation another client of the provider holds open: like
 * `detached` it is not a fault, so it reads in the neutral tone, while its action is a retry after the user closes the
 * other client.
 */
export interface AgentChatRecoveryNotice {
    kind: 'detached' | 'failed' | 'inUse';
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
export function agentChatResumeFailureDetail(
    providerName: string,
    t: Translate = translate,
): string {
    return t('agentChat.timeline.resumeFailureDetail', { provider: providerName });
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
    t: Translate = translate,
): AgentChatRecoveryNotice | undefined {
    if (state.processState === 'detached')
        return {
            kind: 'detached',
            message:
                getTerminalExitPresentation('detached')?.label ?? t('agentChat.timeline.detached'),
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
        return { kind: 'failed', message: t('agentChat.timeline.loadFailed'), recovery };
    if (snapshot.failure.reason === 'conversation_in_use')
        return {
            kind: 'inUse',
            message: agentChatFailureMessage(
                'conversation_in_use',
                { providerName, surface: 'desktop' },
                t,
            ),
            // The provider's own detail only restates the heading, so the body names the way out instead.
            detail: t('agentChat.timeline.inUseDetail'),
            recovery,
        };
    if (snapshot.failure.reason === 'resume_failed')
        return {
            kind: 'failed',
            message: agentChatFailureMessage(
                'resume_failed',
                { providerName, surface: 'desktop' },
                t,
            ),
            detail: agentChatResumeFailureDetail(providerName, t),
            recovery,
            canOpenAsTerminal: true,
        };
    return {
        kind: 'failed',
        message: agentChatFailureMessage(
            snapshot.failure.reason,
            { providerName, surface: 'desktop' },
            t,
        ),
        ...(snapshot.failure.detail && { detail: snapshot.failure.detail }),
        recovery,
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

/**
 * What submitting the composer does. Enter sends when the Chat is idle and queues while a turn runs or the context is
 * compacting; Cmd+Enter (Ctrl+Enter off macOS) steers the running turn instead. While the main Agent waits on its
 * subagents and its provider ends that wait for a steered message (`isSteerDefault`), plain Enter steers too, as it
 * does in the Codex TUI: a queued message would sit behind the whole wait. Shift+Enter adds a line, and an IME
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
    state: { isTurnRunning: boolean; isBusy: boolean; isSteerDefault?: boolean },
): 'send' | 'queue' | 'steer' | undefined {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return undefined;
    const isSteerChord = event.metaKey || event.ctrlKey;
    if (state.isTurnRunning && (isSteerChord || state.isSteerDefault)) return 'steer';
    return state.isBusy ? 'queue' : 'send';
}

/**
 * /** Whether Enter steers instead of queueing: a turn runs, its main Agent waits on subagents, and the provider ends
 * that wait for a steered message (`chatSteerEndsWait`).
 */
export function isAgentChatSteerDefault(state: {
    isTurnRunning: boolean;
    isWaitingOnAgents: boolean;
    provider: AgentProvider | undefined;
}): boolean {
    const { isTurnRunning, isWaitingOnAgents, provider } = state;
    if (!isTurnRunning || !isWaitingOnAgents || provider === undefined) return false;
    return agentProviderCatalog[provider].capabilities.chatSteerEndsWait;
}

/**
 * The composer's send affordance for the Chat's state: while a turn runs, Enter queues, Cmd+Enter steers, and Esc stops
 * the turn, which the tooltip lists as `keys` rather than the placeholder or a hint row spelling them out. While the
 * main Agent waits on its subagents and Enter steers (`isSteerDefault`, see {@link agentChatSubmitDelivery}), Send is
 * Steer and its keys say so. While the Chat is otherwise busy (compacting, or draining the queue) a message waits its
 * turn. An idle Chat in plan mode asks for what to plan, since the next message starts a plan rather than changes.
 * `kind` says which one it is, since the label is translated and must not be compared.
 */
export function agentChatSendAction(
    state: {
        isTurnRunning: boolean;
        isBusy: boolean;
        isPlanMode?: boolean;
        isSteerDefault?: boolean;
    },
    providerName: string,
    t: Translate = translate,
): {
    kind: 'queue' | 'send' | 'steer';
    label: string;
    tooltip: string;
    /**
     * The key the tooltip shows as a keycap through `Tooltip`'s `shortcut`, so the locale string never spells it.
     */
    shortcut?: string;
    /**
     * The keys a running turn answers, listed by the tooltip in place of `tooltip` and `shortcut`.
     */
    keys?: readonly AgentChatSendKey[];
    placeholder: string;
} {
    if (state.isTurnRunning && state.isSteerDefault)
        return {
            kind: 'steer',
            label: t('agentChat.message.steer'),
            tooltip: t('agentChat.message.steerTooltip'),
            shortcut: 'enter',
            keys: [
                { label: t('agentChat.queue.steer'), shortcut: 'enter' },
                { label: t('agentChat.message.stopTurn'), shortcut: 'escape' },
            ],
            placeholder: t('agentChat.message.steerWaitPlaceholder'),
        };
    if (state.isTurnRunning)
        return {
            kind: 'queue',
            label: t('agentChat.message.queue'),
            tooltip: t('agentChat.message.queueTooltip'),
            shortcut: 'enter',
            keys: [
                { label: t('agentChat.message.queueTooltip'), shortcut: 'enter' },
                { label: t('agentChat.queue.steer'), shortcut: 'cmd+enter' },
                { label: t('agentChat.message.stopTurn'), shortcut: 'escape' },
            ],
            placeholder: t('agentChat.message.queuePlaceholder'),
        };
    if (state.isBusy)
        return {
            kind: 'queue',
            label: t('agentChat.message.queue'),
            tooltip: t('agentChat.message.queueTooltip'),
            shortcut: 'enter',
            placeholder: t('agentChat.message.queuePlaceholder'),
        };
    return {
        kind: 'send',
        label: t('agentChat.message.send'),
        tooltip: t('agentChat.message.sendTooltip'),
        shortcut: 'enter',
        placeholder: state.isPlanMode
            ? t('agentChat.message.planPlaceholder')
            : t('agentChat.message.placeholder', { provider: providerName }),
    };
}

/**
 * The input's placeholder. Goal mode asks for the goal, as the Codex app does. While a message waits at the head of the
 * queue, an empty input's Enter sends it now (`agentChatComposerKeyAction`). The placeholder says so in an idle Chat
 * and, while a turn runs, says Enter steers the first queued message into that turn; the queue's first row carries an
 * Enter chip as well.
 */
export function agentChatComposerPlaceholder(
    sendAction: { placeholder: string },
    state: {
        hasNextQueued: boolean;
        /**
         * A Ctrl+S stash waits, so the empty input says how to bring it back.
         */
        hasStash: boolean;
        isEditing: boolean;
        isGoalMode: boolean;
        isTurnRunning: boolean;
    },
    t: Translate = translate,
): string {
    if (state.hasStash && !state.isEditing) return t('agentChat.stash.placeholder');
    if (state.isGoalMode) return t('agentChat.goal.placeholder');
    if (!state.hasNextQueued || state.isEditing) return sendAction.placeholder;
    return t(
        state.isTurnRunning
            ? 'agentChat.message.steerQueuedPlaceholder'
            : 'agentChat.message.sendQueuedPlaceholder',
    );
}

/**
 * Whether Enter on an open slash list with no matching row is held for confirmation rather than sending the draft: the
 * first press on a draft is held (it may be a mistyped command), and a second press on the same draft sends it as
 * text.
 */
export function shouldConfirmUnmatchedSend(state: {
    /**
     * The draft a previous Enter was already held for, if any.
     */
    confirmingDraft: string | undefined;
    draft: string;
    matchCount: number;
}): boolean {
    return state.matchCount === 0 && state.confirmingDraft !== state.draft;
}

/**
 * What a key does to the open slash list (`suggestionMenuKeyAction`), or `undefined` when the key is not the list's and
 * the composer handles it. The first Enter on a draft with no match is held for confirmation
 * (`shouldConfirmUnmatchedSend`); the second falls through and sends the draft. Escape dismisses the list even with no
 * match, while moving, completing, and choosing need an active row.
 */
export type AgentChatCommandMenuKeyStep =
    | { kind: 'confirm' }
    | { kind: 'dismiss' }
    | { kind: 'move'; delta: -1 | 1 }
    | { kind: 'run'; handler: 'choose' | 'complete' };

export function agentChatCommandMenuKeyStep(
    action: SuggestionMenuKeyAction | undefined,
    state: Parameters<typeof shouldConfirmUnmatchedSend>[0] & { hasActiveCommand: boolean },
): AgentChatCommandMenuKeyStep | undefined {
    if (action === 'choose' && shouldConfirmUnmatchedSend(state)) return { kind: 'confirm' };
    if (action === 'dismiss') return { kind: 'dismiss' };
    if (!action || !state.hasActiveCommand) return undefined;
    if (action === 'next' || action === 'previous') {
        return { kind: 'move', delta: action === 'next' ? 1 : -1 };
    }
    return { kind: 'run', handler: action };
}

/**
 * Why Enter did not send a typed draft, for the composer to announce and show briefly, or `undefined` when it sent or
 * there was nothing to send. Without it a refused Enter does nothing visible: the Send button's tooltip says why, but
 * only to someone pointing at it. The reason is the one that tooltip gives (`agentChatSendTooltip`).
 */
export function agentChatSendRefusal(
    action: { tooltip: string },
    state: Parameters<typeof agentChatSendTooltip>[1] & { isSendable: boolean },
    t: Translate = translate,
): string | undefined {
    if (state.isSendable || !state.hasContent) return undefined;
    return agentChatSendTooltip(action, state, t);
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

/**
 * Whether Escape pressed in the Chat pane outside the composer stops the running turn. The composer, and every inline
 * editor, own Escape while the caret is in them (`isEditableTarget`), as does an open menu, popover, dialog, or list
 * (`isOverlayOpen`); a key some handler already consumed (`defaultPrevented`) is never acted on twice.
 */
export function shouldAgentChatPaneEscapeStop(
    event: Parameters<typeof isAgentChatInterruptKey>[0] & { defaultPrevented: boolean },
    state: { isTurnRunning: boolean; isEditableTarget: boolean; isOverlayOpen: boolean },
): boolean {
    return (
        isAgentChatInterruptKey(event) &&
        !event.defaultPrevented &&
        state.isTurnRunning &&
        !state.isEditableTarget &&
        !state.isOverlayOpen
    );
}

/**
 * The caption under a user message in the timeline. A message reaches the timeline only once it was delivered (a
 * pending follow-up waits in the queue cards above the composer), so a queued one is now an ordinary message and a
 * `Queued` caption would read as still pending. Only `Steered` says something still true: it joined a running turn.
 */
export function agentChatDeliveryCaption(
    delivery: 'queued' | 'steered' | undefined,
    t: Translate = translate,
): string | undefined {
    return delivery === 'steered' ? t('agentChat.message.steered') : undefined;
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

/**
 * What a skill card is called: the product skill by its product name, any other skill by its own name.
 */
export function agentChatSkillLabel(name: string, t: Translate = translate): string {
    return name === CAXRI_SKILL_NAME ? t('agentChat.skill.caxri') : name;
}

/**
 * How long a freshly shown approval card ignores pointer activation. The waiting popup swaps to the next request the
 * moment the previous one is answered, so the second click of a double click lands on a different Chat's buttons.
 */
export const AGENT_CHAT_APPROVAL_ARM_DELAY_MS = 450;

/**
 * Whether a click on an approval button should be ignored because the card only just appeared. A click synthesized by
 * the keyboard (`detail === 0`: Enter or Space on a focused button) passes, since the user deliberately tabbed there.
 */
export function isApprovalClickGuarded({
    armDelayMs,
    detail,
    elapsedMs,
}: {
    armDelayMs: number;
    /**
     * `MouseEvent.detail`: the click count, 0 for a keyboard-synthesized click.
     */
    detail: number;
    elapsedMs: number;
}): boolean {
    if (detail === 0 || armDelayMs <= 0) return false;
    return elapsedMs < armDelayMs;
}

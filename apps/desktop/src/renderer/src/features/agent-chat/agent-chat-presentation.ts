import type { AgentChatSnapshot, ProcessState } from '@caxri/protocol';
import { agentChatFailureMessage, projectRelativePath } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import type { SuggestionMenuKeyAction } from '../../lib/suggestion-options';
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
    t: Translate = translate,
): string | undefined {
    if (!snapshot || snapshot.items.length > 0) return undefined;
    if (processState === 'detached') return t('agentChat.timeline.emptyDetached');
    return snapshot.status === 'ready'
        ? t('agentChat.timeline.emptyReady', { provider: providerName })
        : undefined;
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
 * Chat is otherwise busy (compacting, or draining the queue) a message waits its turn. An idle Chat in plan mode asks
 * for what to plan, since the next message starts a plan rather than changes. `kind` says which one it is, since the
 * label is translated and must not be compared.
 */
export function agentChatSendAction(
    state: { isTurnRunning: boolean; isBusy: boolean; isPlanMode?: boolean },
    providerName: string,
    t: Translate = translate,
): {
    kind: 'queue' | 'send';
    label: string;
    tooltip: string;
    /**
     * The key the tooltip shows as a keycap through `Tooltip`'s `shortcut`, so the locale string never spells it. The
     * queue-or-steer tooltip names two keys and keeps them in its text, since a tooltip shows one shortcut.
     */
    shortcut?: string;
    placeholder: string;
} {
    if (state.isTurnRunning)
        return {
            kind: 'queue',
            label: t('agentChat.message.queue'),
            tooltip: t('agentChat.message.queueSteerTooltip'),
            placeholder: t('agentChat.message.queueSteerPlaceholder'),
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
 * queue, an empty input's Enter sends it now (`agentChatComposerKeyAction`), so the placeholder says so instead of
 * describing a follow-up nobody typed yet.
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
        /**
         * A Session chosen from the `@` list is being condensed into a reference file.
         */
        isPreparingReference?: boolean;
        isSending: boolean;
    },
    t: Translate = translate,
): string {
    return sendBlockedReason(state, t) ?? action.tooltip;
}

/**
 * The keycap the Send button's tooltip shows beside {@link agentChatSendTooltip}'s text: the action's shortcut while
 * Send can act, and none while the tooltip explains why it cannot, where a key would promise a press that does
 * nothing.
 */
export function agentChatSendTooltipShortcut(
    action: { shortcut?: string; tooltip: string },
    state: Parameters<typeof agentChatSendTooltip>[1],
): string | undefined {
    return sendBlockedReason(state, translate) === undefined ? action.shortcut : undefined;
}

function sendBlockedReason(
    state: Parameters<typeof agentChatSendTooltip>[1],
    t: Translate,
): string | undefined {
    switch (state.block) {
        case 'loading': {
            return t('agentChat.message.sendBlockedLoading');
        }
        case 'failed': {
            return t('agentChat.message.sendBlockedFailed');
        }
        case 'detached': {
            return t('agentChat.message.sendBlockedDetached');
        }
        case undefined: {
            break;
        }
    }
    if (state.isPreparingReference) return t('agentChat.message.preparingReference');
    if (state.isAttaching) return t('agentChat.message.attaching');
    if (state.isSending) return t('agentChat.message.sending');
    if (!state.hasContent) return t('agentChat.message.typeToSend');
    return undefined;
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

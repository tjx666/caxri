import type { AgentChatQueueEntry, AgentChatSnapshot } from '@caxri/protocol';
import { agentChatQueueEntry } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

type AgentChatQueue = NonNullable<AgentChatSnapshot['queue']>;

/**
 * One row of the phone's queue card: a shared queue row, or a message still on its way to Server Core
 * (`agent-chat-pending.ts`), shown at the end of the queue it will join with every action held until Server Core lists
 * it, as Desktop's card shows one.
 */
export type AgentChatQueueRow = AgentChatQueueEntry & { isPending?: true };

/**
 * The follow-up queue as the card above the phone's composer, in send order, each row named the way Desktop names it
 * (`agentChatQueueEntry`). The Server already cut each message to a preview (`clipAgentChatQueueForMobile`) without
 * changing its id, so every row's actions reach the real entry, and Edit fetches the full text as it takes the entry.
 * Entries in `pendingIds` are hidden while the phone waits for their delete, steer, or edit to land; `sending` are the
 * messages this phone is still sending into the queue.
 */
export const agentChatQueueEntries = (
    queue: AgentChatQueue | undefined,
    isTurnRunning: boolean,
    pendingIds: ReadonlySet<string> = new Set(),
    sending: ReadonlyArray<{ id: string; text: string; imageUris: readonly string[] }> = [],
): AgentChatQueueRow[] => [
    ...(queue ?? [])
        .filter((message) => !pendingIds.has(message.id))
        .map((message) => agentChatQueueEntry(message, isTurnRunning)),
    ...sending.map((message) => ({
        ...agentChatQueueEntry(
            { id: message.id, text: message.text, imageCount: message.imageUris.length },
            isTurnRunning,
        ),
        canSendNow: false,
        isPending: true as const,
    })),
];

export interface AgentChatQueueHeader {
    /**
     * `Queued`, or `Queue paused` while Stop holds the queue.
     */
    title: string;
    count: number;
    /**
     * Desktop's sub-caption: when the queue will send, or `undefined` while nothing holds it back.
     */
    detail: string | undefined;
    isPaused: boolean;
}

/**
 * The card's header, worded as Desktop's queue header. A queue paused by Stop sends nothing until it is resumed, so the
 * header says so beside its Resume action. The count is every waiting message: the `visibleCount` rows plus those past
 * the phone's preview (`queueLength`). `undefined` when nothing is left to show.
 */
export const agentChatQueueHeader = (
    snapshot: Pick<AgentChatSnapshot, 'queue' | 'queueLength' | 'queuePaused'> | undefined,
    isTurnRunning: boolean,
    visibleCount: number,
    t: Translate = translate,
): AgentChatQueueHeader | undefined => {
    const previewLength = snapshot?.queue?.length ?? 0;
    const count =
        visibleCount + Math.max(0, (snapshot?.queueLength ?? previewLength) - previewLength);
    if (count === 0) return undefined;
    if (snapshot?.queuePaused)
        return {
            title: t('chat.queue.paused'),
            count,
            detail: t('chat.queue.pausedDetail'),
            isPaused: true,
        };
    return {
        title: t('chat.queue.queued'),
        count,
        detail: isTurnRunning ? t('chat.queue.queuedDetail') : undefined,
        isPaused: false,
    };
};

/**
 * How much of the queue card shows. While the user types, the keyboard and composer already take most of the screen, so
 * the card shrinks to its one-line header (`Queued 3`) with an expand toggle and the timeline keeps its room; with the
 * keyboard down the rows always show. `isExpanded` is the toggle, which only matters while typing.
 */
export const agentChatQueueCardLayout = ({
    isComposing,
    isExpanded,
}: {
    isComposing: boolean;
    isExpanded: boolean;
}): { showsRows: boolean; showsToggle: boolean } => ({
    showsRows: !isComposing || isExpanded,
    showsToggle: isComposing,
});

/**
 * The screen reader hints for a queued row's Send now and Edit buttons: why a button is unavailable, or what Steer
 * does. A message still on its way holds both until Server Core lists it.
 */
/**
 * The queue row's visible button text, translated from the protocol's English label kind.
 */
export const agentChatQueueSendNowText = (
    entry: Pick<AgentChatQueueRow, 'sendNowLabel'>,
    t: Translate = translate,
): string => t(entry.sendNowLabel === 'Steer' ? 'chat.queue.steerShort' : 'chat.queue.sendNow');

export const agentChatQueueRowHints = (
    entry: AgentChatQueueRow,
    t: Translate = translate,
): { sendNow: string | undefined; edit: string | undefined } => {
    if (entry.isPending) {
        const waiting = t('chat.queue.pendingHint');
        return { sendNow: waiting, edit: waiting };
    }
    const sendNow = entry.canSendNow
        ? entry.sendNowLabel === 'Steer'
            ? t('chat.queue.steerHint')
            : undefined
        : t('chat.queue.commandWaits');
    return { sendNow, edit: undefined };
};

/**
 * What `mobile.agentChat.readQueued` says about a queued message the user taps Edit on, and the text to edit.
 */
export interface AgentChatQueueEditTarget {
    /**
     * What the user typed: the file, folder, and skill references the message carries are not part of it.
     */
    text: string;
    imageCount: number;
    hasReferences: boolean;
}

/**
 * How Edit treats a queued message. `draft`: a plain message is taken out of the queue and its text goes back into the
 * composer. `inPlace`: a message with images or references is rewritten where it stands, because neither can return to
 * the composer, and editing must neither drop them nor show their serialized block as text.
 */
export const agentChatQueueEditMode = (
    target: Pick<AgentChatQueueEditTarget, 'hasReferences' | 'imageCount'>,
): 'draft' | 'inPlace' => (target.imageCount > 0 || target.hasReferences ? 'inPlace' : 'draft');

/**
 * Whether an in-place edit may be saved: an emptied message with no images has nothing left to send, as on Desktop.
 */
export const canSaveAgentChatQueueEdit = (text: string, imageCount: number): boolean =>
    text.trim() !== '' || imageCount > 0;

/**
 * The note under an in-place editor saying how many images ride with the message, worded as Desktop's.
 */
export const agentChatQueueImagesAttached = (
    imageCount: number,
    t: Translate = translate,
): string =>
    imageCount === 1
        ? t('chat.queue.imagesAttachedOne')
        : t('chat.queue.imagesAttachedOther', { count: imageCount });

export type AgentChatQueueRowAction = 'remove' | 'sendNow' | 'edit';

const QUEUE_ERRORS = {
    remove: 'chat.queue.error.remove',
    sendNow: 'chat.queue.error.sendNow',
    edit: 'chat.queue.error.edit',
    resume: 'chat.queue.error.resume',
} as const;

/**
 * What a failed queue action says, in Desktop's words.
 */
export const agentChatQueueErrorMessage = (
    action: AgentChatQueueRowAction | 'resume',
    t: Translate = translate,
): string => t(QUEUE_ERRORS[action]);

/**
 * Why a failed row action failed, when the reason changes what the phone says. `gone`: the message left the queue first
 * (the queue sent it, or another device removed it). `tooLong`: Edit refused a message over what the phone may send
 * again, which stays queued for the computer.
 */
export type AgentChatQueueFailure = 'gone' | 'tooLong' | 'other';

export const agentChatQueueFailure = (
    action: AgentChatQueueRowAction,
    code: string | undefined,
): AgentChatQueueFailure => {
    if (code === 'CONFLICT') return 'gone';
    if (action === 'edit' && code === 'VALIDATION') return 'tooLong';
    return 'other';
};

/**
 * The explanation an Edit that came back empty-handed needs. A row that already left the queue is gone from the card
 * too, and the queue may now be empty, so an inline error would explain nothing on screen; the phone shows these in an
 * alert instead, so the reader learns why nothing came back to the composer.
 */
export const agentChatQueueEditAlert = (
    failure: 'gone' | 'tooLong',
    t: Translate = translate,
): { title: string; message: string } =>
    failure === 'gone'
        ? { title: t('chat.queue.goneTitle'), message: t('chat.queue.goneMessage') }
        : { title: t('chat.queue.tooLongTitle'), message: t('chat.queue.tooLongMessage') };

/**
 * Runs one row action optimistically: the row disappears at once, because Delete, Steer, and Edit all take it out of
 * the queue, and comes back with an error when the Server refuses. On success it stays hidden until the next snapshot
 * drops it, so a late patch cannot flash it back. `reportError` receives the failure's code too, so a caller can tell
 * an entry that is already gone from one that can be retried.
 */
export const didRunOptimisticQueueAction = async ({
    action,
    hide,
    id,
    perform,
    reportError,
    reveal,
    t = translate,
}: {
    action: AgentChatQueueRowAction;
    hide: (id: string) => void;
    id: string;
    perform: (id: string) => Promise<void>;
    reportError: (message: string | null, failure?: AgentChatQueueFailure) => void;
    reveal: (id: string) => void;
    t?: Translate;
}): Promise<boolean> => {
    reportError(null);
    hide(id);
    try {
        await perform(id);
        return true;
    } catch (error) {
        reveal(id);
        const code =
            error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? error.code
                : undefined;
        reportError(agentChatQueueErrorMessage(action, t), agentChatQueueFailure(action, code));
        return false;
    }
};

/**
 * The pending ids still worth hiding: an id the snapshot no longer lists has left the queue, so it is forgotten.
 * Returns the same set when nothing changed, so a state update can bail out.
 */
export const prunePendingQueueIds = (
    pendingIds: ReadonlySet<string>,
    queue: AgentChatQueue | undefined,
): ReadonlySet<string> => {
    const kept = new Set<string>();
    const entries = queue ?? [];
    for (const entry of entries) if (pendingIds.has(entry.id)) kept.add(entry.id);
    return kept.size === pendingIds.size ? pendingIds : kept;
};

/**
 * A failed queue action's inline error, with the row it was about. Resume concerns the whole queue, so it names none.
 */
export interface AgentChatQueueError {
    message: string;
    id?: string;
}

/**
 * The error still worth showing against the current queue. Once the queue empties, or the row a Delete or Steer failed
 * on has left it, the error explains nothing on screen and would otherwise come back with the next queued message.
 * Returns the same error when it still applies, so a state update can bail out.
 */
export const currentQueueError = (
    error: AgentChatQueueError | null,
    queue: AgentChatQueue | undefined,
): AgentChatQueueError | null => {
    if (!error) return null;
    const entries = queue ?? [];
    if (entries.length === 0) return null;
    if (error.id !== undefined && entries.every((entry) => entry.id !== error.id)) return null;
    return error;
};

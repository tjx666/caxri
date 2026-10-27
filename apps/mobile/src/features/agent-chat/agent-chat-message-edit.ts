import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatRewindTarget, MOBILE_AGENT_CHAT_CLIP_MARKER } from '@caxri/protocol';

import type { Translate } from '../../i18n';

/**
 * "Edit from Here" in progress on the phone: the earlier message the composer's text replaces, and the draft the
 * composer held before, put back when the edit is cancelled or sent, as on Desktop.
 */
export interface AgentChatMessageEdit {
    itemId: string;
    previousDraft: string;
    /**
     * The turns sending the edit replaces, counted when it started from the window and the older pages the reader
     * loaded; the composer sees only the live window, which may no longer hold the message.
     */
    removedTurns: number;
}

/**
 * The message an edit starts from, as the message sheet hands it to the composer.
 */
export type AgentChatEditTarget = Pick<AgentChatMessageEdit, 'itemId' | 'removedTurns'>;

type EditSnapshot = Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'operation' | 'turns'>;

/**
 * Whether a message offers "Edit from Here" and how many turns sending the edit replaces, or the reason, in Desktop's
 * words, it cannot be edited now. A message with images is refused: its images stay on Server Core and never return to
 * a composer. The phone never restores files, so a provider without file checkpoints edits the same way.
 */
export function agentChatMessageEditAvailability(
    snapshot: EditSnapshot | undefined,
    itemId: string,
    t: Translate,
): { canEdit: true; removedTurns: number } | { canEdit: false; reason: string } {
    if (!snapshot) return { canEdit: false, reason: t('chat.edit.cannotEdit') };
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    if (item?.type === 'userMessage' && (item.images?.length ?? 0) > 0)
        return { canEdit: false, reason: t('chat.edit.imagesUnsupported') };
    const result = agentChatRewindTarget(snapshot, itemId);
    if ('target' in result) return { canEdit: true, removedTurns: result.target.removedTurns };
    return {
        canEdit: false,
        reason: t(
            result.refusal === 'turnRunning' ? 'chat.edit.stopToEdit' : 'chat.edit.cannotEdit',
        ),
    };
}

/**
 * The caption above the composer while it holds an edit: what sending it replaces.
 */
export const agentChatMessageEditCaption = (removedTurns: number, t: Translate): string =>
    removedTurns > 1
        ? t('chat.edit.captionOther', { count: removedTurns })
        : t('chat.edit.captionOne');

/**
 * Whether the phone's window kept only the tail of a message (`clipAgentChatItemForMobile`), so its whole text has to
 * be read from Server Core before it is copied.
 */
export const isAgentChatMessageClipped = (text: string): boolean =>
    text.startsWith(MOBILE_AGENT_CHAT_CLIP_MARKER);

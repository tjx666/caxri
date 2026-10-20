import { translate } from '../../../i18n';
import { readAgentChatDraft, updateAgentChatDraft } from './agent-chat-drafts';
import { draftWithLongPasteAsText } from './agent-chat-long-paste';

/**
 * A long paste saved as a file whose notice offers Paste as Text: the reference the draft cites and the original text
 * that replaces it. The text stays here rather than in the toast action, which must remain plain identity data.
 */
interface SavedAgentChatPaste {
    reference: string;
    terminalId: string;
    text: string;
}

/**
 * How many recent saved pastes can still be pasted as text. Memory only and bounded, because each holds pasted text up
 * to the long-paste file limit; an older notice's Paste as Text says it is no longer available.
 */
const MAX_SAVED_PASTES = 5;

const savedPastes = new Map<string, SavedAgentChatPaste>();

/**
 * Keeps a saved paste for its notice's Paste as Text and returns the id the toast action carries.
 */
export function rememberAgentChatSavedPaste(paste: SavedAgentChatPaste): string {
    const pasteId = crypto.randomUUID();
    savedPastes.set(pasteId, paste);
    for (const id of savedPastes.keys()) {
        if (savedPastes.size <= MAX_SAVED_PASTES) break;
        savedPastes.delete(id);
    }
    return pasteId;
}

/**
 * Why Paste as Text can no longer run, or `undefined` when it can: the paste was forgotten (a reload, or newer pastes
 * pushed it out), its reference left the draft, or the text no longer fits the message.
 */
export function agentChatPasteAsTextUnavailableReason({
    pasteId,
}: {
    pasteId: string;
}): string | undefined {
    const paste = savedPastes.get(pasteId);
    if (!paste) return translate('agentChat.composer.pasteAsTextGone');
    const draft = readAgentChatDraft(paste.terminalId);
    if (!draft.includes(paste.reference)) return translate('agentChat.composer.pasteAsTextGone');
    if (draftWithLongPasteAsText(draft, paste.reference, paste.text) === undefined)
        return translate('agentChat.composer.pasteAsTextTooLong');
    return undefined;
}

/**
 * Replaces a saved paste's reference in its Chat's draft with the pasted text: in the composer on screen when it is
 * mounted, otherwise in the stored draft it opens with. The saved file stays where it is; only the draft stops citing
 * it.
 */
export function pasteAgentChatSavedPasteAsText({ pasteId }: { pasteId: string }): void {
    const paste = savedPastes.get(pasteId);
    if (!paste) return;
    savedPastes.delete(pasteId);
    updateAgentChatDraft(
        paste.terminalId,
        (draft) => draftWithLongPasteAsText(draft, paste.reference, paste.text) ?? draft,
    );
}

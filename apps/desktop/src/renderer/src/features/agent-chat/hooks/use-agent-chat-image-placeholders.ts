import type { RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
    agentChatComposerImagePills,
    agentChatImagePlaceholderChanges,
    agentChatImagePlaceholderRemoval,
    draftWithoutImagePlaceholders,
    nextAgentChatImageToken,
} from '../attachments/agent-chat-image-placeholders';
import type { AgentChatComposerInput } from '../composer/agent-chat-composer-view';
import type { AgentChatImageAttachment } from '../composer-input/agent-chat-drafts';
import { isAgentChatImageAttachment } from '../composer-input/agent-chat-drafts';
import type { useAgentChatAttachments } from './use-agent-chat-attachments';

/**
 * Keeps the composer's images and their `[Image #N]` placeholders in step (`agent-chat-image-placeholders.ts`): an
 * image's placeholder deleted from the text removes the image, removing the image from the row deletes its placeholder,
 * and undo brings both back. Images removed while the draft is written are kept here, by number, so undo can return
 * them; the list and the numbering start over once the draft and its images are both empty, as after a send.
 */
export function useAgentChatImagePlaceholders({
    draft,
    images: { attachments, reattach, remove },
    inputReference,
    setDraft,
}: {
    draft: string;
    images: Pick<ReturnType<typeof useAgentChatAttachments>, 'attachments' | 'reattach' | 'remove'>;
    inputReference: RefObject<AgentChatComposerInput | null>;
    setDraft: (update: (current: string) => string) => void;
}) {
    /**
     * The image whose preview is open, from its thumbnail or its pill.
     */
    const [previewId, setPreviewId] = useState<string>();
    /**
     * Keeps its identity while the images stay the same, since a new array redraws every pill.
     */
    const pills = useMemo(() => agentChatComposerImagePills(attachments), [attachments]);
    const removed = useRef(new Map<number, AgentChatImageAttachment>());
    /**
     * The last number handed out, so images pasted again before the first ones finish reading get numbers of their own.
     */
    const issued = useRef(0);
    const hasImages = attachments.some(isAgentChatImageAttachment);
    useEffect(() => {
        if (draft !== '' || hasImages) return;
        removed.current.clear();
        issued.current = 0;
    }, [draft, hasImages]);
    /**
     * Takes `image` out of the composer and keeps it for undo. An image already taken out is skipped: the editor
     * reports the placeholder removal this composer made itself before React drops the image from `attachments`.
     */
    const detach = (image: AgentChatImageAttachment): void => {
        if (image.token !== undefined) {
            if (removed.current.get(image.token)?.id === image.id) return;
            removed.current.set(image.token, image);
        }
        remove(image.id);
    };
    return {
        pills,
        preview: { id: previewId, onChange: setPreviewId },
        /**
         * Opens the preview of the image whose placeholder is `token`.
         */
        openImage: (token: number): void =>
            setPreviewId(
                attachments.find(
                    (attachment) =>
                        isAgentChatImageAttachment(attachment) && attachment.token === token,
                )?.id,
            ),
        /**
         * The first of `count` numbers for images about to be attached.
         */
        reserve: (count: number): number => {
            const draftNow = inputReference.current?.value ?? draft;
            const first = Math.max(
                issued.current + 1,
                nextAgentChatImageToken(draftNow, attachments, removed.current.keys()),
            );
            issued.current = first + count - 1;
            return first;
        },
        /**
         * Follows an edit the user made in the editor.
         */
        onEdit: (value: string): void => {
            const { detached, reattached } = agentChatImagePlaceholderChanges(
                value,
                attachments,
                removed.current,
            );
            for (const image of detached) detach(image);
            if (reattached.length === 0) return;
            for (const { token } of reattached)
                if (token !== undefined) removed.current.delete(token);
            reattach(reattached);
        },
        /**
         * Removes an attachment from the row; an image's placeholder leaves the text in the same undoable edit. Focus
         * returns to the message input, since the Remove button that had it unmounts.
         */
        removeAttachment: (id: string): void => {
            const attachment = attachments.find((candidate) => candidate.id === id);
            const input = inputReference.current;
            if (
                !attachment ||
                !isAgentChatImageAttachment(attachment) ||
                attachment.token === undefined
            ) {
                remove(id);
            } else {
                detach(attachment);
                const tokens = new Set([attachment.token]);
                if (input?.element) {
                    const edit = agentChatImagePlaceholderRemoval(
                        input.value,
                        input.selectionEnd,
                        tokens,
                    );
                    if (edit) input.applyEdit(edit);
                } else setDraft((current) => draftWithoutImagePlaceholders(current, tokens));
            }
            input?.focus();
        },
    };
}

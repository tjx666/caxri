import { useEffect, useRef, useState } from 'react';

import { agentChatTextWithSentImageNumbers, draftWithoutImagePlaceholders } from '@caxri/protocol';

import {
    agentChatImagePlaceholderSync,
    draftWithImagePlaceholders,
    draftWithWholePlaceholders,
} from './agent-chat-image-placeholders';

/**
 * Keeps the Chat composer's images and their `[Image #N]` placeholders in step, as Desktop's composer does
 * (`agentChatImagePlaceholderSync`): attaching an image writes its placeholder at the cursor, deleting the placeholder
 * removes the image, and removing the image from the strip deletes its placeholder.
 */
export function useAgentChatImagePlaceholders({
    draft,
    imageIds,
    remove,
    setDraft,
}: {
    draft: string;
    imageIds: readonly string[];
    remove: (id: string) => void;
    setDraft: (draft: string) => void;
}) {
    const tokens = useRef(new Map<string, number>());
    /**
     * Where the caret last was, so a new image's placeholder lands where the reader was typing.
     */
    const cursorReference = useRef(draft.length);
    /**
     * The numbers of attached images, so the field draws a pill only for a placeholder an image owns.
     */
    const [owned, setOwned] = useState<ReadonlySet<number>>(new Set());
    const idsKey = imageIds.join('\n');
    useEffect(() => {
        const sync = agentChatImagePlaceholderSync({ draft, imageIds, tokens: tokens.current });
        tokens.current = sync.tokens;
        const numbers = new Set(sync.tokens.values());
        setOwned((current) =>
            current.size === numbers.size && [...numbers].every((number) => current.has(number))
                ? current
                : numbers,
        );
        // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent -- The images live in an external store that the async picker and the strip's remove button change, so only an effect sees both the draft and the images settle.
        for (const id of sync.detached) remove(id);
        let next = draft;
        if (sync.orphaned.length > 0)
            next = draftWithoutImagePlaceholders(next, new Set(sync.orphaned));
        if (sync.inserted.length > 0) {
            const written = draftWithImagePlaceholders(
                next,
                cursorReference.current,
                sync.inserted,
            );
            next = written.draft;
            cursorReference.current = written.cursor;
        }
        // react-doctor-disable-next-line react-doctor/no-pass-live-state-to-parent -- See the removal above.
        if (next !== draft) setDraft(next);
        // `idsKey` stands for `imageIds`, whose array identity changes on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft, idsKey]);
    return {
        /**
         * The field's edited text, with a pill a deletion cut into taken out whole.
         */
        edited: (next: string): string => draftWithWholePlaceholders(draft, next, owned),
        /**
         * Records the caret's offset as the field reports it.
         */
        onCursorChange: (offset: number): void => {
            cursorReference.current = offset;
        },
        owned,
        /**
         * `text` with each placeholder renumbered by the order `sentIds` are sent, the numbering the Agent reads.
         */
        sentText: (text: string, sentIds: readonly string[]): string =>
            agentChatTextWithSentImageNumbers(
                text,
                sentIds.map((id) => ({ token: tokens.current.get(id) })),
            ),
    };
}

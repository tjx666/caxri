import { useRef, useState } from 'react';

import type { AgentChatPathReference } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { awaitThenCleanup } from '../../../lib/await-then-cleanup';
import { pushToast } from '../../../stores/toasts';
import { attachmentsWithReattached } from '../attachments/agent-chat-image-placeholders';
import type {
    AgentChatImageRejection,
    AgentChatImageReservation,
} from '../attachments/agent-chat-images';
import {
    agentChatImageBytes,
    agentChatImageRejection,
    agentChatImageRejectionMessage,
    agentChatImageReservedBytes,
    AgentChatImageTooLargeError,
    readAgentChatImage,
} from '../attachments/agent-chat-images';
import type {
    AgentChatAttachment,
    AgentChatImageAttachment,
    AgentChatPathAttachment,
    AgentChatSkillAttachment,
} from '../composer-input/agent-chat-drafts';
import {
    agentChatAttachmentsWithReferences,
    attachmentsAfterSend,
    attachmentsWithReturned,
    isAgentChatImageAttachment,
    readAgentChatAttachments,
    writeAgentChatAttachments,
} from '../composer-input/agent-chat-drafts';

/**
 * What `attachments` hold against the image limits. A file or folder card is sent as a path and counts toward neither.
 */
function reservationOf(attachments: readonly AgentChatAttachment[]): AgentChatImageReservation {
    const images = attachments.filter(isAgentChatImageAttachment);
    return {
        count: images.length,
        bytes: images.reduce(
            (total, attachment) => total + agentChatImageBytes(attachment.image),
            0,
        ),
    };
}

/**
 * The composer's attachments: images validated and read as they are pasted, dropped, or picked, and file or folder
 * cards (`addPaths`), and skill cards (`addSkill`), kept per Chat across remounts and cleared once the message that
 * carried them was accepted.
 */
export function useAgentChatAttachments(terminalId: string) {
    const [attachments, setAttachments] = useState(() => readAgentChatAttachments(terminalId));
    const [readingCount, setReadingCount] = useState(0);
    /**
     * Attached plus still-reading images, so files added in quick succession cannot together pass the count or combined
     * size limit.
     */
    const [initialReservation] = useState(() => reservationOf(attachments));
    const reserved = useRef<AgentChatImageReservation>(initialReservation);
    const update = (next: (current: AgentChatAttachment[]) => AgentChatAttachment[]): void =>
        setAttachments((current) => {
            const updated = next(current);
            writeAgentChatAttachments(terminalId, updated);
            return updated;
        });
    /**
     * Reads `files` as images. With `firstToken`, each accepted image gets the next placeholder number from it, in the
     * order the files came, and the numbers of the ones read are returned so the composer can write their placeholders
     * (`agent-chat-image-placeholders.ts`); a file that fails leaves its number unused.
     */
    const add = async (files: readonly File[], firstToken?: number): Promise<number[]> => {
        const accepted: File[] = [];
        /**
         * Rejected file names per reason, so one toast per reason can name the files it refused.
         */
        const rejections = new Map<AgentChatImageRejection, string[]>();
        for (const file of files) {
            const rejection = agentChatImageRejection(file, reserved.current);
            if (rejection)
                rejections.set(rejection, [...(rejections.get(rejection) ?? []), file.name]);
            else {
                accepted.push(file);
                reserved.current = {
                    count: reserved.current.count + 1,
                    bytes: reserved.current.bytes + agentChatImageReservedBytes(file),
                };
            }
        }
        for (const [rejection, fileNames] of rejections)
            pushToast('error', agentChatImageRejectionMessage(rejection, fileNames));
        if (accepted.length === 0) return [];
        setReadingCount((count) => count + accepted.length);
        const results = await Promise.allSettled(accepted.map((file) => readAgentChatImage(file)));
        setReadingCount((count) => count - accepted.length);
        const images = results.flatMap((result, index) =>
            result.status === 'fulfilled'
                ? [
                      {
                          ...result.value,
                          name: accepted[index]?.name,
                          token: firstToken === undefined ? undefined : firstToken + index,
                      },
                  ]
                : [],
        );
        // Swap each file's estimate for the bytes actually read, so `release` later frees exactly what it holds.
        const estimated = accepted.reduce(
            (total, file) => total + agentChatImageReservedBytes(file),
            0,
        );
        reserved.current = {
            count: reserved.current.count - (accepted.length - images.length),
            bytes:
                reserved.current.bytes -
                estimated +
                images.reduce((total, { image }) => total + agentChatImageBytes(image), 0),
        };
        const tooLarge = results.flatMap((result, index) =>
            result.status === 'rejected' && result.reason instanceof AgentChatImageTooLargeError
                ? [accepted[index]?.name ?? '']
                : [],
        );
        if (tooLarge.length > 0)
            pushToast('error', agentChatImageRejectionMessage('size', tooLarge));
        if (images.length + tooLarge.length < accepted.length)
            pushToast('error', translate('agentChat.images.unreadable'));
        update((current) => [
            ...current,
            ...images.map(({ image, isResized, name, token }) => ({
                id: crypto.randomUUID(),
                image,
                name,
                ...(isResized && { isResized }),
                ...(token !== undefined && { token }),
            })),
        ]);
        return images.flatMap(({ token }) => (token === undefined ? [] : [token]));
    };
    /**
     * Adds file, folder, and skill cards, skipping a path or skill already attached. Returns the ids of `cards`; a
     * skipped card's id matches no card.
     */
    const addCards = (
        cards: ReadonlyArray<AgentChatPathAttachment | AgentChatSkillAttachment>,
    ): string[] => {
        if (cards.length === 0) return [];
        update((current) => agentChatAttachmentsWithReferences(current, cards));
        return cards.map(({ id }) => id);
    };
    /**
     * Adds a card for each of `references`, skipping a path already attached.
     */
    const addPaths = (references: readonly AgentChatPathReference[]): string[] =>
        addCards(
            references.map(({ isDirectory, path }) => ({
                id: crypto.randomUUID(),
                path,
                isDirectory,
            })),
        );
    /**
     * Adds cards for references that are still being resolved (a dropped path's folder probe). The wait counts as
     * reading from the call on, synchronously, so it shows the spinner placeholder and holds Send until the real cards
     * are attached; a message sent right after a drop therefore carries them instead of the next one.
     */
    const addPathsWhenResolved = async (
        resolving: Promise<readonly AgentChatPathReference[]>,
    ): Promise<void> => {
        setReadingCount((count) => count + 1);
        /**
         * Resolving a path cannot reasonably fail. The `finally` lives in `awaitThenCleanup` because React Compiler
         * cannot compile one inside a hook.
         */
        const addWhenSettled = async (): Promise<void> => {
            try {
                addPaths(await resolving);
            } catch {
                // No card is attached; Send is released below all the same.
            }
        };
        await awaitThenCleanup(addWhenSettled(), () => setReadingCount((count) => count - 1));
    };
    /**
     * Removes the cards `ids` names, such as the ones an "Edit from here" brought back when the edit is cancelled.
     */
    const removeCards = (ids: readonly string[]): void => {
        const removed = new Set(ids);
        update((current) => current.filter((attachment) => !removed.has(attachment.id)));
    };
    const release = (released: readonly AgentChatAttachment[]): void => {
        const freed = reservationOf(released);
        reserved.current = {
            count: reserved.current.count - freed.count,
            bytes: reserved.current.bytes - freed.bytes,
        };
    };
    const remove = (id: string): void => {
        release(attachments.filter((attachment) => attachment.id === id));
        update((current) => current.filter((attachment) => attachment.id !== id));
    };
    const clearSent = (sent: readonly AgentChatAttachment[]): void => {
        release(sent);
        update((current) => attachmentsAfterSend(current, sent));
    };
    /**
     * Puts `taken` back through `place` and reserves the ones not attached already. The stored list mirrors this
     * composer's state (`update` writes both), and the reservation must change once, outside an updater React may run
     * twice.
     */
    const putBack = <T extends AgentChatAttachment>(
        taken: readonly T[],
        place: (current: AgentChatAttachment[], returned: T[]) => AgentChatAttachment[],
    ): void => {
        const attached = new Set(readAgentChatAttachments(terminalId).map(({ id }) => id));
        const returned = taken.filter((attachment) => !attached.has(attachment.id));
        if (returned.length === 0) return;
        const reservation = reservationOf(returned);
        reserved.current = {
            count: reserved.current.count + reservation.count,
            bytes: reserved.current.bytes + reservation.bytes,
        };
        update((current) => place(current, returned));
    };
    /**
     * Puts back images whose message failed to send, ahead of any attached since, and reserves them again.
     */
    const restoreUnsent = (sent: readonly AgentChatAttachment[]): void =>
        putBack(sent, attachmentsWithReturned);
    /**
     * Puts back images whose placeholders came back into the draft (undo), each in its place among the images.
     */
    const reattach = (images: readonly AgentChatImageAttachment[]): void =>
        putBack(images, attachmentsWithReattached);
    return {
        attachments,
        readingCount,
        isReading: readingCount > 0,
        /**
         * Whether the attachment row shows: an attached image, or one still being read and resized.
         */
        hasAttachmentRow: attachments.length > 0 || readingCount > 0,
        add,
        addCards,
        addPaths,
        addPathsWhenResolved,
        /**
         * Attaches a skill card for `name`; a skill already attached stays one card.
         */
        addSkill: (name: string): void => {
            addCards([{ id: crypto.randomUUID(), skill: name }]);
        },
        remove,
        removeCards,
        clearSent,
        reattach,
        restoreUnsent,
    };
}

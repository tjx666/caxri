import { useRef, useState } from 'react';

import type { AgentChatPathReference } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { pushToast } from '../../../stores/toasts';
import type { AgentChatAttachment } from '../agent-chat-drafts';
import {
    agentChatAttachmentsWithPaths,
    attachmentsAfterSend,
    attachmentsWithReturned,
    isAgentChatImageAttachment,
    readAgentChatAttachments,
    writeAgentChatAttachments,
} from '../agent-chat-drafts';
import type { AgentChatImageRejection, AgentChatImageReservation } from '../agent-chat-images';
import {
    agentChatImageBytes,
    agentChatImageRejection,
    agentChatImageRejectionMessage,
    agentChatImageReservedBytes,
    AgentChatImageTooLargeError,
    readAgentChatImage,
} from '../agent-chat-images';

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
 * cards (`addPaths`), kept per Chat across remounts and cleared once the message that carried them was accepted.
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
    const add = async (files: readonly File[]): Promise<void> => {
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
        if (accepted.length === 0) return;
        setReadingCount((count) => count + accepted.length);
        const results = await Promise.allSettled(accepted.map((file) => readAgentChatImage(file)));
        setReadingCount((count) => count - accepted.length);
        const images = results.flatMap((result, index) =>
            result.status === 'fulfilled' ? [{ ...result.value, name: accepted[index]?.name }] : [],
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
            ...images.map(({ image, isResized, name }) => ({
                id: crypto.randomUUID(),
                image,
                name,
                ...(isResized && { isResized }),
            })),
        ]);
    };
    /**
     * Adds a card for each of `references`, skipping a path already attached. Returns the ids it gave the new cards; a
     * skipped path's id matches no card.
     */
    const addPaths = (references: readonly AgentChatPathReference[]): string[] => {
        if (references.length === 0) return [];
        const added = references.map(({ isDirectory, path }) => ({
            id: crypto.randomUUID(),
            path,
            isDirectory,
        }));
        update((current) => agentChatAttachmentsWithPaths(current, added));
        return added.map(({ id }) => id);
    };
    /**
     * Removes the cards `ids` names, such as the ones an "Edit from here" brought back when the edit is cancelled.
     */
    const removePaths = (ids: readonly string[]): void => {
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
     * Puts back images whose message failed to send, ahead of any attached since, and reserves them again.
     */
    const restoreUnsent = (sent: readonly AgentChatAttachment[]): void => {
        // The stored list mirrors this composer's state (`update` writes both), and the reservation must change once,
        // outside an updater React may run twice.
        const attached = new Set(readAgentChatAttachments(terminalId).map(({ id }) => id));
        const returned = sent.filter((attachment) => !attached.has(attachment.id));
        if (returned.length === 0) return;
        const taken = reservationOf(returned);
        reserved.current = {
            count: reserved.current.count + taken.count,
            bytes: reserved.current.bytes + taken.bytes,
        };
        update((current) => attachmentsWithReturned(current, returned));
    };
    return {
        attachments,
        readingCount,
        isReading: readingCount > 0,
        /**
         * Whether the attachment row shows: an attached image, or one still being read and resized.
         */
        hasAttachmentRow: attachments.length > 0 || readingCount > 0,
        add,
        addPaths,
        remove,
        removePaths,
        clearSent,
        restoreUnsent,
    };
}

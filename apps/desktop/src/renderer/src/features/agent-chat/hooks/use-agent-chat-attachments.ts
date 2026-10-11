import { useRef, useState } from 'react';

import { pushToast } from '../../../stores/toasts';
import type { AgentChatAttachment } from '../agent-chat-drafts';
import {
    attachmentsAfterSend,
    readAgentChatAttachments,
    writeAgentChatAttachments,
} from '../agent-chat-drafts';
import type { AgentChatImageRejection, AgentChatImageReservation } from '../agent-chat-images';
import {
    agentChatImageBytes,
    agentChatImageRejection,
    agentChatImageRejectionMessage,
    readAgentChatImage,
} from '../agent-chat-images';

function reservationOf(attachments: readonly AgentChatAttachment[]): AgentChatImageReservation {
    return {
        count: attachments.length,
        bytes: attachments.reduce(
            (total, attachment) => total + agentChatImageBytes(attachment.image),
            0,
        ),
    };
}

/**
 * The composer's image attachments: validated and read as they are pasted, dropped, or picked, kept per Chat across
 * remounts, and cleared once the message that carried them was accepted.
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
                    bytes: reserved.current.bytes + file.size,
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
            result.status === 'fulfilled'
                ? [{ image: result.value, name: accepted[index]?.name }]
                : [],
        );
        const unread = accepted.filter((_, index) => results[index]?.status !== 'fulfilled');
        reserved.current = {
            count: reserved.current.count - unread.length,
            bytes: reserved.current.bytes - unread.reduce((total, file) => total + file.size, 0),
        };
        if (images.length < accepted.length) pushToast('error', 'An image could not be read');
        update((current) => [
            ...current,
            ...images.map(({ image, name }) => ({ id: crypto.randomUUID(), image, name })),
        ]);
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
    return { attachments, isReading: readingCount > 0, add, remove, clearSent };
}

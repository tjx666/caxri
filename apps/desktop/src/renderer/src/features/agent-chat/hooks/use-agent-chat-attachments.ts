import { useRef, useState } from 'react';

import { pushToast } from '../../../stores/toasts';
import type { AgentChatAttachment } from '../agent-chat-drafts';
import {
    attachmentsAfterSend,
    readAgentChatAttachments,
    writeAgentChatAttachments,
} from '../agent-chat-drafts';
import type { AgentChatImageRejection } from '../agent-chat-images';
import {
    agentChatImageRejection,
    agentChatImageRejectionMessage,
    readAgentChatImage,
} from '../agent-chat-images';

/**
 * The composer's image attachments: validated and read as they are pasted, dropped, or picked, kept per Chat across
 * remounts, and cleared once the message that carried them was accepted.
 */
export function useAgentChatAttachments(terminalId: string) {
    const [attachments, setAttachments] = useState(() => readAgentChatAttachments(terminalId));
    const [readingCount, setReadingCount] = useState(0);
    /**
     * Attached plus still-reading images, so files added in quick succession cannot together pass the count limit.
     */
    const reservedCount = useRef(attachments.length);
    const update = (next: (current: AgentChatAttachment[]) => AgentChatAttachment[]): void =>
        setAttachments((current) => {
            const updated = next(current);
            writeAgentChatAttachments(terminalId, updated);
            return updated;
        });
    const add = async (files: readonly File[]): Promise<void> => {
        const accepted: File[] = [];
        const rejections = new Set<AgentChatImageRejection>();
        for (const file of files) {
            const rejection = agentChatImageRejection(file, reservedCount.current);
            if (rejection) rejections.add(rejection);
            else {
                accepted.push(file);
                reservedCount.current += 1;
            }
        }
        for (const rejection of rejections)
            pushToast('error', agentChatImageRejectionMessage(rejection));
        if (accepted.length === 0) return;
        setReadingCount((count) => count + accepted.length);
        const results = await Promise.allSettled(accepted.map((file) => readAgentChatImage(file)));
        setReadingCount((count) => count - accepted.length);
        const images = results.flatMap((result) =>
            result.status === 'fulfilled' ? [result.value] : [],
        );
        reservedCount.current -= accepted.length - images.length;
        if (images.length < accepted.length) pushToast('error', 'An image could not be read');
        update((current) => [
            ...current,
            ...images.map((image) => ({ id: crypto.randomUUID(), image })),
        ]);
    };
    const remove = (id: string): void => {
        reservedCount.current -= 1;
        update((current) => current.filter((attachment) => attachment.id !== id));
    };
    const clearSent = (sent: readonly AgentChatAttachment[]): void => {
        reservedCount.current -= sent.length;
        update((current) => attachmentsAfterSend(current, sent));
    };
    return { attachments, isReading: readingCount > 0, add, remove, clearSent };
}

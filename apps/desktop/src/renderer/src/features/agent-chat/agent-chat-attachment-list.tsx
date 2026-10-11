import { useEffect, useState } from 'react';

import { LoaderCircle, Minimize2, X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import type { AgentChatAttachment } from './agent-chat-drafts';
import { agentChatAttachmentLabel } from './agent-chat-drafts';
import { AGENT_CHAT_IMAGE_RESIZED_NOTE } from './agent-chat-images';

/**
 * Reading an image is usually instant; only one that takes longer (a large image being resized) shows a placeholder, so
 * a quick paste does not flash one.
 */
const PENDING_CHIP_DELAY_MS = 300;

function PendingAttachmentChip() {
    const [isVisible, setVisible] = useState(false);
    useEffect(() => {
        const timer = setTimeout(() => setVisible(true), PENDING_CHIP_DELAY_MS);
        return () => clearTimeout(timer);
    }, []);
    if (!isVisible) return null;
    return (
        <li
            aria-label="Preparing image"
            className="flex size-16 items-center justify-center rounded-md border border-border text-muted"
        >
            <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
        </li>
    );
}

/**
 * Images attached to the message being written, each removable before it is sent. Removing one unmounts the button that
 * had focus, so the caller hands focus back to the message input. A resized image says so on hover and in its alt text,
 * since what is sent is not the original file.
 */
export function AgentChatAttachmentList({
    attachments,
    onRemove,
    pendingCount = 0,
}: {
    attachments: readonly AgentChatAttachment[];
    onRemove: (id: string) => void;
    /**
     * Images still being read, shown as placeholders once reading takes noticeably long.
     */
    pendingCount?: number;
}) {
    return (
        <ul
            aria-label="Attached images"
            className="m-0 flex list-none flex-wrap gap-2 px-3 pt-3 pb-0 empty:hidden"
        >
            {attachments.map((attachment, index) => (
                <li className="group/attachment relative" key={attachment.id}>
                    {attachment.isResized ? (
                        <Tooltip content={AGENT_CHAT_IMAGE_RESIZED_NOTE}>
                            <span className="relative block">
                                <img
                                    alt={agentChatAttachmentLabel(attachment, index)}
                                    className="size-16 rounded-md border border-border object-cover"
                                    src={attachment.image.thumbnail}
                                />
                                <span
                                    aria-hidden="true"
                                    className="absolute bottom-1 left-1 flex size-4 items-center justify-center rounded-sm bg-background/85 text-muted"
                                    data-attachment-resized=""
                                >
                                    <Minimize2 className="size-3" />
                                </span>
                            </span>
                        </Tooltip>
                    ) : (
                        <img
                            alt={agentChatAttachmentLabel(attachment, index)}
                            className="size-16 rounded-md border border-border object-cover"
                            src={attachment.image.thumbnail}
                        />
                    )}
                    <Button
                        aria-label={`Remove image ${index + 1}`}
                        className="absolute top-1 right-1 size-5 shadow-sm"
                        size="icon"
                        type="button"
                        variant="secondary"
                        onClick={() => onRemove(attachment.id)}
                    >
                        <X className="size-3" />
                    </Button>
                </li>
            ))}
            {Array.from({ length: pendingCount }, (_, index) => (
                <PendingAttachmentChip key={`pending-${index}`} />
            ))}
        </ul>
    );
}

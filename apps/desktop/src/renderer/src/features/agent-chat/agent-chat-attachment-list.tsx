import { X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import type { AgentChatAttachment } from './agent-chat-drafts';
import { agentChatAttachmentLabel } from './agent-chat-drafts';

/**
 * Images attached to the message being written, each removable before it is sent. Removing one unmounts the button that
 * had focus, so the caller hands focus back to the message input.
 */
export function AgentChatAttachmentList({
    attachments,
    onRemove,
}: {
    attachments: readonly AgentChatAttachment[];
    onRemove: (id: string) => void;
}) {
    return (
        <ul
            aria-label="Attached images"
            className="m-0 flex list-none flex-wrap gap-2 px-3 pt-3 pb-0"
        >
            {attachments.map((attachment, index) => (
                <li className="group/attachment relative" key={attachment.id}>
                    <img
                        alt={agentChatAttachmentLabel(attachment, index)}
                        className="size-16 rounded-md border border-border object-cover"
                        src={attachment.image.thumbnail}
                    />
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
        </ul>
    );
}

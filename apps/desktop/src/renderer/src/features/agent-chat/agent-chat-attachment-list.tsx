import { X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import type { AgentChatAttachment } from './agent-chat-drafts';

/**
 * Images attached to the message being written, each removable before it is sent.
 */
export function AgentChatAttachmentList({
    attachments,
    onRemove,
}: {
    attachments: readonly AgentChatAttachment[];
    onRemove: (id: string) => void;
}) {
    return (
        <ul aria-label="Attached images" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {attachments.map((attachment, index) => (
                <li className="group/attachment relative" key={attachment.id}>
                    <img
                        alt={`Attachment ${index + 1}`}
                        className="size-12 rounded-md border border-border object-cover"
                        src={attachment.image.thumbnail}
                    />
                    <Button
                        aria-label={`Remove image ${index + 1}`}
                        className="absolute -top-1.5 -right-1.5 size-5 rounded-full shadow-sm"
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

import { ImageIcon } from 'lucide-react';

import { cn } from '../../lib/utilities';
import { useAgentChatImageThumbnail } from './hooks/use-agent-chat-image-thumbnail';

/**
 * Images a sent message carried. A resumed conversation knows an image was there but not its preview; when `message`
 * names where the message lives, each such image is read back from the provider's record and previewed, and a
 * placeholder tile holds its place until then, or for good when the record no longer has it.
 */
export function AgentChatMessageImages({
    className,
    images,
    message,
}: {
    className?: string;
    images: ReadonlyArray<{ thumbnail?: string }>;
    message?: { terminalId: string; itemId: string };
}) {
    return (
        <div className={cn('flex flex-wrap justify-end gap-1.5', className)}>
            {images.map((image, index) => (
                <MessageImage
                    index={index}
                    // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- a sent message's images never reorder, so position is their identity.
                    key={index}
                    message={image.thumbnail ? undefined : message}
                    thumbnail={image.thumbnail}
                />
            ))}
        </div>
    );
}

function MessageImage({
    index,
    message,
    thumbnail,
}: {
    index: number;
    message: { terminalId: string; itemId: string } | undefined;
    thumbnail: string | undefined;
}) {
    const restored = useAgentChatImageThumbnail(message && { ...message, index });
    const source = thumbnail ?? restored;
    return source ? (
        <img
            alt={`Attachment ${index + 1}`}
            className="h-24 w-auto max-w-48 min-w-12 rounded-md border border-border object-cover"
            src={source}
        />
    ) : (
        <div
            aria-label={`Attachment ${index + 1}`}
            className="flex size-24 items-center justify-center rounded-md border border-border bg-elevated text-muted"
            role="img"
        >
            <ImageIcon className="size-5" />
        </div>
    );
}

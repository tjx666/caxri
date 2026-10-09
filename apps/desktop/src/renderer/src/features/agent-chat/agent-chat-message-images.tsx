import { ImageIcon } from 'lucide-react';

import { cn } from '../../lib/utilities';

/**
 * Images a sent message carried. A resumed conversation knows an image was there but not its preview, so it shows a
 * placeholder tile instead.
 */
export function AgentChatMessageImages({
    className,
    images,
}: {
    className?: string;
    images: ReadonlyArray<{ thumbnail?: string }>;
}) {
    return (
        <div className={cn('flex flex-wrap justify-end gap-1.5', className)}>
            {images.map((image, index) =>
                image.thumbnail ? (
                    <img
                        alt={`Attachment ${index + 1}`}
                        className="h-24 w-auto max-w-48 min-w-12 rounded-md border border-border object-cover"
                        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- a sent message's images never reorder, so position is their identity.
                        key={index}
                        src={image.thumbnail}
                    />
                ) : (
                    <div
                        aria-label={`Attachment ${index + 1}`}
                        className="flex size-24 items-center justify-center rounded-md border border-border bg-elevated text-muted"
                        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- a sent message's images never reorder, so position is their identity.
                        key={index}
                        role="img"
                    >
                        <ImageIcon className="size-5" />
                    </div>
                ),
            )}
        </div>
    );
}

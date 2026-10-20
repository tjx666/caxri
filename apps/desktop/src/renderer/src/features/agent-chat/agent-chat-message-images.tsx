import { useState } from 'react';

import { ImageIcon } from 'lucide-react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import {
    useAgentChatImageOriginal,
    useAgentChatImageThumbnail,
} from './hooks/use-agent-chat-image-thumbnail';

/**
 * Images a sent message carried. A resumed conversation knows an image was there but not its preview; when `message`
 * names where the message lives, each such image is read back from the provider's record and previewed, and a
 * placeholder tile holds its place until then, or for good when the record no longer has it. Clicking a preview opens
 * it larger, read at full size from the record when it still has it. Each is named Image N by its place, the number the
 * message's `[Image #N]` placeholders use; when the text uses them (`isNumbered`), each tile wears its `#N` too.
 */
export function AgentChatMessageImages({
    className,
    images,
    isNumbered = false,
    message,
}: {
    className?: string;
    images: ReadonlyArray<{ thumbnail?: string }>;
    isNumbered?: boolean;
    message?: { terminalId: string; itemId: string };
}) {
    return (
        <div className={cn('flex flex-wrap justify-end gap-1.5', className)}>
            {images.map((image, index) => (
                <MessageImage
                    index={index}
                    isNumbered={isNumbered}
                    // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- a sent message's images never reorder, so position is their identity.
                    key={index}
                    message={message}
                    thumbnail={image.thumbnail}
                />
            ))}
        </div>
    );
}

const TILE_CLASS_NAME =
    'flex size-24 items-center justify-center rounded-md border border-border bg-elevated text-muted';

function MessageImage({
    index,
    isNumbered,
    message,
    thumbnail,
}: {
    index: number;
    isNumbered: boolean;
    message: { terminalId: string; itemId: string } | undefined;
    thumbnail: string | undefined;
}) {
    const { t } = useTranslation();
    const [isPreviewOpen, setPreviewOpen] = useState(false);
    const record = message && { ...message, index };
    const restored = useAgentChatImageThumbnail(thumbnail ? undefined : record);
    const original = useAgentChatImageOriginal(record, { isEnabled: isPreviewOpen });
    const label = t('agentChat.attachments.imageNumber', { number: index + 1 });
    const source = thumbnail ?? restored.thumbnail;
    if (!source) {
        if (restored.status === 'unavailable') {
            return (
                <Tooltip content={t('agentChat.message.imageUnavailable')}>
                    <div
                        aria-label={t('agentChat.message.imageUnavailableLabel', { label })}
                        className={TILE_CLASS_NAME}
                        role="img"
                    >
                        <ImageIcon className="size-5" />
                    </div>
                </Tooltip>
            );
        }
        return (
            <div
                aria-busy={restored.status === 'loading' || undefined}
                aria-label={label}
                className={cn(
                    TILE_CLASS_NAME,
                    restored.status === 'loading' && 'motion-safe:animate-pulse',
                )}
                role="img"
            >
                <ImageIcon className="size-5" />
            </div>
        );
    }
    return (
        <>
            <button
                aria-label={t('agentChat.message.previewImage', { label })}
                className="relative cursor-zoom-in rounded-md border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                type="button"
                onClick={() => setPreviewOpen(true)}
            >
                <img
                    alt={label}
                    className="h-24 w-auto max-w-48 min-w-12 rounded-md border border-border object-cover"
                    src={source}
                />
                {isNumbered && (
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1 left-1 rounded-sm bg-background/85 px-1 text-[11px] leading-4 font-medium text-foreground tabular-nums"
                    >
                        #{index + 1}
                    </span>
                )}
            </button>
            <Dialog open={isPreviewOpen} onOpenChange={setPreviewOpen}>
                <DialogContent className="w-auto max-w-[calc(100vw-32px)]">
                    <DialogHeader>
                        <DialogTitle>{label}</DialogTitle>
                    </DialogHeader>
                    <div className="flex justify-center p-4">
                        <img
                            alt={label}
                            className="max-h-[calc(100vh-160px)] max-w-full rounded-md object-contain"
                            src={original ?? source}
                        />
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

import { useState } from 'react';

import { ImageIcon } from 'lucide-react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import {
    useAgentChatImageOriginal,
    useAgentChatImageThumbnail,
} from '../hooks/use-agent-chat-image-thumbnail';
import {
    agentChatSentImageOriginal,
    hasAgentChatSentImageOriginal,
} from './agent-chat-sent-image-originals';

/**
 * Images a sent message carried. A resumed conversation knows an image was there but not its preview; when `message`
 * names where the message lives, each such image is read back from the provider's record and previewed, and a
 * placeholder tile holds its place until then, or for good when the record no longer has it. Clicking a preview opens
 * it larger, read at full size from the record when it still has it. Each is named Image N by its place, the number the
 * message's `[Image #N]` placeholders use; when the text uses them (`firstNumber`, see `agentChatFirstImageNumber`),
 * each tile wears its `#N` too. The tiles sit inside the message's bubble, under its text, so they read as part of the
 * message rather than a separate one.
 */
export function AgentChatMessageImages({
    className,
    images,
    firstNumber,
    message,
}: {
    className?: string;
    images: ReadonlyArray<{ thumbnail?: string }>;
    /**
     * The number the first image goes by in the message's placeholders; absent when the text uses none.
     */
    firstNumber?: number;
    message?: { terminalId: string; itemId: string };
}) {
    return (
        <div className={cn('flex flex-wrap gap-1.5', className)}>
            {images.map((image, index) => (
                <MessageImage
                    firstNumber={firstNumber}
                    index={index}
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
    'flex size-24 items-center justify-center rounded-md border border-border bg-background text-muted';

function MessageImage({
    firstNumber,
    index,
    message,
    thumbnail,
}: {
    firstNumber: number | undefined;
    index: number;
    message: { terminalId: string; itemId: string } | undefined;
    thumbnail: string | undefined;
}) {
    const { t } = useTranslation();
    const [isPreviewOpen, setPreviewOpen] = useState(false);
    const record = message && { ...message, index };
    const restored = useAgentChatImageThumbnail(thumbnail ? undefined : record);
    // The data URL is megabytes long, so it is built only while the preview shows it.
    const sent = isPreviewOpen ? agentChatSentImageOriginal(thumbnail) : undefined;
    const original = useAgentChatImageOriginal(record, {
        isEnabled: isPreviewOpen && !hasAgentChatSentImageOriginal(thumbnail),
    });
    const label = t('agentChat.attachments.imageNumber', { number: (firstNumber ?? 1) + index });
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
                        <div className="flex flex-col items-center gap-1 px-1 text-center">
                            <ImageIcon className="size-5" />
                            <span className="text-[11px] leading-4">
                                {t('agentChat.message.imageUnavailable')}
                            </span>
                        </div>
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
                {firstNumber !== undefined && (
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1 left-1 rounded-sm bg-background/85 px-1 text-[11px] leading-4 font-medium text-foreground tabular-nums"
                    >
                        #{firstNumber + index}
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
                            src={sent ?? original ?? source}
                        />
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

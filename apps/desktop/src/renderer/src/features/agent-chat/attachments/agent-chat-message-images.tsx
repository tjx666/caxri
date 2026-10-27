import { useEffect, useId, useState } from 'react';

import { ImageIcon } from 'lucide-react';

import {
    LOADING_SKELETON_DELAY_MS,
    scheduleLoadingSkeletonReveal,
} from '../../../components/loading-skeleton-delay';
import { Skeleton } from '../../../components/ui/skeleton';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { useAgentChatImageThumbnail } from '../hooks/use-agent-chat-image-thumbnail';
import { AgentChatImagePreviewDialog } from './image-preview/agent-chat-image-preview-dialog';

/**
 * Images a sent message carried. A resumed conversation knows an image was there but not its preview; when `message`
 * names where the message lives, each such image is read back from the provider's record and previewed, and a
 * placeholder tile holds its place until then, or for good when the record no longer has it. Clicking a preview opens
 * the message's images larger (`AgentChatImagePreviewDialog`), read at full size from the record when it still has
 * them. Each is named Image N by its place, the number the message's `[Image #N]` placeholders use; when the text uses
 * them (`firstNumber`, see `agentChatFirstImageNumber`), each tile wears its `#N` too. The tiles sit inside the
 * message's bubble, under its text, so they read as part of the message rather than a separate one.
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
    const { t } = useTranslation();
    // The index outlives a close, so the closing preview keeps showing its image while it fades out.
    // `visits` counts every image shown, so each one opens at Fit even when the user steps back to it.
    const [preview, setPreview] = useState({ index: 0, isOpen: false, visits: 0 });
    const viewStateKey = `agent-chat-image-preview:${useId()}:${preview.visits}`;
    const labelFor = (index: number) =>
        t('agentChat.attachments.imageNumber', { number: (firstNumber ?? 1) + index });
    return (
        <div className={cn('flex flex-wrap gap-1.5', className)}>
            {images.map((image, index) => (
                <MessageImage
                    firstNumber={firstNumber}
                    index={index}
                    // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- a sent message's images never reorder, so position is their identity.
                    key={index}
                    label={labelFor(index)}
                    message={message}
                    thumbnail={image.thumbnail}
                    onOpen={() =>
                        setPreview(({ visits }) => ({ index, isOpen: true, visits: visits + 1 }))
                    }
                />
            ))}
            <AgentChatImagePreviewDialog
                count={images.length}
                index={preview.index}
                isOpen={preview.isOpen}
                labelFor={labelFor}
                message={message}
                thumbnails={images.map(({ thumbnail }) => thumbnail)}
                viewStateKey={viewStateKey}
                onIndexChange={(index) =>
                    setPreview((current) =>
                        index === current.index
                            ? current
                            : { ...current, index, visits: current.visits + 1 },
                    )
                }
                onOpenChange={(isOpen) => setPreview((current) => ({ ...current, isOpen }))}
            />
        </div>
    );
}

const TILE_CLASS_NAME =
    'flex size-24 items-center justify-center rounded-md border border-border bg-background text-muted';

/**
 * The tile of an image being read back from the provider's record. Like every loading placeholder it draws its shape
 * only after `LOADING_SKELETON_DELAY_MS` (DESIGN.md), so a quick local read swaps straight to the preview with no
 * flash; the shape then fades in and pulses on the shared skeleton tokens.
 */
function ImageLoadingTile({ label }: { label: string }) {
    const [isRevealed, setRevealed] = useState(false);
    useEffect(
        () =>
            scheduleLoadingSkeletonReveal(
                () => setRevealed(true),
                undefined,
                LOADING_SKELETON_DELAY_MS,
            ),
        [],
    );
    return (
        <div aria-busy="true" aria-label={label} className={TILE_CLASS_NAME} role="img">
            {isRevealed && <Skeleton className="size-full rounded-md" />}
        </div>
    );
}

function MessageImage({
    firstNumber,
    index,
    label,
    message,
    thumbnail,
    onOpen,
}: {
    firstNumber: number | undefined;
    index: number;
    label: string;
    message: { terminalId: string; itemId: string } | undefined;
    thumbnail: string | undefined;
    onOpen: () => void;
}) {
    const { t } = useTranslation();
    const record = message && { ...message, index };
    const restored = useAgentChatImageThumbnail(thumbnail ? undefined : record);
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
        return restored.status === 'loading' ? (
            <ImageLoadingTile label={label} />
        ) : (
            <div aria-label={label} className={TILE_CLASS_NAME} role="img">
                <ImageIcon className="size-5" />
            </div>
        );
    }
    return (
        <button
            aria-label={t('agentChat.message.previewImage', { label })}
            className="relative cursor-zoom-in rounded-md border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-foreground"
            type="button"
            onClick={onOpen}
        >
            <img
                alt={label}
                className="h-24 w-auto max-w-48 min-w-12 rounded-md border border-border object-cover"
                data-agent-chat-message-image=""
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
    );
}

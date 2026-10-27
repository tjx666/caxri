import { useRef } from 'react';

import { ChevronLeft, ChevronRight, ImageIcon } from 'lucide-react';

import { Button } from '../../../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../../components/ui/dialog';
import { Skeleton } from '../../../../components/ui/skeleton';
import { useTranslation } from '../../../../i18n';
import { PreviewZoomView } from '../../../preview/preview-zoom-view';
import {
    useAgentChatImageOriginal,
    useAgentChatImageThumbnail,
} from '../../hooks/use-agent-chat-image-thumbnail';
import {
    agentChatSentImageOriginal,
    hasAgentChatSentImageOriginal,
} from '../agent-chat-sent-image-originals';
import type { AgentChatImageStep } from './agent-chat-image-gallery';
import { agentChatImageStepForKey, stepAgentChatImageIndex } from './agent-chat-image-gallery';

/**
 * The larger preview of one message's images. It zooms and pans like the file preview (`PreviewZoomView`), and with
 * more than one image it counts them and steps between them with its buttons or Left and Right, stopping at either end.
 * Each image opens at Fit, so one image's zoom never carries over to the next.
 */
export function AgentChatImagePreviewDialog({
    count,
    index,
    isOpen,
    labelFor,
    message,
    thumbnails,
    viewStateKey,
    onIndexChange,
    onOpenChange,
}: {
    count: number;
    index: number;
    isOpen: boolean;
    labelFor: (index: number) => string;
    message: { terminalId: string; itemId: string } | undefined;
    thumbnails: ReadonlyArray<string | undefined>;
    /**
     * Unique to each visit of an image, so a reopened or revisited image starts at Fit: the zoom view remembers a zoom
     * per key.
     */
    viewStateKey: string;
    onIndexChange: (index: number) => void;
    onOpenChange: (isOpen: boolean) => void;
}) {
    const { t } = useTranslation();
    const popup = useRef<HTMLDivElement>(null);
    const hasGallery = count > 1;
    const step = (direction: AgentChatImageStep) =>
        onIndexChange(stepAgentChatImageIndex(index, count, direction));
    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent
                ref={popup}
                // The popup itself, not the first button: the picture is what the user opened, and a focus ring on
                // Previous would read as a selection. The arrow keys still reach the handler below.
                initialFocus={popup}
                className="flex h-[min(800px,calc(100vh-64px))] max-h-none w-[min(1100px,calc(100vw-64px))] flex-col overflow-hidden"
                onKeyDown={(event) => {
                    const focused = event.target;
                    // React bubbles events through portals, so the zoom menu's own arrow keys arrive here too.
                    if (
                        !hasGallery ||
                        !(focused instanceof Node) ||
                        !event.currentTarget.contains(focused)
                    )
                        return;
                    const direction = agentChatImageStepForKey(event.key, {
                        canScrollSideways:
                            focused instanceof HTMLElement &&
                            focused.scrollWidth > focused.clientWidth,
                    });
                    if (!direction) return;
                    event.preventDefault();
                    step(direction);
                }}
            >
                {/* Its height centers the controls on the close button's row. */}
                <DialogHeader className="flex min-h-11 items-center gap-2 py-2">
                    <DialogTitle className="min-w-0 flex-1 truncate">{labelFor(index)}</DialogTitle>
                    {hasGallery && (
                        <div className="flex shrink-0 items-center gap-1">
                            {/* `aria-disabled` rather than `disabled`, so the button keeps focus at either end. */}
                            <Button
                                aria-disabled={index === 0 || undefined}
                                aria-label={t('agentChat.message.previousImage')}
                                size="icon"
                                variant="ghost"
                                onClick={() => step('previous')}
                            >
                                <ChevronLeft aria-hidden="true" className="size-4" />
                            </Button>
                            <span className="min-w-10 text-center text-[12px] text-muted tabular-nums">
                                {t('agentChat.message.imagePosition', {
                                    position: index + 1,
                                    count,
                                })}
                            </span>
                            <Button
                                aria-disabled={index === count - 1 || undefined}
                                aria-label={t('agentChat.message.nextImage')}
                                size="icon"
                                variant="ghost"
                                onClick={() => step('next')}
                            >
                                <ChevronRight aria-hidden="true" className="size-4" />
                            </Button>
                        </div>
                    )}
                </DialogHeader>
                <PreviewImage
                    // A new image mounts a fresh zoom view, which opens it at Fit.
                    key={index}
                    index={index}
                    label={labelFor(index)}
                    message={message}
                    thumbnail={thumbnails[index]}
                    viewStateKey={viewStateKey}
                />
            </DialogContent>
        </Dialog>
    );
}

function PreviewImage({
    index,
    label,
    message,
    thumbnail,
    viewStateKey,
}: {
    index: number;
    label: string;
    message: { terminalId: string; itemId: string } | undefined;
    thumbnail: string | undefined;
    viewStateKey: string;
}) {
    const { t } = useTranslation();
    const record = message && { ...message, index };
    const restored = useAgentChatImageThumbnail(thumbnail ? undefined : record);
    // The data URL is megabytes long, so it is built only while the preview shows it.
    const sent = agentChatSentImageOriginal(thumbnail);
    const original = useAgentChatImageOriginal(record, {
        isEnabled: !hasAgentChatSentImageOriginal(thumbnail),
    });
    const source = sent ?? original ?? thumbnail ?? restored.thumbnail;
    if (!source)
        return (
            <div className="flex min-h-0 flex-1 items-center justify-center bg-background p-6 text-muted">
                {restored.status === 'unavailable' ? (
                    <div aria-label={label} className="flex flex-col items-center gap-2" role="img">
                        <ImageIcon aria-hidden="true" className="size-6" />
                        <span className="text-[12px]">
                            {t('agentChat.message.imageUnavailable')}
                        </span>
                    </div>
                ) : (
                    <Skeleton
                        aria-label={label}
                        className="h-full max-h-80 w-full max-w-120"
                        role="img"
                    />
                )}
            </div>
        );
    return (
        <PreviewZoomView className="bg-background" viewStateKey={viewStateKey}>
            {/* Natural size: the zoom view scales it. Not draggable, so a drag pans instead of lifting the image. */}
            <img
                alt={label}
                className="caxri-image-preview-canvas block max-w-none"
                draggable={false}
                src={source}
            />
        </PreviewZoomView>
    );
}

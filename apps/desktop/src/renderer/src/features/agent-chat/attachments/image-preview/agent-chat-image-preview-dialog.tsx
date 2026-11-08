import { useRef } from 'react';

import { ChevronLeft, ChevronRight, Copy, ImageIcon } from 'lucide-react';

import { Button } from '../../../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../../components/ui/dialog';
import { Skeleton } from '../../../../components/ui/skeleton';
import { Tooltip } from '../../../../components/ui/tooltip';
import { useContextMenu } from '../../../../hooks/use-context-menu';
import { translate, useTranslation } from '../../../../i18n';
import { writeClipboardImage } from '../../../../lib/clipboard';
import { pushToast, tryCommand } from '../../../../stores/toasts';
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
import {
    agentChatImageStepForKey,
    isAgentChatImageCopyKey,
    stepAgentChatImageIndex,
} from './agent-chat-image-gallery';

/**
 * The larger preview of one message's images. It zooms and pans like the file preview (`PreviewZoomView`), and with
 * more than one image it counts them and steps between them with its buttons or Left and Right, stopping at either end.
 * Each image opens at Fit, so one image's zoom never carries over to the next. The header's Copy button and Cmd+C (with
 * no text selected) copy the shown image, as the right-click menu on the zoom canvas does.
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
    const picture = usePreviewSource(index, message, thumbnails[index]);
    const copy = () => {
        if (picture.source) copyImageFromMenu(picture.source);
    };
    const step = (direction: AgentChatImageStep) =>
        onIndexChange(stepAgentChatImageIndex(index, count, direction));
    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent
                ref={popup}
                // The popup itself, not the first button: the picture is what the user opened, and a focus ring on
                // Previous would read as a selection. The arrow keys still reach the handler below.
                initialFocus={popup}
                // React bubbles events through portals, so without this a right-click anywhere in the preview opened
                // the menu of the message the preview came from. The image claims its own menu below.
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                }}
                className="flex h-[min(800px,calc(100vh-64px))] max-h-none w-[min(1100px,calc(100vw-64px))] flex-col overflow-hidden"
                onKeyDown={(event) => {
                    const focused = event.target;
                    if (
                        picture.source &&
                        isAgentChatImageCopyKey(event, {
                            hasSelection: (getSelection()?.toString() ?? '') !== '',
                        })
                    ) {
                        event.preventDefault();
                        copy();
                        return;
                    }
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
                    {picture.source && (
                        <Tooltip content={t('agentChat.message.copyImage')} shortcut="cmd+c">
                            <Button
                                aria-label={t('agentChat.message.copyImage')}
                                size="icon"
                                variant="ghost"
                                onClick={copy}
                            >
                                <Copy aria-hidden="true" className="size-4" />
                            </Button>
                        </Tooltip>
                    )}
                </DialogHeader>
                <PreviewImage
                    // A new image mounts a fresh zoom view, which opens it at Fit.
                    key={index}
                    label={labelFor(index)}
                    picture={picture}
                    viewStateKey={viewStateKey}
                />
            </DialogContent>
        </Dialog>
    );
}

/**
 * The image shown for `index`: the sent original, else the one read from the provider's record, else the thumbnail.
 * Lives in the dialog so the header's Copy button reads the same source the canvas shows.
 */
function usePreviewSource(
    index: number,
    message: { terminalId: string; itemId: string } | undefined,
    thumbnail: string | undefined,
): { source: string | undefined; status: 'idle' | 'loading' | 'ready' | 'unavailable' } {
    const record = message && { ...message, index };
    const restored = useAgentChatImageThumbnail(thumbnail ? undefined : record);
    // The data URL is megabytes long, so it is built only while the preview shows it.
    const sent = agentChatSentImageOriginal(thumbnail);
    const original = useAgentChatImageOriginal(record, {
        isEnabled: !hasAgentChatSentImageOriginal(thumbnail),
    });
    return {
        source: sent ?? original ?? thumbnail ?? restored.thumbnail,
        status: restored.status,
    };
}

function PreviewImage({
    label,
    picture: { source, status },
    viewStateKey,
}: {
    label: string;
    picture: ReturnType<typeof usePreviewSource>;
    viewStateKey: string;
}) {
    const { t } = useTranslation();
    const onContextMenu = useContextMenu(() =>
        source
            ? [
                  {
                      label: translate('agentChat.message.copyImage'),
                      onSelect: () => copyImageFromMenu(source),
                  },
              ]
            : [],
    );
    if (!source)
        return (
            <div className="flex min-h-0 flex-1 items-center justify-center bg-background p-6 text-muted">
                {status === 'unavailable' ? (
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
        // The whole canvas claims the menu, not only the picture, so a right-click on the margin around it copies too.
        <div className="flex min-h-0 flex-1 flex-col" onContextMenu={onContextMenu}>
            <PreviewZoomView className="bg-background" viewStateKey={viewStateKey}>
                {/* Natural size: the zoom view scales it. Not draggable, so a drag pans instead of lifting the image. */}
                <img
                    alt={label}
                    className="caxri-image-preview-canvas block max-w-none"
                    draggable={false}
                    src={source}
                />
            </PreviewZoomView>
        </div>
    );
}

/**
 * Copies the image at the size the preview shows it (the original once read, else the thumbnail), with a toast
 * confirming it, since a native menu entry has no check mark to turn into.
 */
function copyImageFromMenu(source: string): void {
    void tryCommand(translate('agentChat.message.imageCopyFailed'), async () => {
        await writeClipboardImage(source);
        pushToast('success', translate('agentChat.message.imageCopied'));
    });
}

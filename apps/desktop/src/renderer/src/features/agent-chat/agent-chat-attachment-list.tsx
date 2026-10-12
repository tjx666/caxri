import { useEffect, useState } from 'react';

import { Minimize2, X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import type { AgentChatAttachment } from './agent-chat-drafts';
import { agentChatAttachmentLabel, agentChatAttachmentName } from './agent-chat-drafts';
import { agentChatImageResizedNote } from './agent-chat-images';

/**
 * Reading an image is usually instant; only one that takes longer (a large image being resized) shows a placeholder, so
 * a quick paste does not flash one.
 */
const PENDING_CHIP_DELAY_MS = 300;

function PendingAttachmentChip() {
    const { t } = useTranslation();
    const [isVisible, setVisible] = useState(false);
    useEffect(() => {
        const timer = setTimeout(() => setVisible(true), PENDING_CHIP_DELAY_MS);
        return () => clearTimeout(timer);
    }, []);
    if (!isVisible) return null;
    return (
        <li
            aria-label={t('agentChat.attachments.preparing')}
            className="flex size-16 items-center justify-center rounded-md border border-border text-muted"
        >
            <Spinner aria-hidden="true" role="presentation" />
        </li>
    );
}

/**
 * One attached image's 64px thumbnail with a transparent Preview button over it. The button is a sibling of the image
 * rather than its wrapper, so the image keeps its own accessible node (a button's children are presentational). A
 * resized image wears a corner badge and a tooltip saying so.
 */
function AttachmentThumbnail({
    attachment,
    index,
    onPreview,
}: {
    attachment: AgentChatAttachment;
    index: number;
    onPreview: () => void;
}) {
    const { t } = useTranslation();
    const label = agentChatAttachmentLabel(attachment, index);
    const thumbnail = (
        <span className="relative block">
            <img
                alt={label}
                className="block size-16 rounded-md border border-border object-cover"
                src={attachment.image.thumbnail}
            />
            {attachment.isResized && (
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute bottom-1 left-1 z-10 flex size-4 items-center justify-center rounded-sm bg-background/85 text-muted"
                    data-attachment-resized=""
                >
                    <Minimize2 className="size-3" />
                </span>
            )}
            <button
                aria-label={t('agentChat.attachments.preview', { name: label })}
                className="absolute inset-0 cursor-zoom-in rounded-md border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={onPreview}
            />
        </span>
    );
    return attachment.isResized ? (
        <Tooltip content={agentChatImageResizedNote()}>{thumbnail}</Tooltip>
    ) : (
        thumbnail
    );
}

/**
 * Images attached to the message being written, each removable before it is sent. Removing one unmounts the button that
 * had focus, so the caller hands focus back to the message input. Remove names the image the way its preview does, by
 * file name (`agentChatAttachmentName`). A resized image says so on hover and in its alt text, since what is sent is
 * not the original file. Clicking a thumbnail opens the full image in a dialog, since the 64px chip is too small to
 * check a screenshot before sending it.
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
    const { t } = useTranslation();
    const [previewId, setPreviewId] = useState<string>();
    const previewIndex = attachments.findIndex((attachment) => attachment.id === previewId);
    const preview = previewIndex === -1 ? undefined : attachments[previewIndex];
    return (
        <>
            <ul
                aria-label={t('agentChat.attachments.label')}
                className="m-0 flex list-none flex-wrap gap-2 px-3 pt-3 pb-0 empty:hidden"
            >
                {attachments.map((attachment, index) => (
                    <li className="group/attachment relative" key={attachment.id}>
                        <AttachmentThumbnail
                            attachment={attachment}
                            index={index}
                            onPreview={() => setPreviewId(attachment.id)}
                        />
                        <Button
                            aria-label={t('agentChat.attachments.remove', {
                                name: agentChatAttachmentName(attachment, index),
                            })}
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
            <Dialog
                open={preview !== undefined}
                onOpenChange={(isOpen) => {
                    if (!isOpen) setPreviewId(undefined);
                }}
            >
                <DialogContent className="w-auto max-w-[min(960px,calc(100vw-32px))] p-3">
                    {preview && (
                        <>
                            <DialogTitle className="mb-2 truncate pr-8 text-[13px] font-normal text-muted">
                                {agentChatAttachmentLabel(preview, previewIndex)}
                            </DialogTitle>
                            <img
                                alt={agentChatAttachmentLabel(preview, previewIndex)}
                                className="block max-h-[calc(100vh-120px)] max-w-full rounded-md object-contain"
                                src={`data:${preview.image.mediaType};base64,${preview.image.data}`}
                            />
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}

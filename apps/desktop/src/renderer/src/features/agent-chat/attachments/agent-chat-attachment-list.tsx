import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { agentChatPathReferenceName } from '@caxri/protocol';
import { Minimize2 } from 'lucide-react';
import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react';
import * as m from 'motion/react-m';

import { Dialog, DialogContent, DialogTitle } from '../../../components/ui/dialog';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { useContentHeightTransition } from '../../../hooks/use-content-height-transition';
import { useShouldReduceMotion } from '../../../hooks/use-should-reduce-motion';
import { useTranslation } from '../../../i18n';
import { motionDurationMs, motionEasing } from '../../../lib/motion';
import { cn } from '../../../lib/utilities';
import type {
    AgentChatAttachment,
    AgentChatImageAttachment,
} from '../composer-input/agent-chat-drafts';
import {
    isAgentChatImageAttachment,
    isAgentChatSkillAttachment,
} from '../composer-input/agent-chat-drafts';
import { AgentChatSkillCard } from '../tools/agent-chat-skill-card';
import {
    agentChatAttachmentLabel,
    agentChatAttachmentName,
    agentChatImageResizedNote,
} from './agent-chat-images';
import {
    AgentChatAttachmentRemoveButton,
    AgentChatPathAttachmentCard,
} from './agent-chat-path-attachment-card';

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
            className="flex size-28 items-center justify-center rounded-lg border border-border text-muted"
        >
            <Spinner aria-hidden="true" role="presentation" />
        </li>
    );
}

/**
 * One attached image's 112px thumbnail with a transparent Preview button over it. The button is a sibling of the image
 * rather than its wrapper, so the image keeps its own accessible node (a button's children are presentational). A
 * resized image wears a corner badge and a tooltip saying so.
 */
function AttachmentThumbnail({
    attachment,
    index,
    onPreview,
}: {
    attachment: AgentChatImageAttachment;
    index: number;
    onPreview: () => void;
}) {
    const { t } = useTranslation();
    const label = agentChatAttachmentLabel(attachment, index);
    const thumbnail = (
        <span className="relative block">
            <img
                alt={label}
                className="block size-28 rounded-lg border border-border object-cover"
                data-agent-chat-composer-image={attachment.id}
                src={attachment.image.thumbnail}
            />
            {attachment.token !== undefined && (
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1 left-1 z-10 rounded-sm bg-background/85 px-1 text-[11px] leading-4 font-medium text-foreground tabular-nums"
                    data-attachment-token={attachment.token}
                >
                    #{attachment.token}
                </span>
            )}
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
                className="absolute inset-0 cursor-zoom-in rounded-lg border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-accent"
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
 * The gap between attachments (`gap-2.5`), which a leaving attachment gives back as its width collapses.
 */
const ATTACHMENT_GAP_PX = 10;

/**
 * One attachment's list item: it fades in from slightly smaller when attached, and when removed fades out while its
 * width and trailing gap collapse, so the attachments after it slide into its place instead of jumping. Attachments
 * already present when the composer mounts (a restored draft) appear without motion (`AnimatePresence initial`).
 */
function AttachmentItem({ children, className }: { children: ReactNode; className?: string }) {
    const isReducedMotion = useShouldReduceMotion();
    const timing = useMemo(
        () => ({
            enter: motionDurationMs('--motion-overlay-enter') / 1000,
            enterEase: motionEasing('--motion-ease-enter'),
            exit: motionDurationMs('--motion-collapse') / 1000,
            exitEase: motionEasing('--motion-ease-exit'),
        }),
        [],
    );
    return (
        // react-doctor-disable-next-line react-doctor/no-layout-property-animation -- a removed attachment gives back its width so the ones after it slide over; a transform would leave its space and then jump.
        <m.li
            animate={{
                opacity: 1,
                scale: 1,
                transition: {
                    duration: isReducedMotion ? 0 : timing.enter,
                    ease: timing.enterEase,
                },
            }}
            className={className}
            exit={{
                marginRight: -ATTACHMENT_GAP_PX,
                opacity: 0,
                // Set at once, not animated: the leaving item takes no clicks and its content does not spill over the
                // attachments sliding into its place.
                overflow: 'hidden',
                pointerEvents: 'none',
                scale: 0.92,
                transition: { duration: isReducedMotion ? 0 : timing.exit, ease: timing.exitEase },
                width: 0,
            }}
            initial={{ opacity: 0, scale: 0.92 }}
        >
            {children}
        </m.li>
    );
}

/**
 * Images, files, folders, and skills attached to the message being written, each removable before it is sent, laid out
 * as the Codex app does: large image thumbnails and file or folder cards, bottom-aligned above the input. Removing one
 * unmounts the button that had focus, so the caller hands focus back to the message input. Remove names the image the
 * way its preview does, by file name (`agentChatAttachmentName`). A resized image says so on hover and in its alt text,
 * since what is sent is not the original file. Clicking a thumbnail opens the full image in a dialog, since the
 * thumbnail crops a screenshot. An image without a name is named by its position among the images. An image written
 * into the text wears its placeholder's `#N`, as in Orca, so the pill in the text and its thumbnail read as one; a
 * pill's click opens the same preview (`preview`). The row stays mounted while empty so its height can grow from zero
 * when the first attachment arrives and shrink back when the last one leaves.
 */
export function AgentChatAttachmentList({
    attachments,
    isGoalMode = false,
    onRemove,
    pendingCount = 0,
    preview: { id: previewId, onChange: onPreviewChange },
}: {
    attachments: readonly AgentChatAttachment[];
    /**
     * Goal mode sets text only, so the attachments are dimmed and a hint says they stay for the next message.
     */
    isGoalMode?: boolean;
    onRemove: (id: string) => void;
    /**
     * Images still being read, shown as placeholders once reading takes noticeably long.
     */
    pendingCount?: number;
    /**
     * The image whose preview is open, and how to open or close one.
     */
    preview: { id: string | undefined; onChange: (id: string | undefined) => void };
}) {
    const { t } = useTranslation();
    const images = attachments.filter(isAgentChatImageAttachment);
    const previewIndex = images.findIndex((attachment) => attachment.id === previewId);
    const preview = previewIndex === -1 ? undefined : images[previewIndex];
    const [outerReference, innerReference] = useContentHeightTransition<
        HTMLDivElement,
        HTMLDivElement
    >();
    return (
        <>
            <div
                className="overflow-hidden transition-[height] motion-reduce:transition-none"
                ref={outerReference}
            >
                <div ref={innerReference}>
                    <ul
                        aria-label={t('agentChat.attachments.label')}
                        className={cn(
                            'm-0 flex list-none flex-wrap items-end gap-2.5 px-3 pt-3 pb-0 empty:hidden',
                            isGoalMode && 'opacity-50',
                        )}
                    >
                        <LazyMotion strict features={domAnimation}>
                            <AnimatePresence initial={false}>
                                {attachments.map((attachment) => {
                                    if (isAgentChatSkillAttachment(attachment))
                                        return (
                                            <AttachmentItem key={attachment.id}>
                                                <AgentChatSkillCard
                                                    name={attachment.skill}
                                                    onRemove={() => onRemove(attachment.id)}
                                                />
                                            </AttachmentItem>
                                        );
                                    if (!isAgentChatImageAttachment(attachment))
                                        return (
                                            <AttachmentItem key={attachment.id}>
                                                <AgentChatPathAttachmentCard
                                                    reference={attachment}
                                                    removeLabel={t('agentChat.attachments.remove', {
                                                        name: agentChatPathReferenceName(
                                                            attachment,
                                                        ),
                                                    })}
                                                    onRemove={() => onRemove(attachment.id)}
                                                />
                                            </AttachmentItem>
                                        );
                                    const index = images.indexOf(attachment);
                                    return (
                                        <AttachmentItem
                                            className="group/attachment relative"
                                            key={attachment.id}
                                        >
                                            <AttachmentThumbnail
                                                attachment={attachment}
                                                index={index}
                                                onPreview={() => onPreviewChange(attachment.id)}
                                            />
                                            <AgentChatAttachmentRemoveButton
                                                className="top-1.5 right-1.5"
                                                label={t('agentChat.attachments.remove', {
                                                    name: agentChatAttachmentName(
                                                        attachment,
                                                        index,
                                                    ),
                                                })}
                                                onRemove={() => onRemove(attachment.id)}
                                            />
                                        </AttachmentItem>
                                    );
                                })}
                            </AnimatePresence>
                        </LazyMotion>
                        {Array.from({ length: pendingCount }, (_, index) => (
                            <PendingAttachmentChip key={`pending-${index}`} />
                        ))}
                    </ul>
                    {isGoalMode && attachments.length > 0 && (
                        <p className="m-0 px-3 pt-2 text-xs text-muted">
                            {t('agentChat.attachments.goalTextOnly')}
                        </p>
                    )}
                </div>
            </div>
            <Dialog
                open={preview !== undefined}
                onOpenChange={(isOpen) => {
                    if (!isOpen) onPreviewChange(undefined);
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

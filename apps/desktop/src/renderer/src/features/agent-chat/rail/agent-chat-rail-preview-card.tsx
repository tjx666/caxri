import type { LucideIcon } from 'lucide-react';
import { CornerDownRight, Forward, ImageIcon, MessageSquare } from 'lucide-react';

import { useClockTick } from '@/hooks/use-clock-tick';

import { HoverCard, HoverCardContent } from '../../../components/ui/hover-card';
import { Skeleton } from '../../../components/ui/skeleton';
import type { Translate } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { localeDateTimeFormat } from '../../../lib/locale-format';
import { cn } from '../../../lib/utilities';
import type { AgentChatRailMark, AgentChatRailMarkKind } from './agent-chat-rail-marks';
import {
    agentChatRailCaption,
    agentChatRailCardText,
    agentChatRailTimeFormatOptions,
} from './agent-chat-rail-marks';

const KIND_ICON: Record<AgentChatRailMarkKind, LucideIcon> = {
    delegated: Forward,
    images: ImageIcon,
    message: MessageSquare,
    steered: CornerDownRight,
};

function kindLabel(kind: AgentChatRailMarkKind, t: Translate): string {
    switch (kind) {
        case 'delegated': {
            return t('agentChat.delegated.task');
        }
        case 'images': {
            return t('agentChat.rail.image');
        }
        case 'message': {
            return t('agentChat.rail.kindMessage');
        }
        case 'steered': {
            return t('agentChat.message.steered');
        }
    }
}

/**
 * The card's one geometry, shared by the skeleton and the content: a title row over a body exactly three lines tall, so
 * swapping one for the other never resizes or moves the card, and a short message leaves its body empty rather than
 * shrinking the card (it shows the message's position and time instead).
 */
const CARD_CLASS = 'flex w-72 max-w-full flex-col gap-1.5 px-3 py-2.5';

const BODY_CLASS = 'h-15 overflow-hidden';

function PreviewSkeleton({ label }: { label: string }) {
    return (
        <div aria-busy="true" aria-label={label} className={CARD_CLASS} role="status">
            <div className="flex h-5 items-center">
                <Skeleton className="h-3 w-2/5" />
            </div>
            <div className={cn(BODY_CLASS, 'flex flex-col')}>
                <div className="flex h-5 items-center">
                    <Skeleton className="h-2.5 w-full" />
                </div>
                <div className="flex h-5 items-center">
                    <Skeleton className="h-2.5 w-11/12" />
                </div>
                <div className="flex h-5 items-center">
                    <Skeleton className="h-2.5 w-3/5" />
                </div>
            </div>
        </div>
    );
}

function PreviewContent({
    loadedCount,
    mark,
    position,
    total,
}: {
    mark: AgentChatRailMark;
    position: number;
    total: number | undefined;
    loadedCount: number;
}) {
    const { t } = useTranslation();
    const Icon = KIND_ICON[mark.kind];
    const now = useClockTick('minute');
    const time =
        mark.createdAt === undefined
            ? undefined
            : localeDateTimeFormat(
                  agentChatRailTimeFormatOptions(mark.createdAt, now),
                  t.locale,
              ).format(mark.createdAt);
    const text = agentChatRailCardText(
        mark,
        agentChatRailCaption(position, total, loadedCount, time, t),
    );
    return (
        <div className={CARD_CLASS} data-agent-chat-rail-preview={mark.id}>
            <div className="flex h-5 min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{text.title}</span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted">
                    <Icon aria-hidden="true" className="size-3" />
                    {kindLabel(mark.kind, t)}
                </span>
            </div>
            <p
                className={cn(
                    BODY_CLASS,
                    'm-0 text-[12px] leading-5 wrap-anywhere whitespace-pre-line text-muted',
                    text.isBodyCaption ? 'truncate' : 'line-clamp-3',
                )}
            >
                {text.body}
            </p>
        </div>
    );
}

/**
 * The message rail's one preview card, modeled on the Codex app's conversation rail: beside the tick it previews, a
 * fixed-size card with the message's title, up to three lines of what follows, and a badge naming what kind of message
 * it is. While a message has no content to show yet the card holds a skeleton of the same geometry, so content swaps in
 * without the card moving or resizing. There is only ever one card, and it only renders the mark it is opened for, so
 * sweeping the rail never shows the text of a tick already passed. The card is not interactive (the tick is the jump
 * target) and ignores the pointer, so it never stands in the pointer's way along the rail.
 */
export function AgentChatRailPreviewCard({
    anchor,
    isOpen,
    loadedCount,
    mark,
    onDismiss,
    position,
    total,
}: {
    anchor: HTMLElement | null;
    isOpen: boolean;
    /**
     * The mark to preview, kept after the card starts closing so the exit fades its content rather than an empty frame.
     */
    mark: AgentChatRailMark | undefined;
    onDismiss: () => void;
    /**
     * The 1-based place of `mark` among the loaded messages.
     */
    position: number;
    /**
     * How many messages the whole conversation has, or `undefined` while earlier history is still unloaded.
     */
    total: number | undefined;
    /**
     * How many messages are loaded, which is what `position` counts within.
     */
    loadedCount: number;
}) {
    const { t } = useTranslation();
    return (
        <HoverCard
            open={isOpen && mark !== undefined && anchor !== null}
            onOpenChange={(open) => {
                if (!open) onDismiss();
            }}
        >
            <HoverCardContent
                anchor={anchor}
                align="center"
                className="pointer-events-none p-0"
                collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}
                collisionPadding={8}
                side="right"
                sideOffset={4}
            >
                {mark &&
                    (mark.isReady ? (
                        <PreviewContent
                            loadedCount={loadedCount}
                            mark={mark}
                            position={position}
                            total={total}
                        />
                    ) : (
                        <PreviewSkeleton label={t('agentChat.rail.loadingPreview')} />
                    ))}
            </HoverCardContent>
        </HoverCard>
    );
}

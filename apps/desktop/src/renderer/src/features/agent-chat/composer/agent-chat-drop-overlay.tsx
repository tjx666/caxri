import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import type { AgentChatSessionDropRefusal } from '../composer-input/chips/agent-chat-session-drop';

/**
 * The whole-Chat drop tint with its one-line caption, shown while a drag is over the Chat. The pane's section is the
 * positioned ancestor (the composer wrapper is not), so the tint covers the transcript too, matching where a drop is
 * accepted. It never takes pointer events, so the drag keeps reaching the section's handlers.
 */
export function AgentChatDropOverlay({
    isDragOver,
    isSessionDrag,
    refusal,
    supportsImages,
}: {
    isDragOver: boolean;
    /**
     * The drag is a Session row, which the drop cites rather than adds as a file.
     */
    isSessionDrag: boolean;
    /**
     * The drag is a Session row this Chat refuses; the overlay says why in a muted caption with no accent tint.
     */
    refusal: AgentChatSessionDropRefusal | undefined;
    supportsImages: boolean;
}) {
    const { t } = useTranslation();
    if (!isDragOver && !refusal) return null;
    return (
        <div
            className={cn(
                'motion-safe:animate-in motion-safe:fade-in-0 pointer-events-none absolute inset-0 z-20 flex items-center justify-center duration-(--motion-overlay-enter) ease-(--motion-ease-enter)',
                refusal ? 'bg-foreground/5' : 'bg-accent/10',
            )}
        >
            <span
                className={cn(
                    'rounded-md bg-elevated px-3 py-1.5 text-[12px] shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)]',
                    refusal ? 'text-muted' : 'text-foreground',
                )}
            >
                {t(
                    refusal === 'self'
                        ? 'agentChat.attachments.dropRefusedSelf'
                        : refusal === 'unavailable'
                          ? 'agentChat.attachments.dropRefusedUnavailable'
                          : isSessionDrag
                            ? 'agentChat.attachments.dropSession'
                            : supportsImages
                              ? 'agentChat.attachments.dropImagesOrPaths'
                              : 'agentChat.attachments.dropPaths',
                )}
            </span>
        </div>
    );
}

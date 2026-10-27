import { ArrowUp, X } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import type { AgentChatReturnHintData } from '../hooks/use-agent-chat-return-hint';

/**
 * A quiet pill at the bottom of the transcript telling a returning user how many Agent replies finished while they were
 * away, with a jump to the first of them. It takes Jump to latest's slot near the composer, where the pointer already
 * is, and shows only while that button is hidden (`isAgentChatReturnHintShown`), the way Telegram's unread jump shares
 * the corner with its scroll-down button. It leaves with the Session, a jump, or its close button.
 *
 * It reads as short as the round Jump to latest beside it: an up arrow and the count (`2 new replies`), with what the
 * jump lands on left to the tooltip, since the arrow already says the pill moves the view.
 */
export function AgentChatReturnHint({
    hint,
    onDismiss,
    onJump,
}: {
    hint: AgentChatReturnHintData;
    onDismiss: () => void;
    onJump: (turnId: string) => void;
}) {
    const { t } = useTranslation();
    const { anchorTurnId, count } = hint;
    const label = t(
        count === 1 ? 'agentChat.returnHint.turnsOne' : 'agentChat.returnHint.turnsOther',
        { count },
    );
    return (
        <div
            className={cn(
                'absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border bg-elevated pr-0.5 text-xs text-foreground shadow-[0_8px_24px_var(--shadow)]',
                anchorTurnId === undefined ? 'pl-3' : 'pl-0.5',
                // Fades and rises in on the overlay tokens like Jump to latest. The pane unmounts the hint, so only the
                // enter can animate here.
                'transition-[opacity,translate] duration-(--motion-overlay-enter) ease-(--motion-ease-enter) motion-safe:starting:translate-y-1 motion-safe:starting:opacity-0',
            )}
            role="status"
        >
            {anchorTurnId === undefined ? (
                <span className="tabular-nums">{label}</span>
            ) : (
                <Tooltip
                    content={t(
                        count === 1
                            ? 'agentChat.returnHint.jumpOne'
                            : 'agentChat.returnHint.jumpOther',
                    )}
                    side="top"
                >
                    <Button
                        className="gap-1 rounded-full pl-2.5 text-xs"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            onJump(anchorTurnId);
                            onDismiss();
                        }}
                    >
                        <ArrowUp aria-hidden="true" className="size-3.5" />
                        <span className="tabular-nums">{label}</span>
                    </Button>
                </Tooltip>
            )}
            <Tooltip content={t('agentChat.returnHint.dismiss')}>
                <Button
                    aria-label={t('agentChat.returnHint.dismiss')}
                    size="icon"
                    variant="ghost"
                    onClick={onDismiss}
                >
                    <X aria-hidden="true" className="size-3.5" />
                </Button>
            </Tooltip>
        </div>
    );
}

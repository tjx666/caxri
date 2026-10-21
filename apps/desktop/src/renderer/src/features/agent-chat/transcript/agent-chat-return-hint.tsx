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
 */
export function AgentChatReturnHint({
    hint,
    onDismiss,
    onJump,
}: {
    hint: AgentChatReturnHintData;
    onDismiss: () => void;
    onJump: (anchorId: string) => void;
}) {
    const { t } = useTranslation();
    const { anchorId, count } = hint;
    const label = t(
        count === 1 ? 'agentChat.returnHint.turnsOne' : 'agentChat.returnHint.turnsOther',
        { count },
    );
    return (
        <div
            className={cn(
                'absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border bg-elevated pr-0.5 text-xs text-foreground shadow-[0_8px_24px_var(--shadow)]',
                anchorId === undefined ? 'pl-3' : 'pl-0.5',
                // Fades and rises in on the overlay tokens like Jump to latest. The pane unmounts the hint, so only the
                // enter can animate here.
                'transition-[opacity,translate] duration-(--motion-overlay-enter) ease-(--motion-ease-enter) motion-safe:starting:translate-y-1 motion-safe:starting:opacity-0',
            )}
            role="status"
        >
            {anchorId === undefined ? (
                <span className="tabular-nums">{label}</span>
            ) : (
                // The whole message is the jump target, not only its trailing words; only Dismiss stays apart.
                <Button
                    className="rounded-full pl-2.5 text-xs"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                        onJump(anchorId);
                        onDismiss();
                    }}
                >
                    <span className="mr-1 tabular-nums">{label}</span>
                    <ArrowUp aria-hidden="true" className="size-3.5" />
                    {t(
                        count === 1
                            ? 'agentChat.returnHint.jumpOne'
                            : 'agentChat.returnHint.jumpOther',
                    )}
                </Button>
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

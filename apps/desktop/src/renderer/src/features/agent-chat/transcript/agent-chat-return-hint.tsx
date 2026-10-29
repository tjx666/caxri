import { ArrowUp, X } from 'lucide-react';
import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react';
import * as m from 'motion/react-m';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { motionDurationMs, motionEasing } from '../../../lib/motion';
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
 *
 * It fades and rises in on the overlay tokens like Jump to latest, and `AnimatePresence` keeps it mounted long enough
 * to fade back down when the hint clears, so a jump or dismissal does not make it blink out. Reduced motion skips
 * both.
 */
export function AgentChatReturnHint({
    hint,
    onDismiss,
    onJump,
}: {
    hint: AgentChatReturnHintData | undefined;
    onDismiss: () => void;
    onJump: (turnId: string) => void;
}) {
    const shouldReduceMotion = useShouldReduceMotion();
    const enter = shouldReduceMotion
        ? { duration: 0 }
        : {
              duration: motionDurationMs('--motion-overlay-enter') / 1000,
              ease: motionEasing('--motion-ease-enter'),
          };
    const exit = shouldReduceMotion
        ? { duration: 0 }
        : {
              duration: motionDurationMs('--motion-overlay-exit') / 1000,
              ease: motionEasing('--motion-ease-exit'),
          };
    return (
        <LazyMotion strict features={domAnimation}>
            <AnimatePresence initial={false}>
                {hint && (
                    <m.div
                        key="return-hint"
                        animate={{ opacity: 1, y: 0, transition: enter }}
                        className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2"
                        exit={{ opacity: 0, y: 4, transition: exit }}
                        initial={{ opacity: 0, y: 4 }}
                    >
                        <ReturnHintPill hint={hint} onDismiss={onDismiss} onJump={onJump} />
                    </m.div>
                )}
            </AnimatePresence>
        </LazyMotion>
    );
}

function ReturnHintPill({
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
                'flex items-center gap-0.5 rounded-full border border-border bg-elevated pr-0.5 text-xs text-foreground shadow-[0_8px_24px_var(--shadow)]',
                anchorTurnId === undefined ? 'pl-3' : 'pl-0.5',
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

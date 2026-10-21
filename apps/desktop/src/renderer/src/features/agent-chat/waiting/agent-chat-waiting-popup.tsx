import type { KeyboardEvent } from 'react';

import { CircleHelp } from 'lucide-react';
import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react';
import * as m from 'motion/react-m';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { useTranslation } from '../../../i18n';
import { motionDurationMs, motionEasing } from '../../../lib/motion';
import { cn } from '../../../lib/utilities';
import { useIsSessionTabStripVisible } from '../../../stores/open-sessions';
import { AGENT_CHAT_PANE_ATTRIBUTE } from '../permissions/use-agent-chat-approval-keys';
import { AgentChatWaitingCard } from './agent-chat-waiting-card';
import { AgentChatWaitingStatus } from './agent-chat-waiting-status';
import { useAgentChatWaiting } from './use-agent-chat-waiting';

const SURFACE_CLASS_NAME =
    'pointer-events-auto rounded-xl border border-border bg-elevated text-foreground shadow-[0_12px_32px_var(--shadow)]';

/**
 * Asks, from anywhere in the window, what a Chat that is not on screen waits on: a question or an approval from a
 * provider that is still running. It drops in 4px below the window's top chrome (the 36px title bar, or the Open
 * Session strip plus the Terminal tab bar under it) so it never covers a tab or the New Terminal button, one request at
 * a time, and folds into an "N waiting for you" pill the user can reopen; a new request unfolds it again. It never
 * takes focus: the keys a request answers to (option digits, Enter, Cmd+Enter, Cmd+Backspace) work only once the user
 * has moved focus into it, and the card carries the pane attribute so approval keys stay inside the popup instead of
 * reaching a Chat behind it. The layout follows LobeHub's `GlobalApprovalNotification` (design only; the code is
 * Caxri's own).
 */
export function AgentChatWaitingPopup() {
    const { t } = useTranslation();
    const { count, current, isCollapsed, setCollapsed } = useAgentChatWaiting();
    const shouldReduceMotion = useShouldReduceMotion();
    const isSessionTabStripVisible = useIsSessionTabStripVisible();
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
    const onKeyDown = (event: KeyboardEvent): void => {
        // A question's form hands Escape to the card, which folds the popup instead of skipping the question.
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing)
            return;
        event.preventDefault();
        setCollapsed(true);
    };
    const pendingLabel = t('agentChat.waiting.pending', { count });
    return (
        <LazyMotion strict features={domAnimation}>
            <div
                className={cn(
                    'pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4',
                    isSessionTabStripVisible ? 'top-19' : 'top-10',
                )}
            >
                <AgentChatWaitingStatus chat={current} />
                <AnimatePresence initial={false} mode="wait">
                    {current && isCollapsed && (
                        <m.button
                            key="pill"
                            animate={{ opacity: 1, y: 0, transition: enter }}
                            aria-label={t('agentChat.waiting.expand', { count })}
                            className={cn(
                                SURFACE_CLASS_NAME,
                                'flex items-center gap-1.5 px-3 py-1 text-[12px] font-medium hover:bg-state-hover',
                            )}
                            data-agent-chat-waiting="pill"
                            exit={{ opacity: 0, y: -8, transition: exit }}
                            initial={{ opacity: 0, y: -8 }}
                            type="button"
                            onClick={() => setCollapsed(false)}
                        >
                            <CircleHelp aria-hidden className="size-3.5 text-warning" />
                            {pendingLabel}
                        </m.button>
                    )}
                    {current && !isCollapsed && (
                        <m.section
                            key="card"
                            animate={{ opacity: 1, y: 0, scale: 1, transition: enter }}
                            aria-label={t('agentChat.waiting.label')}
                            className={cn(SURFACE_CLASS_NAME, 'w-[min(640px,92vw)] p-3')}
                            data-agent-chat-waiting="card"
                            exit={{ opacity: 0, y: -8, scale: 0.98, transition: exit }}
                            initial={{ opacity: 0, y: -16, scale: 0.98 }}
                            onKeyDown={onKeyDown}
                            {...{ [AGENT_CHAT_PANE_ATTRIBUTE]: '' }}
                        >
                            <AgentChatWaitingCard
                                chat={current}
                                moreCount={count - 1}
                                onCollapse={() => setCollapsed(true)}
                            />
                        </m.section>
                    )}
                </AnimatePresence>
            </div>
        </LazyMotion>
    );
}

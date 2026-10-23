import type { KeyboardEvent } from 'react';
import { useEffect, useRef } from 'react';

import { CircleHelp } from 'lucide-react';
import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react';
import * as m from 'motion/react-m';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { useTranslation } from '../../../i18n';
import { motionDurationMs, motionEasing } from '../../../lib/motion';
import { cn } from '../../../lib/utilities';
import { AGENT_CHAT_PANE_ATTRIBUTE } from '../permissions/use-agent-chat-approval-keys';
import { AgentChatWaitingCard } from './agent-chat-waiting-card';
import {
    agentChatWaitingFocusTarget,
    registerAgentChatWaitingFocus,
} from './agent-chat-waiting-focus';
import { AgentChatWaitingStatus } from './agent-chat-waiting-status';
import { useAgentChatWaiting } from './use-agent-chat-waiting';

const SURFACE_CLASS_NAME =
    'pointer-events-auto rounded-lg border border-border bg-elevated text-foreground shadow-[0_12px_32px_var(--shadow)]';

/**
 * Asks, from anywhere in the window, what a Chat that is not on screen waits on: a question or an approval from a
 * provider that is still running. It drops in 4px below the window's 36px title bar so it never covers a tab or the New
 * Terminal button, one request at a time, and folds into an "N waiting for you" pill the user can reopen; a new request
 * unfolds it again. It never takes focus by itself (`Focus Waiting Request` in the command palette moves it in,
 * unfolding the card first): the keys a request answers to (option digits, Cmd+Enter, Cmd+Backspace) work only once the
 * user has moved focus into it, and the card carries the pane attribute so approval keys stay inside the popup instead
 * of reaching a Chat behind it. The exception is a question's Enter, which the Submit button advertises: it answers
 * with nothing focused or from an idle Chat (`useAgentChatQuestionEnterKey`), once the card has settled. The layout
 * follows LobeHub's `GlobalApprovalNotification` (design only; the code is Caxri's own).
 */
export function AgentChatWaitingPopup() {
    const { t } = useTranslation();
    const { count, current, isCollapsed, setCollapsed } = useAgentChatWaiting();
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
    const onKeyDown = (event: KeyboardEvent): void => {
        // A question's form hands Escape to the card, which folds the popup instead of skipping the question.
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing)
            return;
        event.preventDefault();
        setCollapsed(true);
    };
    const cardReference = useRef<HTMLElement | null>(null);
    /**
     * Set when the focus command runs while the popup is folded: the card is not mounted yet, so it takes focus as it
     * mounts (see the card's `ref`).
     */
    const shouldFocusCard = useRef(false);
    const hasRequest = current !== undefined;
    useEffect(() => {
        if (!hasRequest) return;
        return registerAgentChatWaitingFocus(() => {
            if (cardReference.current) {
                agentChatWaitingFocusTarget(cardReference.current).focus();
                return;
            }
            shouldFocusCard.current = true;
            setCollapsed(false);
        });
    }, [hasRequest, setCollapsed]);
    const pendingLabel = t('agentChat.waiting.pending', { count });
    return (
        <LazyMotion strict features={domAnimation}>
            <div className="pointer-events-none fixed inset-x-0 top-10 z-40 flex justify-center px-4">
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
                            ref={(element: HTMLElement | null) => {
                                cardReference.current = element;
                                if (!element || !shouldFocusCard.current) return;
                                shouldFocusCard.current = false;
                                agentChatWaitingFocusTarget(element).focus();
                            }}
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

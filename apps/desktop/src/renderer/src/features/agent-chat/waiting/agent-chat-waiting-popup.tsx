import type { KeyboardEvent } from 'react';

import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react';
import * as m from 'motion/react-m';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { useTranslation } from '../../../i18n';
import { motionDurationMs, motionEasing } from '../../../lib/motion';
import { AGENT_CHAT_PANE_ATTRIBUTE } from '../permissions/agent-chat-approval-commands';
import { AgentChatWaitingCard } from './agent-chat-waiting-card';
import { AgentChatWaitingStatus } from './agent-chat-waiting-status';
import { useAgentChatWaiting } from './use-agent-chat-waiting';
import { useAgentChatWaitingFocus } from './use-agent-chat-waiting-focus';

/**
 * Asks, from anywhere in the window, what a Chat that is not on screen waits on: a question or an approval from a
 * provider that is still running. It drops in 4px below the window's 36px title bar so it never covers a tab or the New
 * Terminal button, one request at a time. Minimizing folds it into the status bar's "N waiting for you" item
 * (`AgentChatWaitingChip`), which reopens it, so nothing is left over the workspace; a new request unfolds it again. It
 * never takes focus by itself (`Focus Waiting Request`, `Cmd+Alt+W`, moves it in, unfolding the card first, and gives
 * focus back once the last request is answered). Its keys work once focus is in it, with two exceptions that only take
 * a key nothing focused uses: an approval answers to Allow and Deny Request (`agentChatApprovalKeyOwner`), and a
 * question to Enter (`useAgentChatQuestionEnterKey`), each once the card has settled. The card carries the pane
 * attribute so those keys stay inside the popup instead of reaching a Chat behind it. The layout follows LobeHub's
 * `GlobalApprovalNotification` (design only; the code is Caxri's own).
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
    const { attachCard, containerReference, onAnswered } = useAgentChatWaitingFocus({
        count,
        current,
        isCollapsed,
        setCollapsed,
    });
    return (
        <LazyMotion strict features={domAnimation}>
            <div
                ref={containerReference}
                className="pointer-events-none fixed inset-x-0 top-10 z-40 flex justify-center px-4"
            >
                <AgentChatWaitingStatus chat={current} />
                <AnimatePresence initial={false} mode="wait">
                    {current && !isCollapsed && (
                        <m.section
                            key="card"
                            ref={attachCard}
                            animate={{ opacity: 1, y: 0, scale: 1, transition: enter }}
                            // Read as focus moves in, so a screen reader hears how many requests wait.
                            aria-label={t('agentChat.waiting.pending', { count })}
                            className="pointer-events-auto w-[min(640px,92vw)] rounded-lg border border-border bg-elevated p-3 text-foreground shadow-[0_12px_32px_var(--shadow)]"
                            data-agent-chat-waiting="card"
                            exit={{ opacity: 0, y: -8, scale: 0.98, transition: exit }}
                            initial={{ opacity: 0, y: -16, scale: 0.98 }}
                            onKeyDown={onKeyDown}
                            {...{ [AGENT_CHAT_PANE_ATTRIBUTE]: '' }}
                        >
                            <AgentChatWaitingCard
                                chat={current}
                                moreCount={count - 1}
                                onAnswered={onAnswered}
                                onCollapse={() => setCollapsed(true)}
                            />
                        </m.section>
                    )}
                </AnimatePresence>
            </div>
        </LazyMotion>
    );
}

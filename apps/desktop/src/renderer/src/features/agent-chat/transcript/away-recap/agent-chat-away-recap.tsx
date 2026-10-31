import type { AgentChatSnapshot } from '@caxri/protocol';
import { Sparkles, X } from 'lucide-react';
import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react';
import * as m from 'motion/react-m';

import { useRelativeTime } from '@/hooks/use-relative-time';
import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { Button } from '../../../../components/ui/button';
import { Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';
import { motionDurationMs, motionEasing } from '../../../../lib/motion';
import {
    useAgentChatAwayRecapStore,
    visibleAgentChatAwayRecap,
} from './agent-chat-away-recap-store';

/**
 * The away recap at the end of the transcript: a one-line "where this stands, what comes next" the Server asked the
 * Agent for on the side while the user was elsewhere (`ChatAwayRecap`). It sits after the last reply as a quiet card,
 * labelled so it never reads as the Agent's own message, and leaves when the Chat replies again, starts a turn, or the
 * user closes it.
 *
 * It fades and rises in on the overlay tokens, and fades out when it clears; reduced motion skips both.
 */
export function AgentChatAwayRecap({
    snapshot,
    terminalId,
}: {
    snapshot: AgentChatSnapshot | undefined;
    terminalId: string;
}) {
    const dismissedAt = useAgentChatAwayRecapStore((state) => state.dismissed[terminalId]);
    const dismiss = useAgentChatAwayRecapStore((state) => state.dismiss);
    const recap = visibleAgentChatAwayRecap(snapshot, dismissedAt);
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
                {recap && (
                    <m.div
                        key={recap.generatedAt}
                        animate={{ opacity: 1, y: 0, transition: enter }}
                        exit={{ opacity: 0, transition: exit }}
                        initial={{ opacity: 0, y: 4 }}
                    >
                        <AwayRecapCard
                            generatedAt={recap.generatedAt}
                            text={recap.text}
                            onDismiss={() => dismiss(terminalId, recap.generatedAt)}
                        />
                    </m.div>
                )}
            </AnimatePresence>
        </LazyMotion>
    );
}

function AwayRecapCard({
    generatedAt,
    onDismiss,
    text,
}: {
    generatedAt: number;
    onDismiss: () => void;
    text: string;
}) {
    const { t } = useTranslation();
    const age = useRelativeTime(generatedAt);
    return (
        <section
            aria-label={t('agentChat.awayRecap.label')}
            className="mt-3 rounded-lg border border-border bg-surface py-2 pr-1.5 pl-3"
            data-agent-chat-away-recap=""
        >
            <header className="flex items-center gap-1.5 text-[12px] leading-5 text-muted">
                <Sparkles aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="font-medium">{t('agentChat.awayRecap.label')}</span>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate">{age}</span>
                <Tooltip content={t('agentChat.awayRecap.dismiss')}>
                    <Button
                        aria-label={t('agentChat.awayRecap.dismiss')}
                        className="-my-1 ml-auto size-6"
                        size="icon"
                        variant="ghost"
                        onClick={onDismiss}
                    >
                        <X aria-hidden="true" className="size-3.5" />
                    </Button>
                </Tooltip>
            </header>
            <p className="m-0 mt-1 pr-1.5 text-[13px] leading-5 wrap-break-word text-foreground select-text">
                {text}
            </p>
        </section>
    );
}

import { Fragment } from 'react';

import { ArrowUp, ArrowUpToLine, CornerDownLeft, Play } from 'lucide-react';
import { AnimatePresence, domAnimation, LazyMotion } from 'motion/react';
import * as m from 'motion/react-m';

import { ShortcutBadge } from '../../../../components/shortcut-badge';
import { Button } from '../../../../components/ui/button';
import { Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { AGENT_CHAT_PRIMARY_ACTION_CLASS_NAME } from '../../agent-chat-stop-button';
import type { AgentChatSendKey } from './agent-chat-send-tooltip';
import { useIsSteerChordHeld } from './use-is-steer-chord-held';

const SEND_GLYPHS = {
    queue: CornerDownLeft,
    resume: Play,
    send: ArrowUp,
    steer: ArrowUpToLine,
} as const;

/**
 * Sends the form. `aria-disabled` rather than `disabled`: a natively disabled button gets no pointer events in
 * Chromium, so its tooltip, the one place that says why Send is unavailable, would never open. The composer's `submit`
 * refuses an unsendable draft itself.
 *
 * While a turn runs, its tooltip lists what Enter, Cmd+Enter, and Esc do, and holding Cmd or Ctrl turns it into Steer
 * (an accent "insert into this turn" glyph) so the chord's effect shows before the press; a click then steers too,
 * through the button's `delivery` value. While Enter itself steers (`isSteerDefault`), the button is Steer without a
 * chord. After a stopped or failed turn with nothing typed (`isResume`), it is Continue: an accent play glyph, as in
 * the Codex app, that sends "Continue" for the user.
 */
export function AgentChatSendButton({
    isQueueing,
    isResume,
    isSendable,
    keys,
    sendAction,
    shortcut,
    tooltip,
}: {
    isQueueing: boolean;
    isResume: boolean;
    isSendable: boolean;
    /**
     * The running turn's keys (`agentChatSendTooltipKeys`), listed in place of `tooltip`; their presence also lets Cmd
     * turn the button into Steer.
     */
    keys: readonly AgentChatSendKey[] | undefined;
    sendAction: { kind?: 'queue' | 'send' | 'steer'; label: string; tooltip: string };
    shortcut: string | undefined;
    tooltip: string;
}) {
    const { t } = useTranslation();
    const isChordHeld = useIsSteerChordHeld() && keys !== undefined;
    const isSteering = isChordHeld || sendAction.kind === 'steer';
    const glyph = isResume ? 'resume' : isSteering ? 'steer' : isQueueing ? 'queue' : 'send';
    const isAccent = isResume || isSteering;
    const Glyph = SEND_GLYPHS[glyph];
    return (
        <Tooltip
            content={keys ? <AgentChatSendKeys keys={keys} /> : tooltip}
            shortcut={keys ? undefined : shortcut}
        >
            <Button
                aria-disabled={!isSendable || undefined}
                aria-label={
                    isResume
                        ? t('agentChat.composer.resume')
                        : isChordHeld
                          ? t('agentChat.queue.steer')
                          : sendAction.label
                }
                className={cn(
                    AGENT_CHAT_PRIMARY_ACTION_CLASS_NAME,
                    'transition-[background-color,border-color,color]',
                    isAccent &&
                        'border-accent bg-accent text-accent-foreground enabled:not-aria-disabled:hover:bg-accent',
                )}
                name="delivery"
                size="icon"
                type="submit"
                value={isSteering ? 'steer' : ''}
                variant="ghost"
            >
                <LazyMotion strict features={domAnimation}>
                    <AnimatePresence initial={false} mode="popLayout">
                        <m.span
                            key={glyph}
                            animate={{ opacity: 1, scale: 1 }}
                            className="flex"
                            exit={{ opacity: 0, scale: 0.6 }}
                            initial={{ opacity: 0, scale: 0.6 }}
                            transition={{ duration: 0.12 }}
                        >
                            <Glyph
                                className={cn('size-4', glyph === 'resume' && 'fill-current')}
                                strokeWidth={2.25}
                            />
                        </m.span>
                    </AnimatePresence>
                </LazyMotion>
            </Button>
        </Tooltip>
    );
}

/**
 * The running turn's Send tooltip: one row per key, its action on the left and its keycap on the right.
 */
function AgentChatSendKeys({ keys }: { keys: readonly AgentChatSendKey[] }) {
    return (
        <span className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1">
            {keys.map(({ label, shortcut }) => (
                <Fragment key={shortcut}>
                    <span>{label}</span>
                    <ShortcutBadge className="justify-self-end" compact shortcut={shortcut} />
                </Fragment>
            ))}
        </span>
    );
}

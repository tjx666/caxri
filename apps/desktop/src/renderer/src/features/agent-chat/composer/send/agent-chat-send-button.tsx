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

/**
 * Each state's glyph with its own optical size. The outline arrows fill the 28px circle at 16px, but a filled Play at
 * that size reads as an enlarged media button, so it drops to 12px, as the Codex app draws its Resume glyph. No nudge
 * is needed to center it: lucide already draws the path one unit right of the view box's center, which balances the
 * triangle's weight toward its flat side.
 */
const SEND_GLYPHS = {
    queue: { className: 'size-4', Icon: CornerDownLeft },
    resume: { className: 'size-3 fill-current', Icon: Play },
    send: { className: 'size-4', Icon: ArrowUp },
    steer: { className: 'size-4', Icon: ArrowUpToLine },
} as const;

function sendGlyph(state: {
    isQueueing: boolean;
    isResume: boolean;
    isSteering: boolean;
}): keyof typeof SEND_GLYPHS {
    if (state.isResume) return 'resume';
    if (state.isSteering) return 'steer';
    return state.isQueueing ? 'queue' : 'send';
}

/**
 * Sends the form. `aria-disabled` rather than `disabled`: a natively disabled button gets no pointer events in
 * Chromium, so its tooltip, the one place that says why Send is unavailable, would never open. The composer's `submit`
 * refuses an unsendable draft itself.
 *
 * While a turn runs, its tooltip lists what Enter, Cmd+Enter, and Esc do, and holding Cmd or Ctrl turns it into Steer
 * (an accent "insert into this turn" glyph) so the chord's effect shows before the press; a click then steers too,
 * through the button's `delivery` value. While Enter itself steers (`isSteerDefault`), the button is Steer without a
 * chord. After a stopped or failed turn with nothing typed (`isResume`), it is Continue: a small play glyph on the same
 * neutral circle as Send, as in the Codex app, that sends "Continue" for the user. Only Steer takes the accent, because
 * it is a state the user is holding, not one left resting on screen.
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
    const glyph = sendGlyph({ isQueueing, isResume, isSteering });
    const { className: glyphClassName, Icon: Glyph } = SEND_GLYPHS[glyph];
    // Continue names itself; otherwise a held chord turns the action into Steer.
    const resumeOrSteerLabel = t(
        glyph === 'resume' ? 'agentChat.composer.resume' : 'agentChat.queue.steer',
    );
    return (
        <Tooltip
            content={keys ? <AgentChatSendKeys keys={keys} /> : tooltip}
            shortcut={keys ? undefined : shortcut}
        >
            <Button
                aria-disabled={!isSendable || undefined}
                aria-label={
                    glyph === 'resume' || isChordHeld ? resumeOrSteerLabel : sendAction.label
                }
                className={cn(
                    AGENT_CHAT_PRIMARY_ACTION_CLASS_NAME,
                    'transition-[background-color,border-color,color]',
                    glyph === 'steer' &&
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
                            <Glyph className={glyphClassName} strokeWidth={2.25} />
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

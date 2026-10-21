import type { AgentChatActivity } from '@caxri/protocol';
import { AnimatePresence } from 'motion/react';
import * as m from 'motion/react-m';

import { AnimatedNumber, AnimatedNumberGroup } from '../../../../components/animated-number';
import { Spinner } from '../../../../components/ui/spinner';
import { useTranslation } from '../../../../i18n';
import { useClockTick } from '../../hooks/use-clock-tick';
import { stripIndicator, ToolGlyph, useLoadingStyle, WorkingBuddy } from '../../loading';
import { elapsedTimeFigures } from '../agent-chat-elapsed-time';
import { STATUS_ROW_SWAP } from './agent-chat-status-row-motion';

/**
 * What leads the working row: Buddy acting out the turn's current work, the live glyph of the tool it runs, or the
 * plain spinner, per `agentChat.workingIndicator` and `agentChat.animatedToolIcons`.
 */
function WorkingIndicatorGlyph({
    activity,
    turnId,
}: {
    activity: Exclude<AgentChatActivity, { kind: 'waiting' }>;
    turnId: string | undefined;
}) {
    const indicator = stripIndicator(activity, useLoadingStyle());
    if (indicator.kind === 'buddy') {
        return <WorkingBuddy activity={activity} size={16} turnId={turnId} />;
    }
    if (indicator.kind === 'glyph') {
        return (
            <span className="inline-flex shrink-0 text-foreground">
                <ToolGlyph kind={indicator.glyph} size={14} />
            </span>
        );
    }
    return <Spinner className="size-3.5 shrink-0" role="presentation" />;
}

/**
 * The tens of a seconds count stop at 5, so 59 rolls forward to 00.
 */
const SECONDS_DIGITS = { 1: { max: 5 } };

/**
 * How long the turn has run, its digits rolling forward like a clock's every second (`elapsedTimeFigures`).
 */
function ElapsedTime({ startedAt }: { startedAt: number }) {
    const { t } = useTranslation();
    const figures = elapsedTimeFigures(useClockTick('second') - startedAt, t);
    if (!figures) return null;
    const { minutes, separator, seconds } = figures;
    const text = `${minutes ? `${minutes.prefix}${minutes.value}${minutes.suffix}` : ''}${separator}${seconds.prefix}${seconds.value}${seconds.suffix}`;
    return (
        <span
            className="shrink-0 whitespace-pre tabular-nums"
            data-agent-chat-elapsed-time=""
            data-value={text}
        >
            <AnimatedNumberGroup>
                {minutes && (
                    <AnimatedNumber
                        prefix={minutes.prefix}
                        suffix={minutes.suffix}
                        trend={1}
                        value={minutes.value}
                    />
                )}
                {separator}
                <AnimatedNumber
                    digits={SECONDS_DIGITS}
                    prefix={seconds.prefix}
                    suffix={seconds.suffix}
                    trend={1}
                    value={seconds.value}
                />
            </AnimatedNumberGroup>
        </span>
    );
}

/**
 * The status row's lead while the Chat starts, works, or compacts: the working glyph, the turn's verb under a sweeping
 * highlight, and how long it has run, so a long turn reads as progress rather than a stall. A new verb (or `Stopping…`)
 * rises in while the old one lifts away. A turn waiting on the user shows no lead: its request card right above already
 * says so. The status row's live region announces the text, so this copy stays out of the accessibility tree.
 */
export function AgentChatActivityLead({
    activity,
    isStopping,
    turnId,
}: {
    activity: AgentChatActivity;
    isStopping: boolean;
    turnId: string | undefined;
}) {
    const { t } = useTranslation();
    if (activity.kind === 'waiting') return null;
    const text = isStopping ? t('agentChat.activity.stopping') : activity.text;
    return (
        <span aria-hidden="true" className="flex min-w-0 items-center gap-2">
            <WorkingIndicatorGlyph activity={activity} turnId={turnId} />
            <span className="relative flex min-w-0">
                <AnimatePresence initial={false} mode="popLayout">
                    <m.span
                        animate={STATUS_ROW_SWAP.shown}
                        className="block min-w-0 truncate"
                        exit={STATUS_ROW_SWAP.exit}
                        initial={STATUS_ROW_SWAP.enter}
                        key={text}
                        transition={STATUS_ROW_SWAP.transition}
                    >
                        <span className={isStopping ? undefined : 'activity-shimmer'}>{text}</span>
                    </m.span>
                </AnimatePresence>
            </span>
            {activity.kind === 'working' && activity.startedAt !== undefined && (
                <ElapsedTime startedAt={activity.startedAt} />
            )}
        </span>
    );
}

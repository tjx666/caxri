import type { AgentChatActivity } from '@caxri/protocol';
import { Info, MessageCircleQuestionMark } from 'lucide-react';

import { AnimatedNumber, AnimatedNumberGroup } from '../../../components/animated-number';
import { Kbd } from '../../../components/ui/kbd';
import { Spinner } from '../../../components/ui/spinner';
import { useTranslation } from '../../../i18n';
import { useIsAgentChatStopping } from '../hooks/use-agent-chat-stop';
import { useClockTick } from '../hooks/use-clock-tick';
import { stripIndicator, ToolGlyph, useLoadingStyle, WorkingBuddy } from '../loading';
import { elapsedTimeFigures } from './agent-chat-elapsed-time';
import { AgentChatTurnMetricList } from './agent-chat-turn-metric-list';

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
 * How the row reads for this activity: `Stopping…` once Stop was requested for a working turn, and the sweep everywhere
 * but while waiting or stopping.
 */
function activityRowState(activity: AgentChatActivity | undefined, isStopRequested: boolean) {
    const isStopping = activity?.kind === 'working' && isStopRequested;
    return { isStopping, isSweeping: !isStopping && activity?.kind !== 'waiting' };
}

/**
 * The composer strip's row while the Chat starts, works, or waits on the user. The strip sits on top of the card rather
 * than inside it, so the Chat's state never reads as part of what the user is typing. A working turn shows its verb
 * under a sweeping highlight and how long it has run, so a long turn reads as progress rather than a stall; a turn
 * waiting on the user shows no row of its own, since its request card right above already says so, and holds still once
 * a draft brings the row back, since nothing is in progress until the user answers. The polite live region stays
 * mounted so transitions between starting, working, and waiting are announced, while the ticking time never is. A
 * working turn also shows what it has spent so far (steps, tokens, estimated cost) on the right, followed by an `Esc to
 * stop` hint that is the first thing a narrow strip drops. While a turn runs and the user has typed something, the row
 * also says what Enter and Cmd+Enter will do with it (keycaps only when the strip is narrow), because the difference
 * between queueing and steering is otherwise invisible until the message lands. A `notice` (why Enter did not send, or
 * that a second Enter sends an unmatched `/` draft as text) takes the live region while it lasts and shows as its own
 * row, so a refused Enter is never silent.
 */
export function AgentChatActivityBar({
    activity,
    notice,
    showsDeliveryHint,
    terminalId,
    turnId,
}: {
    activity: AgentChatActivity | undefined;
    /**
     * A short-lived composer message (`useAgentChatComposerNotice`), or a hint that lasts while its draft does.
     */
    notice: string | undefined;
    /**
     * A turn is running and the draft has content, so Enter queues and Cmd+Enter steers.
     */
    showsDeliveryHint: boolean;
    /**
     * The Chat Terminal, whose pending Stop turns the row into `Stopping…`.
     */
    terminalId: string;
    /**
     * The running turn, which seeds Buddy's rare party hat so it stays on for the whole turn.
     */
    turnId: string | undefined;
}) {
    const { t } = useTranslation();
    // Once Stop was requested the row says so and stops sweeping.
    const { isStopping, isSweeping } = activityRowState(
        activity,
        useIsAgentChatStopping(terminalId, turnId),
    );
    const text = isStopping ? t('agentChat.activity.stopping') : activity?.text;
    return (
        <>
            <span aria-live="polite" className="sr-only" role="status">
                {notice ?? text}
            </span>
            {/*
             * While a turn waits, the approval or question card sits right above the composer and is the waiting state
             * itself, so a second "waiting" row would only wedge between the card and its composer. The row returns
             * once the user types, to say what Enter does with the draft. The live region above still announces it.
             */}
            {activity && (activity.kind !== 'waiting' || showsDeliveryHint) && (
                <div
                    aria-hidden="true"
                    className="@container flex h-8 items-center gap-2 border-0 border-b border-solid border-border px-3 text-[12px] text-muted"
                    data-agent-chat-composer-strip-row=""
                >
                    {activity.kind === 'waiting' ? (
                        <MessageCircleQuestionMark className="size-3.5 shrink-0 text-warning" />
                    ) : (
                        <WorkingIndicatorGlyph activity={activity} turnId={turnId} />
                    )}
                    <span className="min-w-0 truncate">
                        <span className={isSweeping ? 'activity-shimmer' : undefined}>{text}</span>
                    </span>
                    {activity.kind === 'working' && activity.startedAt !== undefined && (
                        <ElapsedTime startedAt={activity.startedAt} />
                    )}
                    <div className="ml-auto flex shrink-0 items-center gap-2.5">
                        {activity.kind === 'working' && (
                            <AgentChatTurnMetricList usage={activity.usage} />
                        )}
                        {activity.kind === 'working' && !isStopping && (
                            // Drops before the metrics and the delivery hint do: the Stop button beside the composer
                            // carries the same action.
                            <span className="shrink-0 text-[11px] whitespace-nowrap @max-[480px]:hidden">
                                <Kbd size="compact">Esc</Kbd> {t('agentChat.activity.stopHint')}
                            </span>
                        )}
                        {showsDeliveryHint && (
                            <span className="shrink-0 text-[11px] whitespace-nowrap">
                                <Kbd size="compact">Enter</Kbd>
                                <span className="@max-[420px]:hidden">
                                    {' '}
                                    {t('agentChat.activity.enterHint')} ·{' '}
                                </span>
                                <span className="hidden @max-[420px]:inline"> </span>
                                <Kbd size="compact">⌘Enter</Kbd>
                                <span className="@max-[420px]:hidden">
                                    {' '}
                                    {t('agentChat.activity.steerHint')}
                                </span>
                            </span>
                        )}
                    </div>
                </div>
            )}
            {notice && (
                <div
                    aria-hidden="true"
                    className="flex h-8 items-center gap-2 border-0 border-b border-solid border-border px-3 text-[12px] text-muted"
                    data-agent-chat-composer-strip-row=""
                >
                    <Info className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{notice}</span>
                </div>
            )}
        </>
    );
}

import { Fragment } from 'react';

import { AnimatedNumber, AnimatedNumberGroup } from '../../../components/animated-number';
import type { ElapsedTimeFigure } from './agent-chat-elapsed-time';
import { elapsedTimeText } from './agent-chat-elapsed-time';

/**
 * The tens of a count below a larger unit stop at 5, so 59 rolls forward to 00. Minutes count on past 59 when no hours
 * figure leads them, as a turn's time does.
 */
const SIXTY_DIGITS = { 1: { max: 5 } };

/**
 * A ticking time whose digits roll forward like a clock's every second, from `elapsedTimeFigures` or `goalTimeFigures`.
 */
export function AgentChatRollingTime({
    figures,
    ...data
}: {
    'figures': readonly ElapsedTimeFigure[];
    'data-agent-chat-elapsed-time'?: string;
    'data-agent-chat-goal-time'?: string;
}) {
    const hasHours = figures.some((figure) => figure.unit === 'hours');
    return (
        <span
            className="shrink-0 whitespace-pre tabular-nums"
            data-value={elapsedTimeText(figures)}
            {...data}
        >
            <AnimatedNumberGroup>
                {figures.map((figure) => (
                    <Fragment key={figure.unit}>
                        {figure.separator}
                        <AnimatedNumber
                            digits={
                                figure.unit === 'seconds' || (hasHours && figure.unit === 'minutes')
                                    ? SIXTY_DIGITS
                                    : undefined
                            }
                            prefix={figure.prefix}
                            suffix={figure.suffix}
                            trend={1}
                            value={figure.value}
                        />
                    </Fragment>
                ))}
            </AnimatedNumberGroup>
        </span>
    );
}

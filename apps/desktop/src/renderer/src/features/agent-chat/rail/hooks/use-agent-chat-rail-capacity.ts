import { useLayoutEffect, useState } from 'react';

import { agentChatRailTickCapacity, MAX_AGENT_CHAT_RAIL_MARKS } from '../agent-chat-rail-marks';

/**
 * How many ticks the message rail can draw apart in `column`, the box the rail is centered in, measured again whenever
 * it resizes. Before the first measurement it allows {@link MAX_AGENT_CHAT_RAIL_MARKS}.
 */
export function useAgentChatRailCapacity(column: HTMLElement | null): number {
    const [capacity, setCapacity] = useState(MAX_AGENT_CHAT_RAIL_MARKS);
    useLayoutEffect(() => {
        if (!column) return;
        const measure = (): void => setCapacity(agentChatRailTickCapacity(column.clientHeight));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(column);
        return () => observer.disconnect();
    }, [column]);
    return capacity;
}

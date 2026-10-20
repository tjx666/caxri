import { useLayoutEffect, useState } from 'react';

import {
    agentChatRailTickCapacity,
    MAX_AGENT_CHAT_RAIL_MARKS,
} from '../transcript/agent-chat-rail-marks';

/**
 * The room the rail leaves above and below itself inside the conversation area (its `max-h-[calc(100%-6rem)]`).
 */
const RAIL_VERTICAL_INSET_PX = 96;

/**
 * How many ticks the message rail can draw at a hittable height in the conversation area that holds `rail`, measured
 * again whenever that area resizes. Before the first measurement it allows {@link MAX_AGENT_CHAT_RAIL_MARKS}.
 */
export function useAgentChatRailCapacity(rail: HTMLElement | null): number {
    const [capacity, setCapacity] = useState(MAX_AGENT_CHAT_RAIL_MARKS);
    useLayoutEffect(() => {
        const area = rail?.parentElement;
        if (!area) return;
        const measure = (): void =>
            setCapacity(agentChatRailTickCapacity(area.clientHeight - RAIL_VERTICAL_INSET_PX));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(area);
        return () => observer.disconnect();
    }, [rail]);
    return capacity;
}

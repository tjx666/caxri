import { currentAgentChatAwayRecap } from '@caxri/protocol';

import type { AgentChatTimelineEntry } from './agent-chat-timeline';

/**
 * The away recap after the last reply (`withAgentChatAwayRecap`). `generatedAt` names the recap, so closing it hides
 * exactly that one.
 */
export interface AgentChatAwayRecapEntry {
    kind: 'awayRecap';
    id: string;
    generatedAt: number;
    text: string;
}

/**
 * `entries` with the away recap after the last reply (`currentAgentChatAwayRecap`, which already drops a recap once the
 * Chat replies again or starts a turn), unless the user closed that very recap. A message still on its way, or the
 * reply placeholder, means a turn is about to start, so the recap leaves with them rather than sitting above the new
 * message.
 */
export function withAgentChatAwayRecap(
    entries: readonly AgentChatTimelineEntry[],
    snapshot: Parameters<typeof currentAgentChatAwayRecap>[0],
    dismissedAt: number | undefined,
): readonly AgentChatTimelineEntry[] {
    const recap = currentAgentChatAwayRecap(snapshot);
    if (!recap || recap.generatedAt === dismissedAt) return entries;
    const last = entries.at(-1);
    if (last?.kind === 'pending' || last?.kind === 'awaiting') return entries;
    return [
        ...entries,
        { kind: 'awayRecap', id: 'away-recap', generatedAt: recap.generatedAt, text: recap.text },
    ];
}

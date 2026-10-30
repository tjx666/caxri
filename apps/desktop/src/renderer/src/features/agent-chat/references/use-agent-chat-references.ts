import { createContext, useContext, useMemo, useState } from 'react';

import type { ReferenceMentionIndex } from '../../../components/markdown/reference-mentions';
import {
    isSameReferenceMentionIndex,
    referenceMentionIndex,
} from '../../../components/markdown/reference-mentions';
import type { AgentChatSettledChunk } from '../transcript/agent-chat-settled-chunks';
import type { AgentChatTimelineEntry } from '../transcript/agent-chat-timeline';
import { agentChatReferenceUrls } from './agent-chat-reference-urls';

/**
 * The conversation's links keyed by how a reply mentions them (`#2354`, `ENG-123`). Provided by the Chat pane; a task
 * tab's read-only timeline provides none, so its mentions stay text.
 */
export const AgentChatReferencesContext = createContext<ReferenceMentionIndex | undefined>(
    undefined,
);

export function useAgentChatReferences(): ReferenceMentionIndex | undefined {
    return useContext(AgentChatReferencesContext);
}

/**
 * Builds the Chat pane's mention index from the history read back and the live timeline. The index keeps its identity
 * until a mention or its link actually changes, so the streamed patches that add none leave every rendered reply alone.
 * Undefined while the conversation holds no link a mention could name.
 */
export function useAgentChatReferenceIndex(
    settledChunks: readonly AgentChatSettledChunk[],
    timeline: readonly AgentChatTimelineEntry[],
): ReferenceMentionIndex | undefined {
    const next = useMemo(
        () =>
            referenceMentionIndex(
                agentChatReferenceUrls([
                    ...settledChunks.flatMap((chunk) => chunk.entries),
                    ...timeline,
                ]),
            ),
        [settledChunks, timeline],
    );
    const [index, setIndex] = useState(next);
    // Derived from the previous render, as React documents for state that follows a prop.
    if (!isSameReferenceMentionIndex(index, next)) setIndex(next);
    return index.size === 0 ? undefined : index;
}

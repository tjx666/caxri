import { createContext, useContext } from 'react';

import type { MarkdownSkillHost } from '../../../components/markdown/markdown-context';

/**
 * Marks the skills a Chat reply names in inline code (see `useAgentChatSkillHost`). Provided by the Chat pane; a task
 * tab's read-only timeline provides nothing, so its inline code stays plain. Kept apart from the provider's hook, which
 * imports the reference component and through it `AgentChatMessage`, so reading it here adds no import cycle.
 */
export const AgentChatSkillsContext = createContext<MarkdownSkillHost | undefined>(undefined);

export function useAgentChatSkills(): MarkdownSkillHost | undefined {
    return useContext(AgentChatSkillsContext);
}

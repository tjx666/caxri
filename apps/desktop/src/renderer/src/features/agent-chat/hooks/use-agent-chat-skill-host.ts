import { useMemo } from 'react';

import type { MarkdownSkillHost } from '../../../components/markdown/markdown-context';
import { isAgentProcessRunning } from '../../../lib/terminal-agent-runtime';
import { useCaxriQuery } from '../../../queries/client';
import { useTerminal } from '../../../stores/selectors';
import { AgentChatSkillReference } from '../composer-input/agent-chat-skill-reference';
import {
    agentChatSkillIndex,
    agentChatSkillMatch,
} from '../composer-input/agent-chat-skill-references';
import { AGENT_ACTION_DISCOVERY_STALE_MS } from './use-agent-chat-command-menu';

/**
 * What the Chat pane provides so a reply's inline code that names a discovered skill shows as one. Discovery shares the
 * composer menu's query and answers only for a running Agent; a list read earlier stays in the cache after the Agent
 * stops, so an idle Chat keeps its marks. Undefined until a skill is known, so the memoized rows skip a re-render while
 * there is nothing to mark.
 */
export function useAgentChatSkillHost(terminalId: string): MarkdownSkillHost | undefined {
    const isAgentRunning = isAgentProcessRunning(useTerminal(terminalId)?.lastAgentProcessState);
    const discovery = useCaxriQuery(
        'agentActions.list',
        { terminalId },
        { enabled: isAgentRunning, retry: false, staleTime: AGENT_ACTION_DISCOVERY_STALE_MS },
    );
    const actions = discovery.data?.actions;
    const referenceOnlySkills = discovery.data?.referenceOnlySkills;
    return useMemo(() => {
        const index = agentChatSkillIndex(actions, referenceOnlySkills);
        if (index.size === 0) return;
        return {
            match: (code) => agentChatSkillMatch(index, code),
            Reference: AgentChatSkillReference,
        };
    }, [actions, referenceOnlySkills]);
}

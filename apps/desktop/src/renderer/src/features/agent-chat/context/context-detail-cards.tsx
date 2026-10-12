import type { AgentChatContextComposition } from '@caxri/protocol';
import { formatTokens } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { messageTokens } from './composition';
import {
    agentRows,
    includedCaption,
    mcpRows,
    memoryRows,
    messageRows,
    skillRows,
} from './detail-rows';
import { TokenListCard } from './token-list-card';

function sum(rows: ReadonlyArray<{ tokens: number }>): number {
    return rows.reduce((total, row) => total + row.tokens, 0);
}

/**
 * Item-by-item lists of what fills the window: the conversation by kind and tool, MCP servers and their tools, skills,
 * memory files, and custom agents. Each list sorts heaviest first and measures its bars against its own total.
 */
export function ContextDetailCards({ composition }: { composition: AgentChatContextComposition }) {
    const { t } = useTranslation();
    const { messages, skills, slashCommands } = composition;
    const mcp = mcpRows(t, composition);
    const mcpTokens = sum(mcp);
    const deferredMcpTokens = composition.mcpTools
        .filter((tool) => !tool.isLoaded)
        .reduce((total, tool) => total + tool.tokens, 0);
    const memory = memoryRows(composition);
    const agents = agentRows(t, composition);
    return (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(22rem,1fr))] items-start gap-3">
            {messages && (
                <TokenListCard
                    caption={formatTokens(messageTokens(messages))}
                    empty={t('agentChat.contextPage.messages.empty')}
                    rows={messageRows(t, messages, composition)}
                    title={t('agentChat.contextPage.messages.title')}
                    total={messageTokens(messages)}
                />
            )}
            <TokenListCard
                caption={
                    mcp.length > 0
                        ? t('agentChat.contextPage.mcp.caption', {
                              count: mcp.length,
                              tokens: formatTokens(mcpTokens),
                          })
                        : undefined
                }
                empty={t('agentChat.contextPage.mcp.empty')}
                footer={
                    deferredMcpTokens > 0
                        ? t('agentChat.contextPage.mcp.deferredNote', {
                              tokens: formatTokens(deferredMcpTokens),
                          })
                        : undefined
                }
                rows={mcp}
                title={t('agentChat.contextPage.mcp.title')}
                total={mcpTokens}
            />
            <TokenListCard
                caption={
                    skills
                        ? includedCaption(t, skills.included, skills.total, skills.tokens)
                        : undefined
                }
                empty={t('agentChat.contextPage.skills.empty')}
                footer={
                    slashCommands && slashCommands.total > 0
                        ? t('agentChat.contextPage.skills.commands', {
                              caption: includedCaption(
                                  t,
                                  slashCommands.included,
                                  slashCommands.total,
                                  slashCommands.tokens,
                              ),
                          })
                        : undefined
                }
                rows={skillRows(t, composition)}
                title={t('agentChat.contextPage.skills.title')}
                total={skills?.tokens ?? 0}
            />
            <TokenListCard
                caption={memory.length > 0 ? formatTokens(sum(memory)) : undefined}
                empty={t('agentChat.contextPage.memory.empty')}
                rows={memory}
                title={t('agentChat.contextPage.memory.title')}
                total={sum(memory)}
            />
            {agents.length > 0 && (
                <TokenListCard
                    caption={formatTokens(sum(agents))}
                    empty=""
                    rows={agents}
                    title={t('agentChat.contextPage.agents.title')}
                    total={sum(agents)}
                />
            )}
        </div>
    );
}

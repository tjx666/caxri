import type { AgentChatContextComposition } from '@caxri/protocol';
import { formatTokens } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../../i18n';
import { byTokens, mcpServerUsage, messageToolUsage } from './composition';
import { fileName } from './suggestions';

/**
 * One row of a Context tab list: a thing that occupies the context and how much.
 */
export interface TokenRow {
    id: string;
    name: string;
    /**
     * A muted note after the name: where it comes from, or how it splits.
     */
    meta?: string;
    tokens: number;
    /**
     * The full identity when `name` shortens it, such as a memory file's path.
     */
    tooltip?: string;
    isMono?: boolean;
    /**
     * Present but outside the window, such as a deferred MCP tool.
     */
    isMuted?: boolean;
    children?: TokenRow[];
}

/**
 * Claude Code's raw source identifiers, as the settings scopes it names them after.
 */
const SOURCE_KEYS: Partial<Record<string, TranslationKey>> = {
    userSettings: 'agentChat.contextPage.source.user',
    projectSettings: 'agentChat.contextPage.source.project',
    localSettings: 'agentChat.contextPage.source.local',
    policySettings: 'agentChat.contextPage.source.managed',
    flagSettings: 'agentChat.contextPage.source.session',
    plugin: 'agentChat.contextPage.source.plugin',
    syncedSkills: 'agentChat.contextPage.source.synced',
    bundled: 'agentChat.contextPage.source.builtIn',
};

export function contextSourceLabel(t: Translate, source: string): string {
    const key = SOURCE_KEYS[source];
    return key ? t(key) : source;
}

export function mcpRows(t: Translate, composition: AgentChatContextComposition): TokenRow[] {
    return mcpServerUsage(composition).map((server) => {
        const deferred = server.tools.length - server.loadedCount;
        return {
            id: server.server,
            name: server.server,
            meta:
                deferred > 0
                    ? t('agentChat.contextPage.mcp.toolsDeferred', {
                          count: server.tools.length,
                          deferred,
                      })
                    : t('agentChat.contextPage.mcp.tools', { count: server.tools.length }),
            tokens: server.tokens,
            // A server whose every tool is deferred costs nothing until the model searches for one.
            isMuted: server.loadedCount === 0,
            children: server.tools.map((tool) => ({
                id: tool.name,
                name: tool.name,
                ...(!tool.isLoaded && { meta: t('agentChat.contextPage.mcp.deferred') }),
                tokens: tool.tokens,
                isMono: true,
                isMuted: !tool.isLoaded,
            })),
        };
    });
}

export function skillRows(t: Translate, composition: AgentChatContextComposition): TokenRow[] {
    return byTokens(composition.skills?.items ?? [], (skill) => skill.name).map((skill) => ({
        id: `${skill.source}:${skill.name}`,
        name: skill.name,
        meta: contextSourceLabel(t, skill.source),
        tokens: skill.tokens,
        isMono: true,
    }));
}

export function memoryRows(composition: AgentChatContextComposition): TokenRow[] {
    return byTokens(composition.memoryFiles, (file) => file.path).map((file) => ({
        id: file.path,
        name: fileName(file.path),
        meta: file.type,
        tokens: file.tokens,
        tooltip: file.path,
    }));
}

export function agentRows(t: Translate, composition: AgentChatContextComposition): TokenRow[] {
    return byTokens(composition.agents, (agent) => agent.type).map((agent) => ({
        id: `${agent.source}:${agent.type}`,
        name: agent.type,
        meta: contextSourceLabel(t, agent.source),
        tokens: agent.tokens,
        isMono: true,
    }));
}

/**
 * The conversation by kind of message, then each tool's calls and results as a child list of "Tool results" and "Tool
 * calls", so the heaviest tool is one click from the row it inflates.
 */
export function messageRows(
    t: Translate,
    messages: NonNullable<AgentChatContextComposition['messages']>,
    composition: AgentChatContextComposition,
): TokenRow[] {
    const tools = messageToolUsage(composition);
    const toolChildren = (field: 'callTokens' | 'resultTokens') =>
        byTokens(
            tools.map((tool) => ({ name: tool.name, tokens: tool[field] })),
            (tool) => tool.name,
        )
            .filter((tool) => tool.tokens > 0)
            .map((tool) => ({ id: tool.name, name: tool.name, tokens: tool.tokens, isMono: true }));
    const attachments = byTokens(messages.attachmentKinds, (kind) => kind.name).map((kind) => ({
        id: kind.name,
        name: kind.name,
        tokens: kind.tokens,
        isMono: true,
    }));
    const rows: TokenRow[] = [
        {
            id: 'toolResults',
            name: t('agentChat.contextPage.messages.toolResults'),
            tokens: messages.toolResults,
            children: toolChildren('resultTokens'),
        },
        {
            id: 'toolCalls',
            name: t('agentChat.contextPage.messages.toolCalls'),
            tokens: messages.toolCalls,
            children: toolChildren('callTokens'),
        },
        {
            id: 'assistant',
            name: t('agentChat.contextPage.messages.assistant'),
            tokens: messages.assistant,
        },
        { id: 'user', name: t('agentChat.contextPage.messages.user'), tokens: messages.user },
        {
            id: 'attachments',
            name: t('agentChat.contextPage.messages.attachments'),
            tokens: messages.attachments,
            children: attachments,
        },
        { id: 'other', name: t('agentChat.contextPage.messages.other'), tokens: messages.other },
    ];
    return byTokens(
        rows.filter((row) => row.tokens > 0),
        (row) => row.id,
    );
}

/**
 * "12 of 14 listed · 7.0k": how much of a capped list made it into the context.
 */
export function includedCaption(
    t: Translate,
    included: number,
    total: number,
    tokens: number,
): string {
    return included < total
        ? t('agentChat.contextPage.includedOf', { included, total, tokens: formatTokens(tokens) })
        : t('agentChat.contextPage.included', { count: total, tokens: formatTokens(tokens) });
}

import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentChatContextChange, AgentChatContextComposition } from '@caxri/protocol';
import { MAX_AGENT_CHAT_CONTEXT_CHANGES } from '@caxri/protocol';

import { clip, isRecord, stringField } from './chat-items';
import type { AgentChatSessionHost, ChatContextDetails } from './chat-provider';
import {
    ClaudeContextRefresh,
    readClaudeContextUsage,
    refreshClaudeContextDetails,
} from './claude-context';

type Json = Record<string, unknown>;

/**
 * The Context tab's composition from a `getContextUsage` answer (untrusted): every list the answer carries, clipped to
 * the protocol bounds. `undefined` when the answer is not one.
 */
export function claudeContextComposition(
    response: unknown,
): AgentChatContextComposition | undefined {
    if (!isRecord(response) || typeof response.totalTokens !== 'number') return undefined;
    const skills = isRecord(response.skills) ? response.skills : undefined;
    const slashCommands = isRecord(response.slashCommands) ? response.slashCommands : undefined;
    const messages = isRecord(response.messageBreakdown) ? response.messageBreakdown : undefined;
    const model = stringField(response.model);
    const threshold = response.autoCompactThreshold;
    return {
        ...(model && { model: clip(model, 200) }),
        totalTokens: count(response.totalTokens),
        window: count(response.rawMaxTokens),
        ...(isPositive(threshold) && { autoCompactThreshold: Math.trunc(threshold) }),
        isAutoCompactEnabled: response.isAutoCompactEnabled === true,
        categories: rows(response.categories, 32, (row) => {
            const label = stringField(row.name);
            const { kind } = row;
            return label && isCategoryKind(kind)
                ? { label: clip(label, 80), tokens: count(row.tokens), kind }
                : undefined;
        }),
        memoryFiles: rows(response.memoryFiles, 200, (row) => {
            const path = stringField(row.path);
            return path
                ? {
                      path: clip(path, 4096),
                      type: clip(stringField(row.type) ?? 'Other', 80),
                      tokens: count(row.tokens),
                  }
                : undefined;
        }),
        ...(skills && {
            skills: {
                total: count(skills.totalSkills),
                included: count(skills.includedSkills),
                tokens: count(skills.tokens),
                items: rows(skills.skillFrontmatter, 500, (row) => {
                    const name = stringField(row.name);
                    return name
                        ? {
                              name: clip(name, 200),
                              source: clip(stringField(row.source) ?? 'other', 80),
                              tokens: count(row.tokens),
                          }
                        : undefined;
                }),
            },
        }),
        mcpTools: rows(response.mcpTools, 1_000, (row) => {
            const name = stringField(row.name);
            const server = stringField(row.serverName);
            return name && server
                ? {
                      name: clip(name, 300),
                      server: clip(server, 200),
                      tokens: count(row.tokens),
                      // Older Claude Code builds load every MCP schema up front and leave the flag out.
                      isLoaded: row.isLoaded !== false,
                  }
                : undefined;
        }),
        agents: rows(response.agents, 200, (row) => {
            const type = stringField(row.agentType);
            return type
                ? {
                      type: clip(type, 200),
                      source: clip(stringField(row.source) ?? 'other', 80),
                      tokens: count(row.tokens),
                  }
                : undefined;
        }),
        ...(slashCommands && {
            slashCommands: {
                total: count(slashCommands.totalCommands),
                included: count(slashCommands.includedCommands),
                tokens: count(slashCommands.tokens),
            },
        }),
        ...(messages && { messages: contextMessages(messages) }),
    };
}

function contextMessages(messages: Json): NonNullable<AgentChatContextComposition['messages']> {
    return {
        toolCalls: count(messages.toolCallTokens),
        toolResults: count(messages.toolResultTokens),
        attachments: count(messages.attachmentTokens),
        assistant: count(messages.assistantMessageTokens),
        user: count(messages.userMessageTokens),
        other: count(messages.unattributedTokens) + count(messages.redirectedContextTokens),
        tools: rows(messages.toolCallsByType, 200, (row) => {
            const name = stringField(row.name);
            return name
                ? {
                      name: clip(name, 200),
                      callTokens: count(row.callTokens),
                      resultTokens: count(row.resultTokens),
                  }
                : undefined;
        }),
        attachmentKinds: rows(messages.attachmentsByType, 100, (row) => {
            const name = stringField(row.name);
            return name ? { name: clip(name, 200), tokens: count(row.tokens) } : undefined;
        }),
    };
}

/**
 * Token growth of the system prompt or tool schemas below which the ledger stays quiet: Claude Code's local estimate of
 * the same text drifts by a few tokens between reads, and that drift is not a change.
 */
const SECTION_CHANGE_TOKENS = 64;

interface ContextFingerprint {
    mcpTools: Set<string>;
    skills: Set<string>;
    agents: Set<string>;
    memory: Map<string, number>;
    systemPrompt: number;
    systemTools: number;
}

/**
 * Remembers what preceded the conversation at each context read of a live Chat, and records how it changed from one
 * read to the next: a tool, skill, memory file, or system prompt that changed between two requests is the likeliest
 * reason the second one missed the prompt cache. Claude Code reports no miss cause itself, so this is the evidence the
 * Context tab cites. Bounded to the newest {@link MAX_AGENT_CHAT_CONTEXT_CHANGES} changes.
 */
export class ClaudeContextLedger {
    private last: ContextFingerprint | undefined;

    private readonly recorded: AgentChatContextChange[] = [];

    get changes(): AgentChatContextChange[] {
        return [...this.recorded];
    }

    record(composition: AgentChatContextComposition, at: number): void {
        const next = fingerprint(composition);
        const previous = this.last;
        this.last = next;
        if (!previous) return;
        const push = (change: Omit<AgentChatContextChange, 'at'>) => {
            this.recorded.push({ at, ...change });
        };
        const listChange = (
            kind: AgentChatContextChange['kind'],
            from: Set<string>,
            to: Set<string>,
        ) => {
            const names = [...to.difference(from)];
            if (names.length > 0) push({ kind, names: names.slice(0, 50) });
        };
        listChange('mcpToolsAdded', previous.mcpTools, next.mcpTools);
        listChange('mcpToolsRemoved', next.mcpTools, previous.mcpTools);
        listChange('skillsAdded', previous.skills, next.skills);
        listChange('skillsRemoved', next.skills, previous.skills);
        const agents = symmetricDifference(previous.agents, next.agents);
        if (agents.length > 0) push({ kind: 'agentsChanged', names: agents.slice(0, 50) });
        const memory = [...new Set([...previous.memory.keys(), ...next.memory.keys()])].filter(
            (path) => previous.memory.get(path) !== next.memory.get(path),
        );
        if (memory.length > 0) push({ kind: 'memoryChanged', names: memory.slice(0, 50) });
        const sectionChange = (kind: AgentChatContextChange['kind'], delta: number) => {
            if (Math.abs(delta) >= SECTION_CHANGE_TOKENS)
                push({ kind, names: [], tokenDelta: delta });
        };
        sectionChange('systemPromptChanged', next.systemPrompt - previous.systemPrompt);
        sectionChange('systemToolsChanged', next.systemTools - previous.systemTools);
        this.recorded.splice(0, Math.max(0, this.recorded.length - MAX_AGENT_CHAT_CONTEXT_CHANGES));
    }
}

function fingerprint(composition: AgentChatContextComposition): ContextFingerprint {
    const category = (label: string) =>
        composition.categories.find((row) => row.label === label)?.tokens ?? 0;
    return {
        mcpTools: new Set(composition.mcpTools.map((tool) => tool.name)),
        skills: new Set(composition.skills?.items.map((skill) => skill.name)),
        agents: new Set(composition.agents.map((agent) => agent.type)),
        memory: new Map(composition.memoryFiles.map((file) => [file.path, file.tokens])),
        // Claude Code's own row names; a rename only silences this one signal.
        systemPrompt: category('System prompt'),
        systemTools: category('System tools'),
    };
}

function symmetricDifference(a: Set<string>, b: Set<string>): string[] {
    return [...a.difference(b), ...b.difference(a)];
}

const CATEGORY_KINDS = ['used', 'buffer', 'free', 'deferred'] as const;

function isCategoryKind(kind: unknown): kind is (typeof CATEGORY_KINDS)[number] {
    return CATEGORY_KINDS.includes(kind as (typeof CATEGORY_KINDS)[number]);
}

function rows<T>(value: unknown, max: number, map: (row: Json) => T | undefined): T[] {
    if (!Array.isArray(value)) return [];
    const mapped: T[] = [];
    for (const row of value) {
        if (mapped.length >= max) break;
        const item = isRecord(row) ? map(row) : undefined;
        if (item) mapped.push(item);
    }
    return mapped;
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function isPositive(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The live process a context read goes to, or `undefined` while there is none to ask.
 */
type LiveClaudeContext =
    | {
          query: Query;
          host: Pick<AgentChatSessionHost, 'apply' | 'read'>;
          isEnded: () => boolean;
      }
    | undefined;

/**
 * Every context read of one live Chat: the meter's refresh after each response and the Context tab's on-demand read.
 * Both feed one ledger, so opening the tab between two responses does not hide a change.
 */
export class ClaudeContextTracker {
    private readonly ledger = new ClaudeContextLedger();

    /**
     * Issue order of reads. The meter's refresh and the tab's read often overlap and can answer out of order; the
     * ledger only takes an answer newer than the last one it recorded, so a stale answer never reads as a change.
     */
    private issued = 0;
    private recordedSequence = 0;

    private readonly refresh = new ClaudeContextRefresh(async () => {
        const live = this.live();
        if (!live) return;
        const sequence = ++this.issued;
        await refreshClaudeContextDetails(live.query, live.host, live.isEnded, (response) =>
            this.record(response, sequence),
        );
    });

    constructor(private readonly live: () => LiveClaudeContext) {}

    private record(response: unknown, sequence: number): AgentChatContextComposition | undefined {
        const composition = claudeContextComposition(response);
        if (composition && sequence > this.recordedSequence) {
            this.recordedSequence = sequence;
            this.ledger.record(composition, Date.now());
        }
        return composition;
    }

    /**
     * Refreshes the meter's rows; see {@link refreshClaudeContextDetails}.
     */
    request(): void {
        this.refresh.request();
    }

    /**
     * What fills the context now, item by item, with the changes noticed since the process started.
     */
    async read(query: Pick<Query, 'getContextUsage'>): Promise<ChatContextDetails> {
        const sequence = ++this.issued;
        const composition = this.record(await readClaudeContextUsage(query), sequence);
        return { ...(composition && { composition }), changes: this.ledger.changes };
    }
}

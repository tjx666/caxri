import { sortedCopy } from '@caxri/utils';
import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import type { AgentActionsSettings } from './agent-action-settings.js';
import {
    agentActionInvocationSchema,
    agentActionRecentSettingsSchema,
    MAX_AGENT_ACTION_DESCRIPTION_LENGTH,
    MAX_AGENT_ACTIONS,
} from './agent-action-settings.js';
import type { AgentProvider } from './agents.js';
import { agentProviderCatalog, agentProviderSchema } from './agents.js';

export * from './agent-action-settings.js';

export const agentActionKindSchema = z.enum(['command', 'skill']);
export const agentActionSourceSchema = z.enum(['builtIn', 'project', 'global', 'legacy', 'custom']);

export const agentActionSchema = z.strictObject({
    invocation: agentActionInvocationSchema,
    kind: agentActionKindSchema,
    description: z.string().max(MAX_AGENT_ACTION_DESCRIPTION_LENGTH).optional(),
    argumentHint: z.string().max(120).optional(),
    requiresArguments: z.boolean().default(false),
    source: agentActionSourceSchema,
});

export type AgentAction = z.infer<typeof agentActionSchema>;

export const requiresAgentActionArguments = (argumentHint?: string): boolean =>
    Boolean(argumentHint && !argumentHint.trimStart().startsWith('['));

const command = (invocation: string, description: string, argumentHint?: string): AgentAction => ({
    invocation,
    kind: 'command',
    description,
    ...(argumentHint && { argumentHint }),
    requiresArguments: false,
    source: 'builtIn',
});

/**
 * A deliberately small, non-destructive fallback. Provider menus drift across versions and environments, so everything
 * beyond these common actions comes from bounded discovery or explicit user settings.
 */
export const defaultAgentActions: Record<AgentProvider, readonly AgentAction[]> = {
    grok: [],
    claude: [
        command('/model', 'Choose the active model'),
        command('/compact', 'Summarize the conversation to free context', '[instructions]'),
        command('/diff', 'Review uncommitted and per-turn changes'),
        command('/review', 'Review the current diff', '[target]'),
        command('/context', 'Visualize current context usage', '[all]'),
    ],
    codex: [
        command('/model', 'Choose the active model and reasoning effort'),
        command('/compact', 'Summarize the conversation to free context'),
        command('/diff', 'Show the current Git diff'),
        command('/review', 'Review the current working tree'),
        command('/status', 'Show session configuration and token usage'),
    ],
};

const compareActions = (left: AgentAction, right: AgentAction): number =>
    left.kind === right.kind
        ? left.invocation.localeCompare(right.invocation)
        : left.kind === 'command'
          ? -1
          : 1;

/**
 * Deterministic precedence: curated defaults, discovered provider metadata, then user overrides. A disabled override
 * removes an item regardless of where it originated; a new override becomes a custom command/skill by prefix.
 */
export function mergeAgentActions(
    provider: AgentProvider,
    discovered: readonly AgentAction[],
    settings: Pick<AgentActionsSettings, 'items'>,
): AgentAction[] {
    if (!agentProviderCatalog[provider].capabilities.actions) return [];
    const merged = new Map<string, AgentAction>();
    const defaults = defaultAgentActions[provider];
    for (const action of defaults) merged.set(action.invocation, action);
    for (const action of discovered) merged.set(action.invocation, action);
    for (const [invocation, override] of Object.entries(settings.items)) {
        if (!override.enabled) {
            merged.delete(invocation);
            continue;
        }
        const current = merged.get(invocation);
        const argumentHint = override.argumentHint ?? current?.argumentHint;
        merged.set(invocation, {
            invocation,
            kind: current?.kind ?? (invocation.startsWith('$') ? 'skill' : 'command'),
            description: override.description ?? current?.description,
            argumentHint,
            requiresArguments:
                override.argumentHint === undefined
                    ? (current?.requiresArguments ?? false)
                    : requiresAgentActionArguments(argumentHint),
            source: current?.source ?? 'custom',
        });
    }
    const sorted = sortedCopy(merged.values(), compareActions);
    if (sorted.length <= MAX_AGENT_ACTIONS) return sorted;

    const userInvocations = new Set(
        Object.entries(settings.items).flatMap(([invocation, override]) =>
            override.enabled ? [invocation] : [],
        ),
    );
    const defaultInvocations = new Set(defaults.map((action) => action.invocation));
    const limited = [
        ...sorted.filter((action) => userInvocations.has(action.invocation)),
        ...sorted.filter(
            (action) =>
                !userInvocations.has(action.invocation) &&
                defaultInvocations.has(action.invocation),
        ),
        ...sorted.filter(
            (action) =>
                !userInvocations.has(action.invocation) &&
                !defaultInvocations.has(action.invocation),
        ),
    ].slice(0, MAX_AGENT_ACTIONS);
    return sortedCopy(limited, compareActions);
}

export const agentActionListResultSchema = z.strictObject({
    provider: agentProviderSchema,
    actions: z.array(agentActionSchema).max(MAX_AGENT_ACTIONS),
    /**
     * Skills whose metadata sets `user-invocable: false`: the user cannot start them from a menu, but the Agent still
     * loads and names them, so a reply mentioning one is still marked as that skill. Never offered in a menu.
     */
    referenceOnlySkills: z.array(agentActionInvocationSchema).max(MAX_AGENT_ACTIONS).default([]),
    discovery: z.enum(['complete', 'partial']),
});

/**
 * Discovered action files are read at most 64 KiB, so their Markdown stays inside that bound.
 */
export const MAX_AGENT_ACTION_MARKDOWN_LENGTH = 64 * 1024;

export const agentActionReadResultSchema = z.strictObject({
    invocation: agentActionInvocationSchema,
    kind: agentActionKindSchema,
    description: z.string().max(MAX_AGENT_ACTION_DESCRIPTION_LENGTH).optional(),
    /**
     * The file's Markdown without its frontmatter.
     */
    markdown: z.string().max(MAX_AGENT_ACTION_MARKDOWN_LENGTH),
});

export const agentActionMethods = {
    'agentActions.list': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({ terminalId: identifierSchema }),
        result: agentActionListResultSchema,
    },
    'agentActions.read': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({
            terminalId: identifierSchema,
            invocation: agentActionInvocationSchema,
        }),
        result: agentActionReadResultSchema,
    },
    'agentActions.recordRecent': {
        ...commandPolicy('server', 'write'),
        params: z.strictObject({
            terminalId: identifierSchema,
            invocation: agentActionInvocationSchema,
        }),
        result: agentActionRecentSettingsSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type AgentActionListResult = z.infer<typeof agentActionListResultSchema>;
export type AgentActionReadResult = z.infer<typeof agentActionReadResultSchema>;

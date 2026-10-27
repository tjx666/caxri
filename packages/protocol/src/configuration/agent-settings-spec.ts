import { agentProviderIds } from '../agent/agents.js';
import {
    DEFAULT_AGENT_SESSION_INSTRUCTIONS,
    MAX_AGENT_SESSION_INSTRUCTIONS_LENGTH,
} from './agent-session-instructions.js';
import type { SettingSpec } from './settings-spec.js';

/**
 * The Agents category's own settings: providers, lifecycle hooks, background commands, Session instructions, and
 * delegation. `settingsSpec` spreads them in place, so their order on the Settings page is unchanged.
 */
export const agentSettingsSpec = [
    {
        kind: 'complex',
        key: 'agents.providers',
        title: 'Agent providers',
        description:
            'Launch commands, lifecycle hooks, peer messaging, and output recovery per Agent provider',
        category: 'agents',
        keywords: [
            ...agentProviderIds,
            'executable',
            'launch',
            'hooks',
            'messaging',
            'network',
            'recovery',
            'timeout',
        ],
    },
    {
        kind: 'boolean',
        key: 'agents.suggestLifecycleHooks',
        title: 'Suggest lifecycle hooks',
        description:
            "Offer to turn on a provider's lifecycle hooks when its Agent runs in a Terminal without them. Chats never need them",
        category: 'agents',
        keywords: ['hooks', 'lifecycle', 'suggest', 'prompt', 'terminal', ...agentProviderIds],
        default: true,
    },
    {
        kind: 'complex',
        key: 'agents.longRunningShellCommands',
        title: 'Long-running background commands',
        description:
            "Commands that keep running on purpose, like a dev server. Caxri won't wait for them to finish before treating the Agent's turn as done",
        category: 'agents',
        keywords: [
            'background',
            'shell',
            'command',
            'dev server',
            'pattern',
            'running',
            'wait',
            'bash',
        ],
    },
    {
        kind: 'string',
        key: 'agents.sessionInstructions',
        title: 'Session instructions',
        description:
            "Added after each Agent's own system prompt when it starts, so it knows it runs inside Caxri and how to start work in another Session. Clear it to add nothing; changes apply to Agents started afterward",
        category: 'agents',
        keywords: ['prompt', 'system prompt', 'instructions', 'context', 'caxri cli', 'session'],
        nullable: true,
        multiline: true,
        preset: DEFAULT_AGENT_SESSION_INSTRUCTIONS,
        maxLength: MAX_AGENT_SESSION_INSTRUCTIONS_LENGTH,
        default: null,
    },
    {
        kind: 'complex',
        key: 'agents.delegation',
        title: 'Agent delegation',
        description: 'Named delegation presets, caller bindings and maximum delegation depth',
        category: 'agents',
        keywords: ['presets', 'delegation', 'model', 'effort', 'depth', 'caller'],
    },
] as const satisfies readonly SettingSpec[];

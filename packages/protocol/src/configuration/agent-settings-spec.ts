import { agentProviderIds } from '../agent/agents.js';
import { MAX_AGENT_SESSION_INSTRUCTIONS_LENGTH } from './agent-session-instructions.js';
import type { SettingSpec } from './settings-spec.js';

const SESSION_INSTRUCTION_KEYWORDS = [
    'prompt',
    'system prompt',
    'instructions',
    'context',
    'caxri cli',
    'session',
];

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
        kind: 'boolean',
        key: 'agents.sessionInstructions.includeBuiltIn',
        title: 'Caxri Session instructions',
        description:
            "Add Caxri's built-in instructions after each Agent's own system prompt, so it knows it runs inside Caxri and how to start work in another Session. They update with Caxri; changes apply to Agents started afterward",
        category: 'agents',
        keywords: SESSION_INSTRUCTION_KEYWORDS,
        default: true,
    },
    {
        kind: 'string',
        key: 'agents.sessionInstructions.custom',
        title: 'Custom Session instructions',
        description:
            "Your own instructions, added after Caxri's. Leave empty to add nothing; changes apply to Agents started afterward",
        category: 'agents',
        keywords: SESSION_INSTRUCTION_KEYWORDS,
        nullable: true,
        multiline: true,
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

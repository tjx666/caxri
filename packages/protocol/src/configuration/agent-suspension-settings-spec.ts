import type { SettingSpec } from './settings-spec.js';

/**
 * Agent suspension's settings, kept beside the main catalog so `settingsSpec` stays within the source-size ratchet.
 * `settingsSpec` spreads them in place, so their order on the Settings page is unchanged. The rows live under Agents
 * although their keys keep the `terminal.` prefix: they decide when an Agent is suspended, which is where a user
 * looking for "why did my Agent restart" goes. Renaming the keys would orphan every value already written to
 * `settings.jsonc`.
 */
export const agentSuspensionSettingsSpec = [
    {
        kind: 'boolean',
        key: 'terminal.suspendUntouchedAgents',
        title: 'Suspend Agents you opened but never used',
        description:
            'Suspends an Agent you never typed into once you switch to another Session, to save memory. It picks up where it left off when you come back.',
        category: 'agents',
        keywords: ['agent', 'suspend', 'untouched', 'idle', 'background', 'memory', 'resume'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'terminal.idleSuspension.enabled',
        title: 'Suspend idle Agents in the background',
        description:
            'Suspends an Agent that finished its work and waited in a Session you are not viewing, to save memory. It picks up where it left off when you come back.',
        category: 'agents',
        keywords: [
            'agent',
            'suspend',
            'idle',
            'background',
            'memory',
            'resume',
            'hibernate',
            'sleep',
        ],
        default: false,
    },
    {
        kind: 'integer',
        key: 'terminal.idleSuspension.afterMinutes',
        title: 'Suspend idle Agents after',
        description:
            'How long an Agent waits, in a Session you are not viewing, before it is suspended. Used only while Suspend idle Agents in the background is on. A long Chat that is about to be summarized while idle keeps running until the summary is done.',
        category: 'agents',
        keywords: ['agent', 'suspend', 'idle', 'timeout', 'delay', 'hibernate', 'sleep'],
        min: 1,
        max: 1_440,
        default: 30,
        display: { unit: 'minutes' },
    },
] as const satisfies readonly SettingSpec[];

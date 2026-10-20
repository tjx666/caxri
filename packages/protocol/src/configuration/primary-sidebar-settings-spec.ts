import type { SettingSpec } from './settings-spec.js';

/**
 * The primary sidebar's General settings, kept beside the main catalog so `settingsSpec` stays within the source-size
 * ratchet. `settingsSpec` spreads them in place, so their order on the Settings page is unchanged.
 */
export const primarySidebarSettingsSpec = [
    {
        kind: 'enum',
        key: 'primarySidebar.autoCollapseProjects',
        title: 'Auto-collapse inactive Projects',
        description: 'Keeps active, working, unread, and manually expanded Projects open',
        category: 'general',
        keywords: ['primarySidebar', 'project', 'collapse', 'inactive', 'idle'],
        options: [
            { value: 'off', label: 'Off' },
            { value: '30m', label: 'After 30 minutes' },
            { value: '2h', label: 'After 2 hours' },
        ],
        default: '30m',
    },
    {
        kind: 'boolean',
        key: 'primarySidebar.showSubagents',
        title: 'Show subagents under Sessions',
        description:
            'Lists the subagents a Chat Agent started as indented rows under its Session in the Primary Side Bar',
        category: 'general',
        keywords: ['primarySidebar', 'subagent', 'nested', 'task', 'child', 'hide'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'primarySidebar.translucent',
        title: 'Translucent sidebar',
        description:
            'On macOS, blur the desktop through the sidebar like frosted glass when the theme matches the system light or dark appearance.',
        category: 'general',
        keywords: [
            'primarySidebar',
            'vibrancy',
            'frosted',
            'glass',
            'blur',
            'transparent',
            'appearance',
        ],
        default: true,
    },
] as const satisfies readonly SettingSpec[];

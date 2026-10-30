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
        description: 'Active, working, unread, and expanded Projects stay open.',
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
        description: "List a Chat Agent's subagents under its Session.",
        category: 'general',
        keywords: ['primarySidebar', 'subagent', 'nested', 'task', 'child', 'hide'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'primarySidebar.translucent',
        title: 'Translucent sidebar',
        description: 'Blur the desktop through the sidebar while the theme matches macOS.',
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

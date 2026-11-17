import type { SettingSpec } from './settings-spec.js';

/**
 * The settings that let Caxri run unattended (docs/unattended-mode.md), kept beside the main catalog so `settingsSpec`
 * stays within the source-size ratchet. Both default on: leaving Agents running overnight is the common case.
 */
export const unattendedSettingsSpec = [
    {
        kind: 'boolean',
        key: 'power.keepAwakeWhileAgentsWork',
        title: 'Keep Mac awake while Agents work',
        description:
            "Stops your Mac from sleeping while an Agent is working or waiting for your plan's limit to reset. The screen can still turn off, and closing the lid on battery still puts the Mac to sleep.",
        category: 'general',
        keywords: ['sleep', 'caffeinate', 'awake', 'power', 'night', 'unattended', 'background'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'window.menuBarWhenClosed',
        title: 'Keep running in the menu bar',
        description:
            'When you close the window while work is running, hide the Dock icon and keep Caxri in the menu bar.',
        category: 'general',
        keywords: ['tray', 'menu bar', 'dock', 'background', 'close', 'unattended', 'status item'],
        default: true,
    },
] as const satisfies readonly SettingSpec[];

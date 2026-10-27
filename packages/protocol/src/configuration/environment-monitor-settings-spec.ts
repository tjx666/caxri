import type { SettingSpec } from './settings-spec.js';

/**
 * Independent, opt-in environment signals. Public IP changes are the only default so a fresh install does not assign
 * meaning to location, proxy, time-zone, or probe-availability differences the user did not choose to monitor.
 */
export const environmentMonitorSettingsSpec = [
    {
        kind: 'boolean',
        key: 'environmentMonitor.publicIpChanges',
        title: 'Public IP changes',
        description:
            'Monitor the public egress IP and show a notification plus status bar warning when it changes.',
        category: 'notifications',
        keywords: ['environment', 'network', 'egress', 'internet', 'address'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'environmentMonitor.proxyProtection',
        title: 'Local proxy interruptions',
        description:
            'Check whether a configured loopback proxy remains reachable and whether its route changes.',
        category: 'notifications',
        keywords: ['environment', 'network', 'proxy', 'vpn', 'tun', 'listener', 'route'],
        default: false,
    },
    {
        kind: 'boolean',
        key: 'environmentMonitor.locationChanges',
        title: 'Network location changes',
        description: 'Compare the country and region reported for the public egress IP.',
        category: 'notifications',
        keywords: ['environment', 'network', 'country', 'region', 'location'],
        default: false,
    },
    {
        kind: 'boolean',
        key: 'environmentMonitor.timeZoneMismatch',
        title: 'Network time-zone mismatch',
        description:
            'Compare the current UTC offset of the network location with the system time zone.',
        category: 'notifications',
        keywords: ['environment', 'network', 'timezone', 'time zone', 'utc', 'offset'],
        default: false,
    },
    {
        kind: 'boolean',
        key: 'environmentMonitor.checkUnavailable',
        title: 'Environment check unavailable',
        description: 'Notify after several consecutive environment checks cannot complete.',
        category: 'notifications',
        keywords: ['environment', 'network', 'offline', 'failure', 'unavailable'],
        default: false,
    },
] as const satisfies readonly SettingSpec[];

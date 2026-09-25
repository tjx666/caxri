import type { Capability, MobileDeviceRole } from '@caxri/protocol';

/**
 * Keep dispatcher capabilities no broader than the paired device role.
 */
export const mobileCapabilitiesByRole = {
    view: ['projects.read', 'sessions.read', 'terminals.read', 'terminals.preview'],
    reply: [
        'projects.read',
        'sessions.read',
        'sessions.write',
        'terminals.read',
        'terminals.preview',
        'terminals.steer',
    ],
    control: [
        'projects.read',
        'sessions.read',
        'sessions.write',
        'terminals.read',
        'terminals.preview',
        'terminals.steer',
        'agents.control',
    ],
} as const satisfies Record<MobileDeviceRole, readonly Capability[]>;

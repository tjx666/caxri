import type { Capability, MobileDeviceRole } from '@caxri/protocol';

/**
 * Keep dispatcher capabilities no broader than the paired device role.
 */
export const mobileCapabilitiesByRole = {
    view: ['projects.read', 'sessions.read', 'files.read', 'terminals.read', 'terminals.preview'],
    reply: [
        'projects.read',
        'sessions.read',
        'sessions.write',
        'files.read',
        'terminals.read',
        'terminals.preview',
        'terminals.steer',
    ],
    control: [
        'projects.read',
        'projects.write',
        'sessions.read',
        'sessions.write',
        'files.read',
        'files.write',
        'terminals.read',
        'terminals.preview',
        'terminals.steer',
        'agents.control',
    ],
} as const satisfies Record<MobileDeviceRole, readonly Capability[]>;

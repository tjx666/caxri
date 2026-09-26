import type { MobileDeviceRole } from '@caxri/protocol';

const mobileReadOnlyPanelMethods = [
    'mobile.panels.list',
    'mobile.tree.children',
    'mobile.files.list',
    'mobile.files.read',
] as const;

/**
 * The explicit method set each paired-device role may call. A role grant never authorizes a resource by itself; the
 * access controller still resolves every Project, Session, and Terminal through principal-scoped queries.
 */
const mobileGatewayMethodsByRole = {
    view: [
        'mobile.dashboard',
        'mobile.session.show',
        'mobile.timeline.read',
        'mobile.changes.list',
        'mobile.changes.diff',
        'mobile.agent.availability',
        'mobile.session.archived',
        'terminal.preview',
        ...mobileReadOnlyPanelMethods,
    ],
    reply: [
        'mobile.dashboard',
        'mobile.session.show',
        'mobile.timeline.read',
        'mobile.changes.list',
        'mobile.changes.diff',
        'mobile.agent.availability',
        'mobile.session.archived',
        'terminal.preview',
        'session.markRead',
        'mobile.agent.submit',
        ...mobileReadOnlyPanelMethods,
    ],
    control: [
        'mobile.dashboard',
        'mobile.session.show',
        'mobile.timeline.read',
        'mobile.changes.list',
        'mobile.changes.diff',
        'mobile.agent.availability',
        'terminal.preview',
        'session.markRead',
        'mobile.agent.submit',
        'agent.control.interrupt',
        'mobile.session.archived',
        'mobile.session.create',
        'mobile.session.rename',
        'mobile.session.archive',
        'mobile.session.restore',
        'mobile.terminal.takeOver',
        'mobile.terminal.release',
        'mobile.terminal.input',
        'mobile.project.browse',
        'mobile.project.add',
        ...mobileReadOnlyPanelMethods,
    ],
} as const satisfies Record<MobileDeviceRole, readonly string[]>;

export const isMobileGatewayMethodAllowedForRole = (
    role: MobileDeviceRole,
    method: string,
): boolean => (mobileGatewayMethodsByRole[role] as readonly string[]).includes(method);

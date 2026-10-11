import type { MobileDeviceRole } from '@caxri/protocol';

const mobileEveryRoleMethods = [
    'mobile.panels.list',
    'mobile.tree.children',
    'mobile.files.list',
    'mobile.files.read',
    'mobile.files.search',
    'mobile.attention.list',
    /**
     * Every paired role may update its own app; the bundle is Desktop's public build artifact, not Project data.
     */
    'mobile.update.check',
    'mobile.update.prepare',
] as const;

/**
 * The explicit method set each paired-device role may call. A role grant never authorizes a resource by itself; the
 * access controller still resolves every Project, Session, and Terminal through principal-scoped queries.
 */
const mobileGatewayMethodsByRole = {
    view: [
        'mobile.dashboard',
        'mobile.agentChat.read',
        'mobile.agentChat.readImage',
        'mobile.session.show',
        'mobile.timeline.read',
        'mobile.changes.list',
        'mobile.changes.diff',
        'mobile.agent.availability',
        'mobile.agent.actions',
        'mobile.session.archived',
        'terminal.preview',
        ...mobileEveryRoleMethods,
    ],
    reply: [
        'mobile.dashboard',
        'mobile.agentChat.read',
        'mobile.agentChat.readImage',
        /**
         * Sending is a reply device's whole job; Retry only resumes a failed Chat so that reply can be delivered.
         */
        'mobile.agentChat.send',
        'mobile.agentChat.retry',
        /**
         * The model and effort decide how the reply device's own next message runs, so choosing them belongs with
         * sending it, as the Desktop composer keeps the picker beside the input.
         */
        'mobile.agentChat.configure',
        'mobile.session.show',
        'mobile.timeline.read',
        'mobile.changes.list',
        'mobile.changes.diff',
        'mobile.agent.availability',
        'mobile.agent.actions',
        'mobile.session.archived',
        'terminal.preview',
        'session.markRead',
        'mobile.agent.submit',
        'mobile.image.upload',
        ...mobileEveryRoleMethods,
    ],
    control: [
        'mobile.dashboard',
        'mobile.agentChat.read',
        'mobile.agentChat.readImage',
        'mobile.agentChat.send',
        'mobile.agentChat.retry',
        'mobile.agentChat.configure',
        /**
         * Approvals, answers, and Stop match `mobile.attention.answer` and `agent.control.interrupt`: control only.
         */
        'mobile.agentChat.respond',
        'mobile.agentChat.interrupt',
        'mobile.session.show',
        'mobile.timeline.read',
        'mobile.changes.list',
        'mobile.changes.diff',
        'mobile.agent.availability',
        'mobile.agent.actions',
        'terminal.preview',
        'session.markRead',
        'mobile.agent.submit',
        'mobile.image.upload',
        'agent.control.interrupt',
        'mobile.session.archived',
        'mobile.session.create',
        'mobile.session.rename',
        'mobile.session.archive',
        'mobile.session.restore',
        'mobile.terminal.takeOver',
        'mobile.terminal.release',
        'mobile.terminal.input',
        'mobile.terminal.scroll',
        'mobile.project.browse',
        'mobile.project.add',
        'mobile.files.write',
        'mobile.attention.answer',
        /**
         * "Always allow in this Session" (issue caxri#1295) is control-only, matching `mobile.attention.answer`'s grant
         * path; `view` and `reply` devices keep their read-only rules.
         */
        'mobile.attention.autoAllowRevoke',
        /**
         * The Commander Inbox spans every Project, not only this device's grant, so it stays with the role that can
         * already browse the whole Mac (`mobile.project.browse`).
         */
        'mobile.commanderInbox.list',
        'mobile.commanderInbox.reply',
        ...mobileEveryRoleMethods,
    ],
} as const satisfies Record<MobileDeviceRole, readonly string[]>;

export const isMobileGatewayMethodAllowedForRole = (
    role: MobileDeviceRole,
    method: string,
): boolean => (mobileGatewayMethodsByRole[role] as readonly string[]).includes(method);

import type { MobileDeviceRole } from '@caxri/protocol';

const mobileEveryRoleMethods = [
    'mobile.panels.list',
    'mobile.tree.children',
    'mobile.files.list',
    'mobile.files.read',
    'mobile.files.search',
    'mobile.attention.list',
    'mobile.pullRequest.read',
    /**
     * Plan limits and public status pages are account facts; the speed source is chosen among this device's Sessions.
     */
    'mobile.agentUsage.read',
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
        'mobile.agentChat.requests',
        'mobile.agentChat.readImage',
        'mobile.agentChat.readTask',
        'mobile.agentChat.readHistory',
        'mobile.agentChat.readUsage',
        'mobile.agentChat.dismissPlanPace',
        'mobile.agentChat.readMessage',
        'mobile.session.show',
        'mobile.timeline.read',
        'mobile.timeline.readMessage',
        'mobile.changes.list',
        'mobile.changes.diff',
        'mobile.agent.availability',
        'mobile.agent.actions',
        'mobile.session.archived',
        'mobile.session.search',
        'terminal.preview',
        ...mobileEveryRoleMethods,
    ],
    reply: [
        'mobile.dashboard',
        'mobile.agentChat.read',
        'mobile.agentChat.requests',
        'mobile.agentChat.readImage',
        'mobile.agentChat.readTask',
        'mobile.agentChat.readHistory',
        'mobile.agentChat.readUsage',
        'mobile.agentChat.dismissPlanPace',
        'mobile.agentChat.readMessage',
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
        /**
         * Deleting, steering with, or resuming a queued follow-up acts on messages this device could have sent, so it
         * carries the same grant as sending them, as the Desktop queue sits above the composer.
         */
        'mobile.agentChat.removeQueued',
        'mobile.agentChat.sendQueuedNow',
        'mobile.agentChat.resumeQueue',
        /**
         * Edit takes the message out of the queue for this device to send again (or rewrites it where it stands), so it
         * needs the same grant; reading the text to edit rides with it.
         */
        'mobile.agentChat.takeQueued',
        'mobile.agentChat.readQueued',
        'mobile.agentChat.editQueued',
        /**
         * "Edit from here" replaces a message this device could have sent and sends the new one, so it carries the
         * sending grant, as an edited queued message does.
         */
        'mobile.agentChat.rewind',
        /**
         * A slash command is typed and sent from the composer like a message, so it carries the sending grant.
         */
        'mobile.agentChat.runCommand',
        'mobile.session.show',
        'mobile.timeline.read',
        'mobile.timeline.readMessage',
        'mobile.changes.list',
        'mobile.changes.diff',
        'mobile.agent.availability',
        'mobile.agent.actions',
        'mobile.session.archived',
        'mobile.session.search',
        'terminal.preview',
        'session.markRead',
        'mobile.agent.submit',
        'mobile.image.upload',
        'mobile.file.upload',
        /**
         * Citing another Session with `@` belongs to writing a message, so it carries the reply grant.
         */
        'mobile.session.conversationReference',
        ...mobileEveryRoleMethods,
    ],
    control: [
        'mobile.dashboard',
        'mobile.agentChat.read',
        'mobile.agentChat.requests',
        'mobile.agentChat.readImage',
        'mobile.agentChat.readTask',
        'mobile.agentChat.readHistory',
        'mobile.agentChat.readUsage',
        'mobile.agentChat.dismissPlanPace',
        'mobile.agentChat.readMessage',
        'mobile.agentChat.send',
        'mobile.agentChat.retry',
        'mobile.agentChat.configure',
        'mobile.agentChat.removeQueued',
        'mobile.agentChat.sendQueuedNow',
        'mobile.agentChat.resumeQueue',
        'mobile.agentChat.takeQueued',
        'mobile.agentChat.readQueued',
        'mobile.agentChat.editQueued',
        'mobile.agentChat.rewind',
        'mobile.agentChat.runCommand',
        /**
         * Approvals, answers, and Stop match `mobile.attention.answer` and `agent.control.interrupt`: control only.
         */
        'mobile.agentChat.respond',
        'mobile.agentChat.implementPlan',
        'mobile.agentChat.interrupt',
        /**
         * Stopping a background task is Stop for one piece of the Agent's work, so it carries Stop's grant.
         */
        'mobile.agentChat.stopTask',
        'mobile.session.show',
        'mobile.timeline.read',
        'mobile.timeline.readMessage',
        'mobile.changes.list',
        'mobile.changes.diff',
        'mobile.agent.availability',
        'mobile.agent.actions',
        'terminal.preview',
        'session.markRead',
        'mobile.agent.submit',
        'mobile.image.upload',
        'mobile.file.upload',
        'mobile.session.conversationReference',
        'agent.control.interrupt',
        'mobile.session.archived',
        'mobile.session.search',
        'mobile.session.create',
        'mobile.session.rename',
        'mobile.session.archive',
        'mobile.session.restore',
        'mobile.session.setPinned',
        /**
         * Deleting removes the Session's metadata for good, so it stays with the role that can already archive it.
         * Rename with AI only fills the rename field, so it rides with Rename.
         */
        'mobile.session.delete',
        'mobile.session.suggestTitle',
        /**
         * Fork and Continue in Another Agent start an Agent in a new Session, as `mobile.session.create` does, so they
         * carry its grant; the targets read only feeds the continue menu.
         */
        'mobile.agentChat.fork',
        'mobile.agentChat.continuationTargets',
        'mobile.agentChat.continueInAgent',
        /**
         * Merging publishes the Session's work on GitHub and cannot be undone from Caxri, so it carries the control
         * grant, like archiving the Session that produced it.
         */
        'mobile.pullRequest.merge',
        'mobile.terminal.takeOver',
        'mobile.terminal.release',
        'mobile.terminal.input',
        'mobile.terminal.scroll',
        /**
         * Switching replaces the Agent's process and may stop its running turn, so it carries Stop's grant.
         */
        'mobile.terminal.switchSurface',
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
         * The Bot Inbox spans every Project, not only this device's grant, so it stays with the role that can already
         * browse the whole Mac (`mobile.project.browse`).
         */
        'mobile.botInbox.list',
        'mobile.botInbox.reply',
        /**
         * Computer status names Sessions from every Project and the Mac's busiest processes, so it stays with the role
         * that already sees the whole Mac.
         */
        'mobile.host.status',
        /**
         * A preview proxies every HTTP method to a local web server, so it can change that server's state like a
         * browser on the computer; it stays with the role that already drives Terminals.
         */
        'mobile.preview.list',
        'mobile.preview.open',
        ...mobileEveryRoleMethods,
    ],
} as const satisfies Record<MobileDeviceRole, readonly string[]>;

export const isMobileGatewayMethodAllowedForRole = (
    role: MobileDeviceRole,
    method: string,
): boolean => (mobileGatewayMethodsByRole[role] as readonly string[]).includes(method);

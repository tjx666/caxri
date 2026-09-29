import { z } from 'zod';

import { agentActionSchema } from '../agent/agent-action-contract.js';
import { agentEndpointRefSchema as agentEndpointReferenceSchema } from '../agent/agent-endpoint-contract.js';
import { hexColorSchema } from '../domain/color.js';
import {
    canceledResultSchema,
    fileEntrySchema,
    identifierSchema,
    pathSchema,
    permissionAutoAllowStatusSchema,
    scopedProjectSchema,
    sessionRecordSchema,
    terminalKindSchema,
    terminalRecordSchema,
} from '../domain/domain.js';
import { sessionRenameTitleSchema } from '../domain/session.js';
import { viewIdSchema } from '../domain/views.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { principalSchema } from '../transport/principal.js';
import { mobileDeviceRoleSchema } from './device-role.js';
import {
    mobileAttentionAnswerParametersSchema,
    mobileAttentionRequestSchema,
} from './mobile-attention-contract.js';
import {
    mobileChangesDiffResultSchema,
    mobileChangesListResultSchema,
} from './mobile-changes-contract.js';
import { MOBILE_FILES_MAX_ENTRIES, MOBILE_FILES_READ_MAX_BYTES } from './mobile-file-limits.js';
import { mobileTerminalMethods } from './mobile-terminal-contract.js';
import { mobileUpdateMethods } from './mobile-update-contract.js';

export type { MobileDeviceRole } from './device-role.js';
export { mobileDeviceRoleSchema } from './device-role.js';
export * from './mobile-attention-contract.js';
export * from './mobile-changes-contract.js';
export { MOBILE_FILES_MAX_ENTRIES, MOBILE_FILES_READ_MAX_BYTES } from './mobile-file-limits.js';
export * from './mobile-terminal-contract.js';
export * from './mobile-update-contract.js';

const noParameters = z.strictObject({}).default({});
export const mobileDeviceIdSchema = z.string().regex(/^device_[0-9a-f]{32}$/u);
export const MOBILE_MAX_PROJECT_GRANTS = 128;
export const MOBILE_SHORT_REPLY_MAX_BYTES = 1_024;
export const MOBILE_AGENT_SUBMIT_MAX_BYTES = 16 * 1_024;
export const mobileAttachmentIdSchema = z.string().regex(/^image_[0-9a-f]{32}$/u);
export const MOBILE_PROJECT_BROWSE_MAX_ENTRIES = 200;
export const MOBILE_PANELS_MAX_CONTAINERS = 64;
export const MOBILE_PANELS_MAX_VIEWS = 32;
export const MOBILE_TREE_MAX_ITEMS = 500;
export const mobileProjectIdsSchema = z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(MOBILE_MAX_PROJECT_GRANTS)
    .refine(
        (projectIds) => new Set(projectIds).size === projectIds.length,
        'Project grants must be unique',
    );

export const mobileDeviceSummarySchema = z.strictObject({
    deviceId: mobileDeviceIdSchema,
    displayName: z.string().trim().min(1).max(100),
    platform: z.enum(['android', 'ios']),
    generation: z.number().int().positive(),
    role: mobileDeviceRoleSchema,
    projectIds: mobileProjectIdsSchema,
    createdAt: z.number().int().positive(),
    lastConnectedAt: z.number().int().positive().optional(),
    revokedAt: z.number().int().positive().optional(),
});

export const mobileAccessStatusSchema = z.strictObject({
    enabled: z.boolean(),
    address: z.ipv4().optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    pairedDeviceCount: z.number().int().nonnegative().max(128),
    pendingPairingCount: z.number().int().nonnegative().max(8),
});

export const mobileDashboardSessionSchema = z.strictObject({
    id: identifierSchema,
    projectId: identifierSchema,
    displayTitle: z.string().min(1).max(100),
    projectTitle: z.string().min(1).max(100),
    lastOpenedAt: sessionRecordSchema.shape.lastOpenedAt,
    lastActivityState: sessionRecordSchema.shape.lastActivityState,
    primaryAgentTerminalId: identifierSchema.optional(),
    primaryAgentEndpoint: agentEndpointReferenceSchema.optional(),
    attentionEpoch: sessionRecordSchema.shape.attentionEpoch,
    hasUnread: sessionRecordSchema.shape.hasUnread,
    primaryTerminal: terminalRecordSchema
        .pick({
            id: true,
            sessionId: true,
            kind: true,
            provider: true,
            lastProcessState: true,
            failureReason: true,
        })
        .optional(),
});

/**
 * An archived Session as the phone's Archived Sessions list shows it. Archived Sessions have no live Terminal, so only
 * the primary Agent's kind is projected, for the row's avatar.
 */
export const mobileArchivedSessionSchema = z.strictObject({
    id: identifierSchema,
    projectId: identifierSchema,
    displayTitle: z.string().min(1).max(100),
    projectTitle: z.string().min(1).max(100),
    archivedAt: z.number().int().nonnegative(),
    agentKind: terminalKindSchema.optional(),
});

export const MOBILE_ARCHIVED_SESSIONS_MAX = 64;

export const mobileArchivedSessionsResultSchema = z.strictObject({
    sessions: z.array(mobileArchivedSessionSchema).max(MOBILE_ARCHIVED_SESSIONS_MAX),
    total: z.number().int().nonnegative().max(4_096),
    truncated: z.boolean(),
});

/**
 * Session management from a phone returns only the affected identity; the dashboard subscription carries the new state.
 */
export const mobileSessionMutationResultSchema = z.strictObject({ sessionId: identifierSchema });

export const mobileProjectSummarySchema = scopedProjectSchema.extend({
    lastActivityAt: z.number().int().nonnegative().optional(),
});

export const mobileDashboardResultSchema = z.strictObject({
    hostDisplayName: z.string().trim().min(1).max(100),
    deviceRole: z.enum(['view', 'reply', 'control']).nullable(),
    projects: z.array(mobileProjectSummarySchema).max(MOBILE_MAX_PROJECT_GRANTS),
    sessions: z.array(mobileDashboardSessionSchema).max(64),
    total: z.number().int().nonnegative().max(4_096),
    truncated: z.boolean(),
});

export const mobileSessionCreateResultSchema = z.strictObject({
    sessionId: identifierSchema,
    terminalId: identifierSchema.optional(),
    launchError: z
        .strictObject({
            code: z.literal('TERMINAL_START_FAILED'),
            message: z.string().min(1).max(256),
        })
        .optional(),
});

export const mobileAgentSubmitParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    terminalId: identifierSchema,
    endpoint: agentEndpointReferenceSchema,
    clientMutationId: identifierSchema,
    attachmentIds: z.array(mobileAttachmentIdSchema).max(3).optional(),
    text: z
        .string()
        .min(1)
        .refine(
            (value) =>
                value.trim().length > 0 &&
                new TextEncoder().encode(value).length <= MOBILE_AGENT_SUBMIT_MAX_BYTES &&
                ![...value].some((character) => {
                    const code = character.codePointAt(0)!;
                    return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159);
                }),
            'Mobile Agent input must be bounded multiline text without control characters',
        ),
});

export const mobileImageUploadParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    attachmentId: mobileAttachmentIdSchema,
    chunkIndex: z.number().int().min(0).max(191),
    chunkCount: z.number().int().min(1).max(192),
    chunk: z
        .string()
        .min(4)
        .max(24_576)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
});

export const mobileAgentSubmitResultSchema = z.strictObject({
    terminalId: identifierSchema,
    outcome: z.enum(['accepted', 'unknown']),
});

const timelineItemBase = {
    id: z.string().min(1).max(128),
    timestamp: z.number().int().nonnegative().optional(),
};

/**
 * Harness-injected content the provider CLI writes into the transcript on the user's turn, never text the reader typed.
 * `taskNotification` is a background Agent completion; `slashCommand` is a `/command` echo, including its stdout when
 * the harness inlines one; `bashCommand` is a `!`-prefixed shell echo with its stdout/stderr; `caveat` is a one-line
 * harness disclaimer attached to a slash command. `systemReminder` content never reaches the timeline as an item; a
 * turn made of only a system reminder is dropped instead of rendered.
 */
export const agentSystemEventStatusSchema = z.enum([
    'completed',
    'failed',
    'killed',
    'running',
    'unknown',
]);

export const agentSystemEventKindSchema = z.enum([
    'taskNotification',
    'slashCommand',
    'bashCommand',
    'caveat',
]);

export const agentTimelineItemSchema = z.discriminatedUnion('type', [
    z.strictObject({
        ...timelineItemBase,
        type: z.literal('userMessage'),
        text: z.string().min(1).max(32_768),
    }),
    z.strictObject({
        ...timelineItemBase,
        type: z.literal('agentMessage'),
        text: z.string().min(1).max(32_768),
    }),
    z.strictObject({
        ...timelineItemBase,
        type: z.literal('toolCall'),
        name: z.string().min(1).max(100),
        summary: z.string().min(1).max(240),
        status: z.enum(['running', 'succeeded', 'failed']),
        durationMs: z.number().int().nonnegative().optional(),
        detail: z.string().max(2_048).optional(),
    }),
    z.strictObject({
        ...timelineItemBase,
        type: z.literal('turnBoundary'),
        durationMs: z.number().int().nonnegative().optional(),
    }),
    z.strictObject({
        ...timelineItemBase,
        type: z.literal('systemEvent'),
        kind: agentSystemEventKindSchema,
        summary: z.string().min(1).max(240),
        /**
         * Outcome a `taskNotification` reports; absent for event kinds that carry no outcome.
         */
        status: agentSystemEventStatusSchema.optional(),
        detail: z.string().max(2_048).optional(),
    }),
]);

export const mobileTimelineReadParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    before: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(80).default(40),
});

export const mobileTimelineReadResultSchema = z.strictObject({
    status: z.enum(['available', 'unsupported', 'missing']),
    items: z.array(agentTimelineItemSchema).max(80),
    olderCursor: z.string().min(1).max(128).optional(),
    truncated: z.boolean(),
    cursorExpired: z.boolean(),
});

const mobileAgentAvailabilitySchema = z.strictObject({
    kind: terminalKindSchema,
    available: z.boolean(),
    reason: z.string().min(1).max(200).optional(),
});
const mobileAgentAvailabilityResultSchema = z.strictObject({
    agents: z.array(mobileAgentAvailabilitySchema).length(4),
});

/**
 * Accepts either a path relative to the Mac user's home directory or an opaque absolute path; the Server validates that
 * the resolved, symlink-followed target stays inside the home directory before it touches the filesystem.
 */
const mobileHomePathSchema = z.string().min(1).max(4_096);

export const mobileProjectBrowseParametersSchema = z.strictObject({
    path: mobileHomePathSchema.optional(),
});

export const mobileProjectBrowseEntrySchema = z.strictObject({
    name: z.string().min(1).max(255),
    relativePath: z.string().min(1).max(4_096),
    isGitRepository: z.boolean(),
    hasChildren: z.boolean(),
});

export const mobileProjectBrowseResultSchema = z.strictObject({
    entries: z.array(mobileProjectBrowseEntrySchema).max(MOBILE_PROJECT_BROWSE_MAX_ENTRIES),
    truncated: z.boolean(),
});

export const mobileProjectAddParametersSchema = z.strictObject({ path: mobileHomePathSchema });

export const mobileProjectAddResultSchema = z.strictObject({
    project: mobileProjectSummarySchema,
});

/**
 * Bounded stand-in for the full {@link import('../domain/views.js').viewIconSchema}: a `resource` (data URL) icon is
 * dropped rather than projected, since every core-contributed secondary-sidebar container uses a `builtin` or `theme`
 * icon today and an extension-supplied image is not yet part of the mobile read surface.
 */
const mobilePanelIconSchema = z.strictObject({
    kind: z.enum(['builtin', 'theme']),
    id: z.string().min(1).max(100),
    /**
     * The same externally owned glyph tint as `viewIconSchema`'s theme `color`, such as a Linear workflow state.
     */
    color: hexColorSchema.optional(),
});

export const mobilePanelsListParametersSchema = z.strictObject({ sessionId: identifierSchema });

/**
 * How a phone renders a secondary-sidebar view: `files` browses the Project with `mobile.files.*`, `changes` is the Git
 * source-control view served by `mobile.changes.*`, `tree` reads `mobile.tree.children`, and `unsupported` is a
 * Desktop-only view the phone lists but cannot show.
 */
export const mobilePanelViewKindSchema = z.enum(['files', 'changes', 'tree', 'unsupported']);

const mobilePanelViewSchema = z.strictObject({
    id: viewIdSchema,
    title: z.string().min(1).max(200),
    kind: mobilePanelViewKindSchema,
    /**
     * Whether the view has a live badge provider. The mobile read surface does not fetch the current badge value, which
     * requires a separate per-view Extension Host round trip; this only tells the reader one exists.
     */
    hasBadge: z.boolean().optional(),
});

const mobilePanelContainerSchema = z.strictObject({
    id: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    icon: mobilePanelIconSchema.optional(),
    views: z.array(mobilePanelViewSchema).max(MOBILE_PANELS_MAX_VIEWS),
});

export const mobilePanelsListResultSchema = z.strictObject({
    panels: z.array(mobilePanelContainerSchema).max(MOBILE_PANELS_MAX_CONTAINERS),
});

export const mobileTreeChildrenParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    viewId: viewIdSchema,
    parentHandle: z.string().min(1).max(512).optional(),
});

/**
 * Projects `treeItemSchema` down to what a read-only mobile row renders: label, description, a bounded icon, and
 * collapsible state. `tooltip` and `command` are deliberately absent — mobile Conversation Tree is read-only and never
 * executes a command from a tree row.
 */
const mobileTreeItemSchema = z.strictObject({
    handle: z.string().min(1).max(512),
    label: z.string().min(1).max(1_024),
    description: z.string().max(1_024).optional(),
    icon: mobilePanelIconSchema.optional(),
    collapsibleState: z.enum(['none', 'collapsed', 'expanded']),
});

export const mobileTreeChildrenResultSchema = z.strictObject({
    items: z.array(mobileTreeItemSchema).max(MOBILE_TREE_MAX_ITEMS),
    reset: z.literal(true).optional(),
});

export const mobileFilesListParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    directory: pathSchema.optional(),
});

export const mobileFilesListResultSchema = z.strictObject({
    entries: z.array(fileEntrySchema).max(MOBILE_FILES_MAX_ENTRIES),
    truncated: z.boolean(),
});

export const mobileFilesReadParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    path: pathSchema,
});

export const mobileFilesReadResultSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('available'),
        path: pathSchema,
        content: z
            .string()
            .refine(
                (content) =>
                    new TextEncoder().encode(content).length <= MOBILE_FILES_READ_MAX_BYTES,
                'Mobile file read exceeds the byte limit',
            ),
        mtimeMs: z.number(),
        size: z.number(),
        contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
        readOnly: z.boolean().optional(),
    }),
    z.strictObject({ status: z.literal('binary') }),
    z.strictObject({ status: z.literal('oversized') }),
]);

export const mobileFilesWriteParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    path: pathSchema,
    content: z
        .string()
        .refine(
            (content) => new TextEncoder().encode(content).length <= MOBILE_FILES_READ_MAX_BYTES,
            'Mobile file write exceeds the byte limit',
        ),
    expectedContentHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const mobileAgentActionsResultSchema = z.strictObject({
    actions: z.array(agentActionSchema).max(40),
    truncated: z.boolean(),
});

export const mobileFilesSearchResultSchema = z.strictObject({
    paths: z.array(z.string().min(1).max(2_048)).max(40),
    truncated: z.boolean(),
});

export const mobileMethods = {
    'mobile.access.status': {
        ...commandPolicy('server', 'read'),
        params: noParameters,
        result: mobileAccessStatusSchema,
    },
    'mobile.access.enable': {
        ...commandPolicy('server', 'control'),
        params: noParameters,
        result: mobileAccessStatusSchema,
    },
    'mobile.access.disable': {
        ...commandPolicy('server', 'control'),
        params: noParameters,
        result: mobileAccessStatusSchema,
    },
    'mobile.pairing.create': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({ projectIds: mobileProjectIdsSchema }),
        result: z.strictObject({
            pairingLink: z.string().min(1).max(2_048),
            expiresAt: z.number().int().positive(),
        }),
    },
    'mobile.device.list': {
        ...commandPolicy('server', 'read'),
        params: noParameters,
        result: z.strictObject({ devices: z.array(mobileDeviceSummarySchema).max(128) }),
    },
    'mobile.dashboard': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: noParameters,
        result: mobileDashboardResultSchema,
    },
    'mobile.session.show': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: z.strictObject({ session: mobileDashboardSessionSchema }),
    },
    'mobile.timeline.read': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: mobileTimelineReadParametersSchema,
        result: mobileTimelineReadResultSchema,
    },
    'mobile.changes.list': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({
            sessionId: identifierSchema,
            refresh: z.boolean().default(false),
        }),
        result: mobileChangesListResultSchema,
    },
    'mobile.changes.diff': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            path: z.string().min(1).max(2_048),
        }),
        result: mobileChangesDiffResultSchema,
    },
    'mobile.agent.availability': {
        ...commandPolicy('server', 'read', ['projects.read']),
        params: z.strictObject({ projectId: identifierSchema }),
        result: mobileAgentAvailabilityResultSchema,
    },
    'mobile.agent.actions': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({ sessionId: identifierSchema, terminalId: identifierSchema }),
        result: mobileAgentActionsResultSchema,
    },
    'mobile.attention.list': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: z.strictObject({
            requests: z.array(mobileAttentionRequestSchema).max(20),
            /**
             * "Always allow in this Session" status (issue caxri#1295), polled alongside pending requests so the
             * permission card's banner and revoke action stay current without a second round trip.
             */
            autoAllow: permissionAutoAllowStatusSchema,
        }),
    },
    'mobile.attention.answer': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: mobileAttentionAnswerParametersSchema,
        result: z.strictObject({ status: mobileAttentionRequestSchema.shape.status }),
    },
    /**
     * Revokes the Session-scoped auto-allow grant from a mobile `control` device. Desktop revokes through
     * `session.revokePermissionAutoAllow` instead, since it is not a paired device.
     */
    'mobile.attention.autoAllowRevoke': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: permissionAutoAllowStatusSchema,
    },
    'mobile.agent.submit': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: mobileAgentSubmitParametersSchema,
        result: mobileAgentSubmitResultSchema,
    },
    'mobile.image.upload': {
        ...commandPolicy('server', 'write', ['terminals.steer']),
        params: mobileImageUploadParametersSchema,
        result: z.strictObject({ ready: z.boolean() }),
    },
    'mobile.session.create': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({
            projectId: identifierSchema,
            defaultAgent: terminalKindSchema,
        }),
        result: mobileSessionCreateResultSchema,
    },
    'mobile.session.rename': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({
            sessionId: identifierSchema,
            displayTitle: sessionRenameTitleSchema,
        }),
        result: mobileSessionMutationResultSchema,
    },
    'mobile.session.archive': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: mobileSessionMutationResultSchema,
    },
    'mobile.session.restore': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: mobileSessionMutationResultSchema,
    },
    'mobile.session.archived': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({}),
        result: mobileArchivedSessionsResultSchema,
    },
    ...mobileTerminalMethods,
    'mobile.device.revoke': {
        ...commandPolicy('desktop', 'control'),
        params: z.strictObject({ deviceId: mobileDeviceIdSchema }),
        result: z.union([canceledResultSchema, mobileDeviceSummarySchema]),
    },
    'mobile.project.browse': {
        ...commandPolicy('server', 'read', ['projects.read']),
        params: mobileProjectBrowseParametersSchema,
        result: mobileProjectBrowseResultSchema,
    },
    'mobile.project.add': {
        ...commandPolicy('server', 'write', ['projects.write']),
        params: mobileProjectAddParametersSchema,
        result: mobileProjectAddResultSchema,
    },
    'mobile.panels.list': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: mobilePanelsListParametersSchema,
        result: mobilePanelsListResultSchema,
    },
    'mobile.tree.children': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: mobileTreeChildrenParametersSchema,
        result: mobileTreeChildrenResultSchema,
    },
    'mobile.files.list': {
        ...commandPolicy('server', 'read', ['files.read']),
        params: mobileFilesListParametersSchema,
        result: mobileFilesListResultSchema,
    },
    'mobile.files.read': {
        ...commandPolicy('server', 'read', ['files.read']),
        params: mobileFilesReadParametersSchema,
        result: mobileFilesReadResultSchema,
    },
    'mobile.files.search': {
        ...commandPolicy('server', 'read', ['files.read']),
        params: z.strictObject({ sessionId: identifierSchema, query: z.string().min(1).max(100) }),
        result: mobileFilesSearchResultSchema,
    },
    'mobile.files.write': {
        ...commandPolicy('server', 'write', ['files.write']),
        params: mobileFilesWriteParametersSchema,
        result: mobileFilesReadResultSchema,
    },
    ...mobileUpdateMethods,
} as const satisfies Record<string, MethodSpec>;

/**
 * Main may apply a revoke only after its native confirmation. Binding the expected generation prevents a device that
 * changed while the dialog was open from inheriting stale approval.
 */
export const mobileInternalMethods = {
    'mobile.attention.listInternal': {
        ...commandPolicy('server', 'read'),
        params: mobileMethods['mobile.attention.list'].params.extend({
            principal: principalSchema,
        }),
        result: mobileMethods['mobile.attention.list'].result,
    },
    'mobile.attention.answerInternal': {
        ...commandPolicy('server', 'control'),
        params: mobileAttentionAnswerParametersSchema.extend({ principal: principalSchema }),
        result: mobileMethods['mobile.attention.answer'].result,
    },
    'mobile.attention.autoAllowRevokeInternal': {
        ...commandPolicy('server', 'control'),
        params: mobileMethods['mobile.attention.autoAllowRevoke'].params.extend({
            principal: principalSchema,
        }),
        result: mobileMethods['mobile.attention.autoAllowRevoke'].result,
    },
    'mobile.changes.listInternal': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({
            sessionId: identifierSchema,
            refresh: z.boolean().default(false),
            principal: principalSchema,
        }),
        result: mobileChangesListResultSchema,
    },
    'mobile.changes.diffInternal': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            path: z.string().min(1).max(2_048),
            principal: principalSchema,
        }),
        result: mobileChangesDiffResultSchema,
    },
    'mobile.timeline.readInternal': {
        ...commandPolicy('server', 'read'),
        params: mobileTimelineReadParametersSchema.extend({ principal: principalSchema }),
        result: mobileTimelineReadResultSchema,
    },
    'mobile.timeline.watchInternal': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({ sessionId: identifierSchema, principal: principalSchema }),
        result: z.strictObject({ terminalId: identifierSchema.optional() }),
    },
    'mobile.timeline.unwatchInternal': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({ terminalId: identifierSchema }),
        result: z.null(),
    },
    'mobile.agent.availabilityInternal': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({ projectId: identifierSchema, principal: principalSchema }),
        result: mobileMethods['mobile.agent.availability'].result,
    },
    'mobile.agent.submitInternal': {
        ...commandPolicy('server', 'control'),
        params: mobileAgentSubmitParametersSchema.extend({ principal: principalSchema }),
        result: mobileAgentSubmitResultSchema,
    },
    'mobile.image.uploadInternal': {
        ...commandPolicy('server', 'write'),
        params: mobileImageUploadParametersSchema.extend({ principal: principalSchema }),
        result: mobileMethods['mobile.image.upload'].result,
    },
    'mobile.session.createForPrincipal': {
        ...commandPolicy('server', 'write'),
        params: z.strictObject({
            projectId: identifierSchema,
            defaultAgent: terminalKindSchema,
            principal: principalSchema,
        }),
        result: mobileSessionCreateResultSchema,
    },
    'mobile.device.revoke.apply': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({
            deviceId: mobileDeviceIdSchema,
            expectedGeneration: z.number().int().positive(),
        }),
        result: mobileDeviceSummarySchema,
    },
    'mobile.project.browseInternal': {
        ...commandPolicy('server', 'read'),
        params: mobileProjectBrowseParametersSchema.extend({ principal: principalSchema }),
        result: mobileProjectBrowseResultSchema,
    },
    'mobile.project.addInternal': {
        ...commandPolicy('server', 'write'),
        params: mobileProjectAddParametersSchema.extend({ principal: principalSchema }),
        result: mobileProjectAddResultSchema,
    },
    'mobile.files.listInternal': {
        ...commandPolicy('server', 'read'),
        params: mobileFilesListParametersSchema.extend({ principal: principalSchema }),
        result: mobileFilesListResultSchema,
    },
    'mobile.files.readInternal': {
        ...commandPolicy('server', 'read'),
        params: mobileFilesReadParametersSchema.extend({ principal: principalSchema }),
        result: mobileFilesReadResultSchema,
    },
    'mobile.files.searchInternal': {
        ...commandPolicy('server', 'read'),
        params: mobileMethods['mobile.files.search'].params.extend({ principal: principalSchema }),
        result: mobileFilesSearchResultSchema,
    },
    'mobile.files.writeInternal': {
        ...commandPolicy('server', 'write'),
        params: mobileFilesWriteParametersSchema.extend({ principal: principalSchema }),
        result: mobileFilesReadResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type MobileAccessStatus = z.infer<typeof mobileAccessStatusSchema>;
export type MobileDashboardResult = z.infer<typeof mobileDashboardResultSchema>;
export type MobileArchivedSessionsResult = z.infer<typeof mobileArchivedSessionsResultSchema>;
export type MobileDeviceSummary = z.infer<typeof mobileDeviceSummarySchema>;
export type AgentTimelineItem = z.infer<typeof agentTimelineItemSchema>;
export type AgentSystemEventKind = z.infer<typeof agentSystemEventKindSchema>;
export type AgentSystemEventStatus = z.infer<typeof agentSystemEventStatusSchema>;
export type MobilePanelViewKind = z.infer<typeof mobilePanelViewKindSchema>;
export type MobileTimelineReadResult = z.infer<typeof mobileTimelineReadResultSchema>;
export type MobileProjectSummary = z.infer<typeof mobileProjectSummarySchema>;
export type MobileProjectBrowseResult = z.infer<typeof mobileProjectBrowseResultSchema>;
export type MobileProjectAddResult = z.infer<typeof mobileProjectAddResultSchema>;
export type MobilePanelsListResult = z.infer<typeof mobilePanelsListResultSchema>;
export type MobileTreeChildrenResult = z.infer<typeof mobileTreeChildrenResultSchema>;
export type MobileFilesListResult = z.infer<typeof mobileFilesListResultSchema>;
export type MobileFilesReadResult = z.infer<typeof mobileFilesReadResultSchema>;

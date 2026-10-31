import { z } from 'zod';

import { agentActionSchema } from '../agent/agent-action-contract.js';
import { agentEndpointRefSchema as agentEndpointReferenceSchema } from '../agent/agent-endpoint-contract.js';
import {
    canceledResultSchema,
    permissionAutoAllowStatusSchema,
    scopedProjectSchema,
    sessionRecordSchema,
} from '../domain/domain.js';
import { identifierSchema } from '../domain/identifiers.js';
import { sessionRenameTitleSchema } from '../domain/session.js';
import { terminalKindSchema } from '../domain/terminal-record.js';
import { terminalSurfaceSchema } from '../domain/terminal-surface.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { principalSchema } from '../transport/principal.js';
import { mobileDeviceRoleSchema } from './device-role.js';
import { mobileAccessStatusSchema } from './mobile-access-contract.js';
import { mobileAgentChatMethods } from './mobile-agent-chat-contract.js';
import { mobileAgentChatForkMethods } from './mobile-agent-chat-fork-contract.js';
import { mobileAgentUsageMethods } from './mobile-agent-usage-contract.js';
import {
    mobileAttentionAnswerParametersSchema,
    mobileAttentionRequestSchema,
} from './mobile-attention-contract.js';
import {
    mobileBotInboxInternalMethods,
    mobileBotInboxMethods,
} from './mobile-bot-inbox-contract.js';
import {
    mobileChangesDiffResultSchema,
    mobileChangesListResultSchema,
} from './mobile-changes-contract.js';
import { mobileDashboardSessionSchema } from './mobile-dashboard-session-contract.js';
import {
    MAX_MOBILE_FILE_ATTACHMENTS,
    mobileFileAttachmentIdSchema,
    mobileFilePathsInternalParametersSchema,
    mobileFileUploadParametersSchema,
    mobileFileUploadResultSchema,
} from './mobile-file-upload-contract.js';
import { mobileFilesInternalMethods, mobileFilesMethods } from './mobile-files-contract.js';
import { mobileHostStatusMethods } from './mobile-host-status-contract.js';
import {
    mobileAttachmentIdSchema,
    mobileImageReadInternalParametersSchema,
    mobileImageUploadParametersSchema,
} from './mobile-image-contract.js';
import { mobilePanelsMethods } from './mobile-panels-contract.js';
import { mobilePreviewInternalMethods, mobilePreviewMethods } from './mobile-preview-contract.js';
import { mobilePullRequestMethods } from './mobile-pull-request-contract.js';
import { mobileTerminalMethods } from './mobile-terminal-contract.js';
import {
    mobileTimelineReadParametersSchema,
    mobileTimelineReadResultSchema,
} from './mobile-timeline-contract.js';
import {
    mobileTimelineMessageInternalMethods,
    mobileTimelineMessageMethods,
} from './mobile-timeline-message-contract.js';
import { mobileUpdateMethods } from './mobile-update-contract.js';

export type { MobileDeviceRole } from './device-role.js';
export { mobileDeviceRoleSchema } from './device-role.js';
export * from './mobile-access-contract.js';
export * from './mobile-agent-chat-contract.js';
export * from './mobile-agent-chat-state-clip.js';
export * from './mobile-agent-chat-window.js';
export * from './mobile-agent-usage-contract.js';
export * from './mobile-attention-contract.js';
export * from './mobile-bot-inbox-contract.js';
export * from './mobile-changes-contract.js';
export * from './mobile-dashboard-session-contract.js';
export { MOBILE_FILES_MAX_ENTRIES, MOBILE_FILES_READ_MAX_BYTES } from './mobile-file-limits.js';
export * from './mobile-file-upload-contract.js';
export * from './mobile-files-contract.js';
export * from './mobile-host-status-contract.js';
export * from './mobile-image-contract.js';
export * from './mobile-message-read-contract.js';
export * from './mobile-panels-contract.js';
export * from './mobile-preview-contract.js';
export * from './mobile-pull-request-contract.js';
export * from './mobile-terminal-contract.js';
export * from './mobile-timeline-contract.js';
export * from './mobile-timeline-message-contract.js';
export * from './mobile-update-contract.js';

const noParameters = z.strictObject({}).default({});
export const mobileDeviceIdSchema = z.string().regex(/^device_[0-9a-f]{32}$/u);
export const MOBILE_MAX_PROJECT_GRANTS = 128;
/**
 * How long a freshly created pairing code stays valid. The Server ledger enforces it and the Desktop steps card quotes
 * it.
 */
export const MOBILE_PAIRING_TTL_MS = 2 * 60_000;
export const MOBILE_AGENT_SUBMIT_MAX_BYTES = 16 * 1_024;
const MOBILE_PROJECT_BROWSE_MAX_ENTRIES = 200;
export const mobileProjectIdsSchema = z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(MOBILE_MAX_PROJECT_GRANTS)
    .refine(
        (projectIds) => new Set(projectIds).size === projectIds.length,
        'Project grants must be unique',
    );

const mobileDeviceSummarySchema = z.strictObject({
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

/**
 * An archived Session as the phone's Archived Sessions list shows it. Archived Sessions have no live Terminal, so only
 * the primary Agent's kind is projected, for the row's avatar.
 */
const mobileArchivedSessionSchema = z.strictObject({
    id: identifierSchema,
    projectId: identifierSchema,
    title: z.string().min(1).max(100),
    projectTitle: z.string().min(1).max(100),
    archivedAt: z.number().int().nonnegative(),
    agentKind: terminalKindSchema.optional(),
});

export const MOBILE_ARCHIVED_SESSIONS_MAX = 64;

const mobileArchivedSessionsResultSchema = z.strictObject({
    sessions: z.array(mobileArchivedSessionSchema).max(MOBILE_ARCHIVED_SESSIONS_MAX),
    total: z.number().int().nonnegative().max(4_096),
    truncated: z.boolean(),
});

/**
 * Session management from a phone returns only the affected identity; the dashboard subscription carries the new state.
 */
const mobileSessionMutationResultSchema = z.strictObject({ sessionId: identifierSchema });

const mobileProjectSummarySchema = scopedProjectSchema.extend({
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

const mobileAgentSubmitParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    terminalId: identifierSchema,
    endpoint: agentEndpointReferenceSchema,
    clientMutationId: identifierSchema,
    attachmentIds: z.array(mobileAttachmentIdSchema).max(3).optional(),
    /**
     * Uploaded files (`mobile.file.upload`) the Agent receives as paths after the text.
     */
    fileAttachmentIds: z
        .array(mobileFileAttachmentIdSchema)
        .max(MAX_MOBILE_FILE_ATTACHMENTS)
        .optional(),
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

const mobileAgentSubmitResultSchema = z.strictObject({
    terminalId: identifierSchema,
    outcome: z.enum(['accepted', 'unknown']),
});

const mobileAgentAvailabilitySchema = z.strictObject({
    kind: terminalKindSchema,
    available: z.boolean(),
    reason: z.string().min(1).max(200).optional(),
});
const mobileAgentAvailabilityResultSchema = z.strictObject({
    agents: z.array(mobileAgentAvailabilitySchema).length(4),
    /**
     * The Mac's `session.openAgentsInChat` setting, so a new mobile Session defaults to the same surface as Desktop.
     */
    openAgentsInChat: z.boolean(),
});

/**
 * Accepts either a path relative to the Mac user's home directory or an opaque absolute path; the Server validates that
 * the resolved, symlink-followed target stays inside the home directory before it touches the filesystem.
 */
const mobileHomePathSchema = z.string().min(1).max(4_096);

const mobileProjectBrowseParametersSchema = z.strictObject({
    path: mobileHomePathSchema.optional(),
});

const mobileProjectBrowseEntrySchema = z.strictObject({
    name: z.string().min(1).max(255),
    relativePath: z.string().min(1).max(4_096),
    isGitRepository: z.boolean(),
    hasChildren: z.boolean(),
});

const mobileProjectBrowseResultSchema = z.strictObject({
    entries: z.array(mobileProjectBrowseEntrySchema).max(MOBILE_PROJECT_BROWSE_MAX_ENTRIES),
    truncated: z.boolean(),
});

const mobileProjectAddParametersSchema = z.strictObject({ path: mobileHomePathSchema });

const mobileProjectAddResultSchema = z.strictObject({
    project: mobileProjectSummarySchema,
});

/**
 * Most Agent actions one `mobile.agent.actions` reply carries; a phone menu shows a handful, and a full skill list
 * would not fit one gateway frame.
 */
export const MOBILE_AGENT_ACTIONS_MAX = 40;

/**
 * Optional search the Server ranks the Terminal's whole action list by (`searchAgentActions`, the same ranking as the
 * Desktop picker) before keeping the first {@link MOBILE_AGENT_ACTIONS_MAX}, so a skill past the cut is still found. It
 * is the typed name, with or without its `/` or `$` sigil.
 */
const mobileAgentActionsParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    terminalId: identifierSchema,
    query: z.string().max(64).optional(),
});

const mobileAgentActionsResultSchema = z.strictObject({
    actions: z.array(agentActionSchema).max(MOBILE_AGENT_ACTIONS_MAX),
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
        params: mobileAgentActionsParametersSchema,
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
    /**
     * One chunk of a file of any type. Chunks may arrive in any order and several at once; the file is written under
     * its own name once every chunk arrived, and kept for an hour for a message to cite.
     */
    'mobile.file.upload': {
        ...commandPolicy('server', 'write', ['terminals.steer']),
        params: mobileFileUploadParametersSchema,
        result: mobileFileUploadResultSchema,
    },
    'mobile.session.create': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({
            projectId: identifierSchema,
            defaultAgent: terminalKindSchema,
            /**
             * `chat` starts a Chat-capable Agent as an Agent Chat; omitted means a PTY Terminal.
             */
            surface: terminalSurfaceSchema.optional(),
        }),
        result: mobileSessionCreateResultSchema,
    },
    'mobile.session.rename': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({
            sessionId: identifierSchema,
            title: sessionRenameTitleSchema,
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
    /**
     * Pins or unpins a Session through Desktop's own `session.setPinned`, so the Pinned group is one list on both.
     */
    'mobile.session.setPinned': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({ sessionId: identifierSchema, pinned: z.boolean() }),
        result: mobileSessionMutationResultSchema,
    },
    /**
     * Deletes a Session's metadata through Desktop's own `session.delete`; the Project folder and user files stay. The
     * phone asks for confirmation itself, since Desktop's native dialog would open on the computer.
     */
    'mobile.session.delete': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: mobileSessionMutationResultSchema,
    },
    /**
     * Rename with AI: a title from the Session's Agent conversation through `session.suggestTitle`, not applied. The
     * phone fills its rename field with it and commits through `mobile.session.rename`.
     */
    'mobile.session.suggestTitle': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: z.strictObject({ title: sessionRenameTitleSchema }),
    },
    'mobile.session.archived': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({}),
        result: mobileArchivedSessionsResultSchema,
    },
    ...mobileTerminalMethods,
    ...mobileAgentChatMethods,
    ...mobileAgentChatForkMethods,
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
    ...mobilePanelsMethods,
    ...mobilePullRequestMethods,
    ...mobileAgentUsageMethods,
    ...mobileFilesMethods,
    ...mobileTimelineMessageMethods,
    ...mobileUpdateMethods,
    ...mobileBotInboxMethods,
    ...mobileHostStatusMethods,
    ...mobilePreviewMethods,
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
    /**
     * Holds an Agent Chat open for a phone subscription so idle suspension leaves it running. Core authorizes the
     * Terminal against the device grant before calling it.
     */
    'mobile.chatWatch.watchInternal': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({ terminalId: identifierSchema }),
        result: z.null(),
    },
    'mobile.chatWatch.unwatchInternal': {
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
    'mobile.file.uploadInternal': {
        ...commandPolicy('server', 'write'),
        params: mobileFileUploadParametersSchema.extend({ principal: principalSchema }),
        result: mobileFileUploadResultSchema,
    },
    'mobile.file.pathsInternal': {
        ...commandPolicy('server', 'read'),
        params: mobileFilePathsInternalParametersSchema,
        result: z.array(z.string().min(1)),
    },
    'mobile.image.readInternal': {
        ...commandPolicy('server', 'read'),
        params: mobileImageReadInternalParametersSchema,
        result: z.array(z.string().min(1)),
    },
    /**
     * The root of a granted Session's Project, for the Server's own use: the mobile Agent Chat projection names changed
     * files relative to it. Never forwarded to a phone, which only ever sees `scopedProjectSchema`.
     */
    'mobile.session.projectRootInternal': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({ sessionId: identifierSchema, principal: principalSchema }),
        result: z.strictObject({ rootPath: sessionRecordSchema.shape.rootPath }),
    },
    'mobile.session.createForPrincipal': {
        ...commandPolicy('server', 'write'),
        params: z.strictObject({
            projectId: identifierSchema,
            defaultAgent: terminalKindSchema,
            surface: terminalSurfaceSchema.optional(),
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
    ...mobileFilesInternalMethods,
    ...mobileTimelineMessageInternalMethods,
    ...mobilePreviewInternalMethods,
    ...mobileBotInboxInternalMethods,
} as const satisfies Record<string, MethodSpec>;

export type MobileDashboardResult = z.infer<typeof mobileDashboardResultSchema>;
export type MobileArchivedSessionsResult = z.infer<typeof mobileArchivedSessionsResultSchema>;
export type MobileDeviceSummary = z.infer<typeof mobileDeviceSummarySchema>;

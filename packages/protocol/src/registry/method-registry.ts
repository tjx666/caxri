import { z } from 'zod';

import { agentActionMethods } from '../agent/agent-action-contract.js';
import { agentChatMethods } from '../agent/agent-chat-methods.js';
import { commanderMethods } from '../agent/agent-commander-contract.js';
import {
    agentDelegationInternalMethods,
    agentDelegationMethods,
} from '../agent/agent-delegation-contract.js';
import {
    agentDispatchInternalMethods,
    agentDispatchMethods,
} from '../agent/agent-dispatch-contract.js';
import { agentEndpointMethods } from '../agent/agent-endpoint-contract.js';
import { agentInboxMethods } from '../agent/agent-inbox-contract.js';
import { agentNotificationInternalMethods } from '../agent/agent-notification-contract.js';
import { agentSkillHealthSchema } from '../agent/agent-skill-contract.js';
import { agentThroughputSchema } from '../agent/agent-throughput-contract.js';
import {
    delegationAccessInternalMethods,
    delegationAccessMethods,
} from '../agent/delegation-access-contract.js';
import {
    configurationSourceSchema as configSourceSchema,
    MAX_KEYBINDINGS,
} from '../configuration/configuration-contract.js';
import { appSettingsSchema } from '../configuration/settings-schema.js';
import { MAX_TRUSTED_DOMAIN_LENGTH } from '../configuration/trusted-domains.js';
import { MAX_TRUSTED_FOLDER_LENGTH } from '../configuration/trusted-folders.js';
import { agentProviderStatusDesktopMethods } from '../desktop/agent-provider-status-contract.js';
import { argvDesktopMethods } from '../desktop/argv-config.js';
import { contextMenuDesktopMethods } from '../desktop/context-menu-contract.js';
import {
    desktopHostMethods,
    desktopRootIdentitySchema,
    desktopStatusResultSchema,
} from '../desktop/desktop-contract.js';
import {
    externalDocumentDesktopMethods,
    externalDocumentServerMethods,
} from '../desktop/external-document-contract.js';
import { gpuDesktopMethods } from '../desktop/gpu-contract.js';
import { linkFaviconDesktopMethods } from '../desktop/link-favicon-contract.js';
import { linkPreviewDesktopMethods } from '../desktop/link-preview-contract.js';
import { pathBrowserContractMethods } from '../desktop/path-browser-contract.js';
import { shellCommandDesktopMethods } from '../desktop/shell-command-contract.js';
import { windowStateInternalMethods } from '../desktop/window-state-contract.js';
import { bootstrapStateSchema } from '../domain/bootstrap.js';
import { bugReportInternalMethods, bugReportMethods } from '../domain/bug-report-contract.js';
import { businessInternalMethods, businessMethods } from '../domain/business-contract.js';
import {
    agentHookHealthMapSchema,
    agentTranscriptSchema,
    canceledResultSchema,
    identifierSchema,
    keybindingConflictSchema,
    keybindingSchema,
    MAX_TERMINAL_INPUT_LENGTH,
    MAX_TERMINAL_INPUT_PAYLOAD_LENGTH,
    pathSchema,
    projectRecordSchema,
    sessionRecordSchema,
    terminalKindSchema,
    terminalRecordSchema,
    terminalSnapshotSchema,
    themeImportWarningSchema,
    themeTokensSchema,
} from '../domain/domain.js';
import { fileInternalMethods, fileMethods } from '../domain/file-contract.js';
import { gitInternalMethods, gitMethods } from '../domain/git-contract.js';
import { gitReviewMethods } from '../domain/git-review-contract.js';
import { projectIconSchema } from '../domain/project-customization.js';
import {
    projectStatusOverviewSchema,
    projectStatusSummarySchema,
} from '../domain/project-status.js';
import { sessionMethods } from '../domain/session-contract.js';
import { sessionPullRequestMethods } from '../domain/session-pull-request.js';
import {
    terminalFileLinkInternalMethods,
    terminalFileLinkMethods,
} from '../domain/terminal-file-link.js';
import { terminalLongPasteMethods } from '../domain/terminal-long-paste.js';
import { terminalReadMethods } from '../domain/terminal-read-contract.js';
import { terminalReferenceMethods } from '../domain/terminal-reference-contract.js';
import { terminalRelaunchMethods } from '../domain/terminal-relaunch-contract.js';
import { terminalSurfaceSchema } from '../domain/terminal-surface.js';
import { treeChildrenResultSchema } from '../domain/tree-item.js';
import { updateStateSchema } from '../domain/update-state.js';
import { usageMethods } from '../domain/usage-contract.js';
import {
    extensionCommandIdSchema,
    extensionErrorSchema,
    extensionIdSchema,
    extensionViewEventContextSchema,
    MAX_EXTENSION_COMMAND_ARGUMENTS,
    viewCatalogSnapshotSchema,
    viewIdSchema,
} from '../domain/views.js';
import { workbenchInternalMethods, workbenchMethods } from '../domain/workbench-contract.js';
import { mobileInternalMethods, mobileMethods } from '../mobile/mobile-contract.js';
import { eventRecoveryRequestSchema, eventRecoverySchema } from '../transport/event-journal.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { extensionViewMethods } from './view-methods.js';

const serverRead = commandPolicy('server', 'read');
const serverWrite = commandPolicy('server', 'write');
const serverControl = commandPolicy('server', 'control');
/**
 * PTY traffic preserves submission order because asynchronous fingerprints could otherwise reorder input or resize. The
 * attachment lifecycle needs the same guarantee: a pane remount submits `terminal.detach` for the outgoing pane
 * immediately followed by `terminal.attach` for the incoming one, and the client's detach fence cancels whatever attach
 * it finds in flight. A detach that waits on a fingerprint digest lets the newer attach overtake it and be cancelled,
 * which leaves the remounted Terminal blank (#571).
 */
const terminalStreamControl = { ...serverControl, idempotency: 'none' as const };
const desktopRead = commandPolicy('desktop', 'read');
const desktopWrite = commandPolicy('desktop', 'write');
const desktopControl = commandPolicy('desktop', 'control');
const serverStatusRead = commandPolicy('server', 'read', ['host.read']);
const serverStopControl = commandPolicy('server', 'control', ['host.stop']);
const desktopEventRead = commandPolicy('server', 'read');

/**
 * Parameterless methods accept the preload's `{}` placeholder and default `undefined` to it.
 */
const noParameters = z.object({}).default({});

const settingsResult = z.object({ value: appSettingsSchema, source: configSourceSchema });
const keybindingsResult = z.object({
    value: z.array(keybindingSchema).max(MAX_KEYBINDINGS),
    source: configSourceSchema,
    conflicts: z.array(keybindingConflictSchema).max(MAX_KEYBINDINGS),
});
const themeResult = z.object({ value: themeTokensSchema, source: configSourceSchema });
const themeImportResult = z.object({
    value: themeTokensSchema,
    warnings: z.array(themeImportWarningSchema),
});
const exportedFile = z.object({ path: z.string() });
const externalOpenResult = z.discriminatedUnion('status', [
    z.object({ status: z.literal('opened') }),
    z.object({ status: z.literal('canceled') }),
    z.object({
        status: z.literal('rejected'),
        reason: z.enum(['invalid_url', 'unsupported_protocol', 'credentials_not_allowed']),
    }),
]);
/**
 * The single source of truth for every public command. Each entry declares its Host/Desktop owner, effect, capability
 * boundary, idempotency policy, and Zod input/output shape. Transport adapters may route an entry but must never copy
 * its application handler.
 */
export const methods = {
    ...agentActionMethods,
    ...agentChatMethods,
    ...agentDispatchMethods,
    ...agentDelegationMethods,
    ...commanderMethods,
    ...delegationAccessMethods,
    ...agentEndpointMethods,
    ...agentInboxMethods,
    ...businessMethods,
    ...usageMethods,
    ...bugReportMethods,
    ...mobileMethods,
    ...workbenchMethods,
    ...pathBrowserContractMethods,
    ...extensionViewMethods,
    'viewContainers.catalog': {
        ...serverRead,
        params: noParameters,
        result: viewCatalogSnapshotSchema,
    },
    'viewContainers.treeChildren': {
        ...serverRead,
        params: z.object({
            viewId: viewIdSchema,
            parentHandle: z.string().min(1).max(512).optional(),
            requestId: identifierSchema,
            /**
             * Rejected with CANCELLED once no longer the active scope, like `viewContainers.viewOperation`.
             */
            context: extensionViewEventContextSchema,
        }),
        result: treeChildrenResultSchema,
    },
    'viewContainers.executeCommand': {
        ...serverControl,
        params: z.object({
            commandId: extensionCommandIdSchema,
            arguments: z.array(z.unknown()).max(MAX_EXTENSION_COMMAND_ARGUMENTS).default([]),
        }),
        result: z.object({ executed: z.literal(true) }),
    },
    'viewContainers.cancelRequest': {
        ...serverControl,
        params: z.object({ requestId: identifierSchema }),
        result: z.object({ cancelled: z.boolean() }),
    },
    'requests.cancel': {
        ...serverControl,
        params: z.object({ requestId: identifierSchema }),
        result: z.object({ cancelled: z.boolean() }),
    },
    'extensions.retry': {
        ...serverControl,
        params: z.object({ extensionId: extensionIdSchema }),
        result: z.object({ accepted: z.boolean(), error: extensionErrorSchema.optional() }),
    },
    'app.bootstrap': { ...serverRead, params: noParameters, result: bootstrapStateSchema },
    'app.records': {
        ...serverRead,
        params: z.object({
            sessionIds: z.array(identifierSchema).max(64).default([]),
            terminalIds: z.array(identifierSchema).max(64).default([]),
        }),
        result: z.object({
            sessions: z.array(sessionRecordSchema),
            terminals: z.array(terminalRecordSchema),
        }),
    },
    'app.health': {
        ...serverStatusRead,
        params: noParameters,
        result: z.object({
            ready: z.boolean(),
            pid: z.number(),
            startedAt: z.number(),
            activePtyCount: z.number(),
        }),
    },
    'host.status': {
        ...serverStatusRead,
        params: noParameters,
        result: z.object({
            profileId: identifierSchema,
            version: z.string().min(1).max(100),
            /**
             * Build commit for stale-Host detection; package version alone misses dev rebuilds.
             */
            commit: z.string().min(1).max(100).optional(),
            /**
             * Unique per build invocation. Commit alone cannot distinguish two dev builds of the same (possibly dirty)
             * checkout, so this is what the Desktop compares to decide a detached Host runs stale code and must be
             * replaced.
             */
            buildId: z.string().min(1).max(100).optional(),
            pid: z.number().int().positive(),
            startedAt: z.number().int().positive(),
            clientCount: z.number().int().nonnegative(),
            activePtyCount: z.number().int().nonnegative(),
            protocolVersion: z.number().int().positive(),
            protocolCompatible: z.boolean(),
            desktop: desktopStatusResultSchema,
        }),
    },
    'host.stop': {
        ...serverStopControl,
        params: z
            .object({ confirmLivePtys: z.boolean().default(false) })
            .default({ confirmLivePtys: false }),
        result: z.object({
            stopping: z.literal(true),
            activePtyCount: z.number().int().nonnegative(),
        }),
    },
    'events.recover': {
        ...desktopEventRead,
        params: eventRecoveryRequestSchema,
        result: eventRecoverySchema,
    },
    ...desktopHostMethods,
    ...argvDesktopMethods,
    ...gpuDesktopMethods,
    ...shellCommandDesktopMethods,
    ...contextMenuDesktopMethods,
    ...externalDocumentDesktopMethods,
    ...linkFaviconDesktopMethods,
    ...agentProviderStatusDesktopMethods,
    ...linkPreviewDesktopMethods,
    'external.open': {
        ...desktopControl,
        params: z.object({ url: z.string().min(1).max(16_384) }),
        result: externalOpenResult,
    },
    /**
     * Native "save before closing" prompt for an Editor tab with unsaved changes. It lives in Main because the choice
     * must be a modal, focus-stealing native sheet: silently discarding an unsaved buffer is the one destructive Editor
     * action the user cannot undo.
     */
    'editor.confirmDiscard': {
        ...desktopControl,
        params: z.object({ name: z.string().min(1).max(1_024) }),
        result: z.object({ choice: z.enum(['save', 'discard', 'cancel']) }),
    },
    'processExplorer.open': { ...desktopControl, params: noParameters, result: z.null() },
    'dialog.selectDirectory': {
        ...desktopControl,
        params: noParameters,
        result: z.string().nullable(),
    },
    'diagnostics.export': {
        ...desktopWrite,
        params: noParameters,
        result: exportedFile.nullable(),
    },
    'updates.getState': { ...desktopRead, params: noParameters, result: updateStateSchema },
    'updates.check': { ...desktopRead, params: noParameters, result: updateStateSchema },
    /**
     * Records that a window has already offered the currently available version in this app process, so a reload does
     * not prompt a second time. Deliberately an explicit Renderer call rather than a side effect of publishing the
     * state: an `available` state pushed before any window subscribed would otherwise be marked as delivered to a
     * listener that never existed, and the user would never hear about the release at all.
     */
    'updates.acknowledge': { ...desktopControl, params: noParameters, result: updateStateSchema },
    'updates.download': { ...desktopWrite, params: noParameters, result: updateStateSchema },
    'updates.cancel': { ...desktopControl, params: noParameters, result: updateStateSchema },
    'updates.open': { ...desktopControl, params: noParameters, result: updateStateSchema },
    'project.create': {
        ...desktopWrite,
        params: z.object({
            rootPath: pathSchema,
            expectedRootIdentity: desktopRootIdentitySchema.optional(),
        }),
        result: projectRecordSchema,
    },
    'project.cancelCreate': {
        ...desktopControl,
        params: z.object({ rootPath: pathSchema }),
        result: z.null(),
    },
    'project.delete': {
        ...desktopWrite,
        params: z.object({ projectId: identifierSchema }),
        result: z.union([canceledResultSchema, bootstrapStateSchema]),
    },
    'project.hide': {
        ...serverWrite,
        params: z.object({ projectId: identifierSchema }),
        result: bootstrapStateSchema,
    },
    /**
     * Whether adding this folder would bring back a hidden Project that still has unarchived Sessions. The Add Project
     * flow asks before choosing a Terminal, so a restore selects the old Sessions instead of creating another one.
     */
    'project.restorable': {
        ...serverRead,
        params: z.object({ rootPath: pathSchema }),
        result: z.boolean(),
    },
    'project.reorder': {
        ...serverWrite,
        params: z.object({
            projectId: identifierSchema,
            targetIndex: z.number().int().nonnegative(),
        }),
        result: z.array(projectRecordSchema),
    },
    'project.setIcon': {
        ...serverWrite,
        params: z.strictObject({
            projectId: identifierSchema,
            icon: projectIconSchema.nullable(),
        }),
        result: projectRecordSchema,
    },
    ...sessionMethods,
    'terminal.create': {
        ...serverControl,
        params: z.object({
            sessionId: identifierSchema,
            kind: terminalKindSchema,
            /**
             * Files may request a bounded Project-local cwd; ordinary creation keeps settings.
             */
            cwd: pathSchema.optional(),
            /**
             * `chat` requires a provider whose catalog entry declares `capabilities.chat`.
             */
            surface: terminalSurfaceSchema.optional(),
        }),
        result: terminalRecordSchema,
    },
    'terminal.input': {
        ...terminalStreamControl,
        params: z.object({
            terminalId: identifierSchema,
            data: z.string().max(MAX_TERMINAL_INPUT_PAYLOAD_LENGTH),
            requireRunningAgent: z.boolean().optional(),
        }),
        result: z.null(),
    },
    'terminal.inputBinary': {
        ...terminalStreamControl,
        params: z.object({
            terminalId: identifierSchema,
            data: z
                .string()
                .min(1)
                .max(MAX_TERMINAL_INPUT_LENGTH)
                .refine(
                    (data) =>
                        [...data].every((character) => (character.codePointAt(0) ?? 0) <= 0xff),
                    'Binary Terminal input must contain only bytes',
                ),
            expectedAgentLaunchId: identifierSchema.optional(),
        }),
        result: z.null(),
    },
    ...terminalLongPasteMethods,
    'terminal.resize': {
        ...terminalStreamControl,
        params: z.object({
            terminalId: identifierSchema,
            cols: z.number().int().min(2).max(1_000),
            rows: z.number().int().min(1).max(1_000),
        }),
        result: z.null(),
    },
    'terminal.close': {
        ...serverControl,
        params: z.object({ terminalId: identifierSchema }),
        result: z.null(),
    },
    /**
     * Parks one running Terminal the way idle suspension does: the process tree exits, while the record, scrollback,
     * and Agent session survive and the Terminal resumes when its Session is selected again. The resource alert's
     * `Stop` uses it. `suspended` is false when the Terminal was not running.
     */
    'terminal.suspend': {
        ...serverControl,
        params: z.object({ terminalId: identifierSchema }),
        result: z.object({ suspended: z.boolean() }),
    },
    'terminal.attach': {
        ...terminalStreamControl,
        params: z
            .object({
                terminalId: identifierSchema,
                cols: z.number().int().min(2).max(1_000).optional(),
                rows: z.number().int().min(1).max(1_000).optional(),
            })
            .refine((value) => (value.cols === undefined) === (value.rows === undefined), {
                message: 'Terminal attachment dimensions must be provided together',
            }),
        result: terminalSnapshotSchema.nullable(),
    },
    'terminal.detach': {
        ...terminalStreamControl,
        params: z.object({ terminalId: identifierSchema }),
        result: z.null(),
    },
    'terminal.moveToNewSession': {
        ...serverWrite,
        /**
         * Creates a brand-new Session under the same Project and moves the live Terminal (its running PTY preserved)
         * into it, analogous to a browser "move tab to new window".
         */
        params: z.object({ terminalId: identifierSchema }),
        result: z.object({
            session: sessionRecordSchema,
            terminal: terminalRecordSchema,
        }),
    },
    ...terminalRelaunchMethods,
    ...terminalFileLinkMethods,
    ...terminalReferenceMethods,
    ...terminalReadMethods,
    /**
     * Null when the Terminal has no bound Agent session or its provider keeps no on-disk transcript. The Runtime
     * derives the path itself from the Terminal's durable identity, so the Renderer never submits a filesystem path for
     * this out-of-Project read.
     */
    'terminal.agentTranscript': {
        ...serverRead,
        params: z.object({
            terminalId: identifierSchema,
            withContent: z.boolean().default(false),
        }),
        result: agentTranscriptSchema.nullable(),
    },
    /**
     * Null when the Terminal has no bound Agent session, its provider records no per-response usage, or no response has
     * been measured yet. Like `terminal.agentTranscript`, the Runtime resolves the transcript itself.
     */
    'terminal.agentThroughput': {
        ...serverRead,
        params: z.object({ terminalId: identifierSchema }),
        result: agentThroughputSchema.nullable(),
    },
    ...fileMethods,
    ...gitMethods,
    ...gitReviewMethods,
    'projectStatus.summary': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            /**
             * Unique token makes an explicit UI refresh bypass the settled cache exactly once.
             */
            refreshToken: identifierSchema.optional(),
        }),
        result: projectStatusSummarySchema,
    },
    'projectStatus.overview': {
        ...serverRead,
        params: z.object({ sessionId: identifierSchema }),
        result: projectStatusOverviewSchema,
    },
    ...sessionPullRequestMethods,
    'settings.get': { ...serverRead, params: noParameters, result: settingsResult },
    'agentHooks.get': { ...serverRead, params: noParameters, result: agentHookHealthMapSchema },
    'agentSkills.get': { ...serverRead, params: noParameters, result: agentSkillHealthSchema },
    'settings.update': {
        ...serverWrite,
        params: z.object({ source: configSourceSchema }),
        result: settingsResult,
    },
    'keybindings.get': { ...serverRead, params: noParameters, result: keybindingsResult },
    'keybindings.update': {
        ...serverWrite,
        params: z.object({ source: configSourceSchema }),
        result: keybindingsResult,
    },
    'theme.get': { ...serverRead, params: noParameters, result: themeResult },
    'theme.update': {
        ...serverWrite,
        params: z.object({ source: configSourceSchema }),
        result: themeResult,
    },
    'theme.import': { ...desktopWrite, params: noParameters, result: themeImportResult.nullable() },
} as const satisfies Record<string, MethodSpec>;

/**
 * Internal Server operations that are never reachable from the Renderer request allowlist.
 */
export const internalMethods = {
    ...agentNotificationInternalMethods,
    ...agentDispatchInternalMethods,
    ...agentDelegationInternalMethods,
    ...delegationAccessInternalMethods,
    ...businessInternalMethods,
    ...gitInternalMethods,
    ...mobileInternalMethods,
    ...workbenchInternalMethods,
    /**
     * The selected Session's identities and the visible Project IDs: the slice of `app.bootstrap` the Extension bridge
     * needs on every view operation and domain event. Reading the whole bootstrap there accounted for ~98% of
     * production `app.bootstrap` calls (#1185).
     */
    'app.activeContext': {
        ...serverRead,
        params: noParameters,
        result: z.object({
            ownerProjectId: identifierSchema.optional(),
            projectIds: z.array(identifierSchema),
            sessionId: identifierSchema.optional(),
            workbenchProjectId: identifierSchema.optional(),
        }),
    },
    ...windowStateInternalMethods,
    ...bugReportInternalMethods,
    'config.paths': {
        ...serverRead,
        params: noParameters,
        result: z.object({
            settings: z.string(),
            keybindings: z.string(),
            theme: z.string(),
        }),
    },
    'settings.trustDomain': {
        ...serverWrite,
        params: z.object({ domain: z.string().min(1).max(MAX_TRUSTED_DOMAIN_LENGTH) }),
        result: settingsResult,
    },
    'settings.trustFolder': {
        ...serverWrite,
        params: z.object({ path: z.string().min(1).max(MAX_TRUSTED_FOLDER_LENGTH) }),
        result: settingsResult,
    },
    'diagnostics.exportPath': {
        ...serverWrite,
        params: z.object({ destination: pathSchema }),
        result: exportedFile,
    },
    ...fileInternalMethods,
    ...terminalFileLinkInternalMethods,
    ...externalDocumentServerMethods,
    'terminal.detachAll': { ...serverControl, params: noParameters, result: z.null() },
    'terminal.terminateAll': { ...serverControl, params: noParameters, result: z.null() },
    'theme.importPath': {
        ...serverWrite,
        params: z.object({ path: pathSchema }),
        result: themeImportResult,
    },
} as const satisfies Record<string, MethodSpec>;

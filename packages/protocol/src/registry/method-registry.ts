import { z } from 'zod';

import { agentActionMethods } from '../agent/agent-action-contract.js';
import {
    agentDispatchInternalMethods,
    agentDispatchMethods,
} from '../agent/agent-dispatch-contract.js';
import { agentEndpointMethods } from '../agent/agent-endpoint-contract.js';
import { agentInboxMethods } from '../agent/agent-inbox-contract.js';
import { agentSkillHealthSchema } from '../agent/agent-skill-contract.js';
import {
    configurationSourceSchema as configSourceSchema,
    MAX_KEYBINDINGS,
} from '../configuration/configuration-contract.js';
import { appSettingsSchema } from '../configuration/settings-schema.js';
import { MAX_CONFIGURABLE_FILE_BYTES } from '../configuration/settings-spec.js';
import { MAX_TRUSTED_DOMAIN_LENGTH } from '../configuration/trusted-domains.js';
import { argvConfigChangesSchema, argvConfigSchema } from '../desktop/argv-config.js';
import {
    desktopHostMethods,
    desktopOpenIdentitySchema,
    desktopRootIdentitySchema,
    desktopStatusResultSchema,
} from '../desktop/desktop-contract.js';
import { bugReportScreenshot, bugReportText } from '../domain/bug-report-contract.js';
import { businessInternalMethods, businessMethods } from '../domain/business-contract.js';
import {
    agentHookHealthMapSchema,
    agentTranscriptSchema,
    bootstrapStateSchema,
    canceledResultSchema,
    fileDocumentSchema,
    fileEntrySchema,
    fileMutationOperationSchema,
    fileSearchModeSchema,
    fileSearchResultSchema,
    identifierSchema,
    keybindingConflictSchema,
    keybindingSchema,
    MAX_TERMINAL_INPUT_LENGTH,
    movedFileEntrySchema,
    mutableFileEntrySchema,
    pathSchema,
    persistedWindowStateSchema,
    projectRecordSchema,
    projectStatusOverviewSchema,
    projectStatusSummarySchema,
    sessionRecordSchema,
    sessionStateSchema,
    terminalKindSchema,
    terminalRecordSchema,
    terminalResourceUsageSchema,
    terminalSnapshotSchema,
    themeTokensSchema,
    updateStateSchema,
} from '../domain/domain.js';
import { editorNavigationTargetSchema } from '../domain/editor.js';
import { gitInternalMethods, gitMethods } from '../domain/git-contract.js';
import { projectIconSchema } from '../domain/project-customization.js';
import {
    terminalFileLinkAmbiguousResolutionSchema,
    terminalFileLinkAmbiguousResultSchema,
} from '../domain/terminal-file-link.js';
import {
    extensionCommandIdSchema,
    extensionErrorSchema,
    extensionIdSchema,
    MAX_EXTENSION_COMMAND_ARGUMENTS,
    treeChildrenResultSchema,
    viewCatalogSnapshotSchema,
    viewIdSchema,
} from '../domain/views.js';
import { workbenchInternalMethods, workbenchMethods } from '../domain/workbench-contract.js';
import { eventRecoveryRequestSchema, eventRecoverySchema } from '../transport/event-journal.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { extensionViewMethods } from './view-methods.js';

const serverRead = commandPolicy('server', 'read');
const serverWrite = commandPolicy('server', 'write');
const serverControl = commandPolicy('server', 'control');
/**
 * PTY stream setup and traffic must enter adapters in transport submission order. Request fingerprints are asynchronous
 * and can let overlapping input or resize overtake attachment before either Desktop or Server reaches its adapter.
 */
const terminalStreamControl = { ...serverControl, idempotency: 'none' as const };
const desktopRead = commandPolicy('desktop', 'read');
const desktopWrite = commandPolicy('desktop', 'write');
const desktopControl = commandPolicy('desktop', 'control');
const serverStatusRead = commandPolicy('server', 'read', ['host.read']);
const serverStopControl = commandPolicy('server', 'control', ['host.stop']);
const desktopEventRead = commandPolicy('server', 'read');

/**
 * Methods without required parameters still accept the preload's `{}` placeholder, and the default makes `undefined` a
 * valid input so callers may omit the argument entirely.
 */
const noParameters = z.object({}).default({});

/**
 * Keeps path-browser IPC and rendering bounded while still allowing users to refine by name.
 */
export const MAX_FILE_BROWSE_ENTRIES = 200;
/**
 * Keeps one expanded Files tree directory within the controlled Renderer and transport budget. The result carries an
 * explicit truncation bit so a large directory never silently appears complete.
 */
export const MAX_FILE_LIST_ENTRIES = 1_024;

const settingsResult = z.object({ value: appSettingsSchema, source: configSourceSchema });
const keybindingsResult = z.object({
    value: z.array(keybindingSchema).max(MAX_KEYBINDINGS),
    source: configSourceSchema,
    conflicts: z.array(keybindingConflictSchema).max(MAX_KEYBINDINGS),
});
const themeResult = z.object({ value: themeTokensSchema, source: configSourceSchema });
const exportedFile = z.object({ path: z.string() });
const fileName = z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(
        (name) =>
            name !== '.' &&
            name !== '..' &&
            !name.includes('/') &&
            !name.includes('\\') &&
            !name.includes('\0'),
        'File name must not contain path separators',
    );
const canceled = canceledResultSchema;
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
    ...agentDispatchMethods,
    ...agentEndpointMethods,
    ...agentInboxMethods,
    ...businessMethods,
    ...workbenchMethods,
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
    /**
     * Main-owned boot configuration (`argv.jsonc`); separate from `settings.*` because its values gate pre-`whenReady`
     * Chromium switches and only take effect on the next launch.
     */
    'argv.get': {
        ...desktopRead,
        params: noParameters,
        result: z.object({ value: argvConfigSchema }),
    },
    'argv.update': {
        ...desktopWrite,
        params: z.object({ changes: argvConfigChangesSchema }),
        result: z.object({ value: argvConfigSchema }),
    },
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
    'bugReport.context': {
        ...serverRead,
        params: noParameters,
        result: z.object({
            appVersion: z.string().min(1).max(100),
            architecture: z.string().min(1).max(100),
            commit: z.string().min(1).max(100),
            platform: z.string().min(1).max(100),
            recentErrorIds: z.array(z.string().min(1).max(200)).max(5),
        }),
    },
    'bugReport.captureScreenshot': {
        ...desktopControl,
        params: noParameters,
        result: bugReportScreenshot,
    },
    'bugReport.send': {
        ...desktopWrite,
        params: z.object({
            report: bugReportText,
            screenshot: bugReportScreenshot.optional(),
            sessionId: identifierSchema,
            terminalId: identifierSchema,
        }),
        result: z.null(),
    },
    'updates.getState': { ...desktopRead, params: noParameters, result: updateStateSchema },
    'updates.check': { ...desktopRead, params: noParameters, result: updateStateSchema },
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
        result: z.union([canceled, bootstrapStateSchema]),
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
    'session.create': {
        ...serverWrite,
        /**
         * A `null` defaultAgent creates the Session without any Terminal.
         */
        params: z.object({
            projectId: identifierSchema,
            defaultAgent: terminalKindSchema.nullable(),
        }),
        result: z.object({
            session: sessionRecordSchema,
            terminal: terminalRecordSchema.nullable(),
        }),
    },
    'session.delete': {
        ...desktopWrite,
        params: z.object({ sessionId: identifierSchema }),
        result: z.union([canceled, bootstrapStateSchema]),
    },
    'session.select': {
        ...serverWrite,
        params: z.object({ sessionId: identifierSchema }),
        result: sessionRecordSchema,
    },
    'session.markRead': {
        ...serverWrite,
        params: z.object({
            sessionId: identifierSchema,
            attentionEpoch: z.number().int().nonnegative(),
        }),
        result: sessionRecordSchema,
    },
    'session.rename': {
        ...serverWrite,
        params: z.object({
            sessionId: identifierSchema,
            displayTitle: z.string().trim().min(1).max(200),
        }),
        result: sessionRecordSchema,
    },
    'session.archive': {
        ...serverWrite,
        params: z.object({ sessionId: identifierSchema }),
        result: sessionRecordSchema,
    },
    'session.unarchive': {
        ...serverWrite,
        params: z.object({ sessionId: identifierSchema }),
        result: sessionRecordSchema,
    },
    'session.updateState': {
        ...serverWrite,
        params: sessionStateSchema,
        result: sessionStateSchema,
    },
    'terminal.create': {
        ...serverControl,
        params: z.object({
            sessionId: identifierSchema,
            kind: terminalKindSchema,
            /**
             * Files may request a bounded Project-local cwd; ordinary creation keeps settings.
             */
            cwd: pathSchema.optional(),
        }),
        result: terminalRecordSchema,
    },
    'terminal.input': {
        ...terminalStreamControl,
        params: z.object({
            terminalId: identifierSchema,
            data: z.string().max(MAX_TERMINAL_INPUT_LENGTH),
        }),
        result: z.null(),
    },
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
        ...serverControl,
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
    'terminal.restart': {
        ...serverControl,
        params: z.object({
            terminalId: identifierSchema,
            mode: z.enum(['resume', 'fresh']).default('resume'),
        }),
        result: terminalRecordSchema,
    },
    'terminal.openFileLink': {
        ...desktopControl,
        params: z.object({
            terminalId: identifierSchema,
            target: z.string().min(3).max(4_096),
            location: editorNavigationTargetSchema.optional(),
        }),
        result: z.union([
            canceled,
            z.object({ opened: z.literal(true) }),
            terminalFileLinkAmbiguousResultSchema,
        ]),
    },
    'terminal.snapshot': {
        ...serverRead,
        params: z.object({ terminalId: identifierSchema }),
        result: terminalSnapshotSchema.nullable(),
    },
    'terminal.runningCount': {
        ...serverRead,
        params: z.object({ sessionId: identifierSchema.optional() }).default({}),
        result: z.number(),
    },
    'terminal.resources': {
        ...serverRead,
        params: z.object({ terminalId: identifierSchema }),
        result: terminalResourceUsageSchema.nullable(),
    },
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
    'files.list': {
        ...serverRead,
        params: z.object({ sessionId: identifierSchema, directory: pathSchema.optional() }),
        result: z.object({
            entries: z.array(fileEntrySchema).max(MAX_FILE_LIST_ENTRIES),
            truncated: z.boolean(),
        }),
    },
    'files.browse': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            directory: pathSchema.optional(),
            query: z.string().max(255),
        }),
        result: z.object({
            entries: z.array(fileEntrySchema).max(MAX_FILE_BROWSE_ENTRIES),
            truncated: z.boolean(),
        }),
    },
    'files.create': {
        ...serverWrite,
        params: z.object({
            operationId: identifierSchema,
            sessionId: identifierSchema,
            directory: pathSchema,
            name: fileName,
            kind: z.enum(['file', 'directory']).default('file'),
        }),
        result: mutableFileEntrySchema,
    },
    'files.copy': {
        ...serverWrite,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            directory: pathSchema,
        }),
        result: mutableFileEntrySchema,
    },
    'files.rename': {
        ...serverWrite,
        params: z.object({
            operationId: identifierSchema,
            sessionId: identifierSchema,
            path: pathSchema,
            name: fileName,
        }),
        result: movedFileEntrySchema,
    },
    'files.move': {
        ...serverWrite,
        params: z.object({
            operationId: identifierSchema,
            sessionId: identifierSchema,
            path: pathSchema,
            directory: pathSchema,
            conflict: z.enum(['reject', 'rename', 'replace']).default('reject'),
        }),
        result: movedFileEntrySchema,
    },
    'files.operation.get': {
        ...serverRead,
        params: z.object({ operationId: identifierSchema, sessionId: identifierSchema }),
        result: fileMutationOperationSchema.nullable(),
    },
    'files.operation.list': {
        ...serverRead,
        params: z.object({ sessionId: identifierSchema }),
        result: z.array(fileMutationOperationSchema).max(256),
    },
    'files.operation.cancel': {
        ...serverControl,
        params: z.object({ operationId: identifierSchema, sessionId: identifierSchema }),
        result: fileMutationOperationSchema,
    },
    'files.operation.acknowledge': {
        ...serverWrite,
        params: z.object({ operationId: identifierSchema, sessionId: identifierSchema }),
        result: z.null(),
    },
    'files.trash': {
        ...desktopWrite,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            /**
             * Set when an open Editor tab holds unsaved changes for this path. The Trash can only restore the last
             * bytes written to disk, so the confirmation must stop promising that the item is fully recoverable.
             */
            hasUnsavedChanges: z.boolean().optional(),
        }),
        result: z.union([canceled, mutableFileEntrySchema]),
    },
    'files.read': {
        ...serverRead,
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: fileDocumentSchema,
    },
    'files.write': {
        ...serverWrite,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            content: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
        }),
        result: fileDocumentSchema,
    },
    'files.search': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            mode: fileSearchModeSchema,
            query: z.string().min(1).max(256),
            caseSensitive: z.boolean().default(false),
            wholeWord: z.boolean().default(false),
            regex: z.boolean().default(false),
            include: z.string().max(512).default(''),
            exclude: z.string().max(512).default(''),
        }),
        result: fileSearchResultSchema,
    },
    ...gitMethods,
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
    'theme.import': { ...desktopWrite, params: noParameters, result: themeTokensSchema.nullable() },
} as const satisfies Record<string, MethodSpec>;

/**
 * Internal Server operations that are never reachable from the Renderer request allowlist.
 */
export const internalMethods = {
    ...agentDispatchInternalMethods,
    ...businessInternalMethods,
    ...gitInternalMethods,
    ...workbenchInternalMethods,
    'app.windowState.get': {
        ...serverRead,
        params: noParameters,
        result: persistedWindowStateSchema,
    },
    'app.windowState.update': {
        ...serverWrite,
        params: persistedWindowStateSchema,
        result: persistedWindowStateSchema,
    },
    'bugReport.deliver': {
        ...serverControl,
        params: z.object({
            pasteImage: z.boolean(),
            report: bugReportText,
            sessionId: identifierSchema,
            terminalId: identifierSchema,
        }),
        result: z.null(),
    },
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
    'diagnostics.exportPath': {
        ...serverWrite,
        params: z.object({ destination: pathSchema }),
        result: exportedFile,
    },
    'files.authorizeTrash': {
        ...serverControl,
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: mutableFileEntrySchema.extend({
            device: z.string().regex(/^\d+$/),
            inode: z.string().regex(/^\d+$/),
            root: z.object({
                path: pathSchema,
                device: z.string().regex(/^\d+$/),
                inode: z.string().regex(/^\d+$/),
            }),
        }),
    },
    'files.authorizeOpen': {
        ...serverControl,
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: mutableFileEntrySchema.extend({
            device: z.string().regex(/^\d+$/),
            inode: z.string().regex(/^\d+$/),
            root: z.object({
                path: pathSchema,
                device: z.string().regex(/^\d+$/),
                inode: z.string().regex(/^\d+$/),
            }),
        }),
    },
    'terminal.fileLink.resolve': {
        ...serverControl,
        params: z.object({
            terminalId: identifierSchema,
            target: z.string().min(3).max(4_096),
            selectedRoot: pathSchema.optional(),
        }),
        result: z.discriminatedUnion('status', [
            z.object({
                status: z.literal('authorization_required'),
                path: pathSchema,
                sourceSessionId: identifierSchema,
            }),
            z.object({
                status: z.literal('authorized'),
                identity: desktopOpenIdentitySchema,
                path: pathSchema,
                projectId: identifierSchema,
                sourceSessionId: identifierSchema,
            }),
            z.object({
                status: z.literal('selection_authorized'),
                identity: desktopOpenIdentitySchema,
                path: pathSchema,
                rootPath: pathSchema,
                sourceSessionId: identifierSchema,
            }),
            terminalFileLinkAmbiguousResolutionSchema,
        ]),
    },
    'terminal.detachAll': { ...serverControl, params: noParameters, result: z.null() },
    'terminal.terminateAll': { ...serverControl, params: noParameters, result: z.null() },
    'theme.importPath': {
        ...serverWrite,
        params: z.object({ path: pathSchema }),
        result: themeTokensSchema,
    },
} as const satisfies Record<string, MethodSpec>;

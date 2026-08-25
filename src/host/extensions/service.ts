import { randomUUID } from 'node:crypto';

import type {
    ExtensionCapability,
    ExtensionError,
    ExtensionViewEventContext,
    ProjectStatusSummary,
    TreeChildrenResult,
    ViewCatalogSnapshot,
} from '@caxri/protocol';
import { methods } from '@caxri/protocol';

import type {
    ExtensionFilesChange,
    ExtensionHostApiRequest,
    ExtensionHostRegistration,
    ExtensionProjectStatusSummary,
    ExtensionWorkspaceOperation,
} from '../../shared/extension-host-protocol';
import type { StructuredLogger } from '../../shared/node/logger';
import { logEventCatalog } from '../../shared/node/logger';
import type { CatalogExtensionState } from './catalog';
import { buildViewCatalog } from './catalog';
import type { DiscoveredExtension } from './discovery';
import { discoverExtensions } from './discovery';
import type { CatalogChangedEvent, TreeChangedEvent, ViewChangedEvent } from './service-events';
import {
    projectExtensionHostViewEvent,
    subscribeExtensionEvent,
    toExtensionViewEventContext,
} from './service-events';
import { ExtensionHostSupervisor } from './supervisor';
import { assertActiveViewContext } from './view-scope';
import {
    projectFileOperation,
    validatedExtensionWorkspaceResult,
    validatedRuntimeWorkspaceResult,
} from './workspace-results';

type DiscoveryResult = Awaited<ReturnType<typeof discoverExtensions>>;

export interface ExtensionServiceOptions {
    appVersion: string;
    commit: string;
    executable?: string;
    extensionHostPath: string;
    extensionRoots: string[];
    includeTestOnly: boolean;
    logger: StructuredLogger;
    activeContext(): Promise<{
        ownerProjectId?: string;
        sessionId?: string;
        workbenchProjectId?: string;
    }>;
    projectIds(): Promise<string[]>;
    projectStatus(sessionId: string, refreshToken?: string): Promise<ProjectStatusSummary>;
    workspaceRequest(
        operation: ExtensionWorkspaceOperation,
        parameters: unknown,
        context: { sessionId: string; workbenchProjectId: string },
        signal?: AbortSignal,
    ): Promise<unknown>;
}

const readWorkspaceOperations = new Set<ExtensionWorkspaceOperation>([
    'files.list',
    'files.operation.get',
    'files.operation.list',
    'files.reveal',
    'files.search',
    'git.commits',
    'git.commitDetails',
    'git.pullRequestChanges',
    'git.remoteHost',
    'git.summary',
]);

function workspaceCapability(operation: ExtensionWorkspaceOperation): ExtensionCapability {
    const domain = operation.startsWith('files.') ? 'files' : 'git';
    const access = readWorkspaceOperations.has(operation) ? 'read' : 'write';
    return `${domain}.${access}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function workspaceParameters(
    operation: ExtensionWorkspaceOperation,
    arguments_: unknown,
    sessionId: string,
): unknown {
    if (!isRecord(arguments_))
        throw Object.assign(new Error('Extension workspace arguments must be an object'), {
            code: 'PROVIDER_FAILED',
        });
    try {
        if (operation === 'files.reveal')
            return methods['files.read'].params.parse({ ...arguments_, sessionId });
        return methods[operation].params.parse({ ...arguments_, sessionId });
    } catch {
        throw Object.assign(new Error(`Invalid Extension API arguments for ${operation}`), {
            code: 'PROVIDER_FAILED',
        });
    }
}

function extensionFailure(error: unknown): ExtensionError {
    const code =
        typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'ACTIVATION_FAILED';
    const allowed: Array<ExtensionError['code']> = [
        'MANIFEST_INVALID',
        'ENGINE_INCOMPATIBLE',
        'DUPLICATE_ID',
        'COMMONJS_ENTRY_UNSUPPORTED',
        'COMMONJS_API_UNSUPPORTED',
        'ELECTRON_IMPORT_DENIED',
        'API_IMPORT_UNOWNED',
        'ACTIVATION_FAILED',
        'PROVIDER_MISSING',
        'PROVIDER_FAILED',
        'PROVIDER_TIMEOUT',
        'PROVIDER_CAPACITY',
        'PAYLOAD_TOO_LARGE',
        'CAPABILITY_DENIED',
        'PROJECT_SCOPE_DENIED',
        'GENERATION_EXPIRED',
        'EXTENSION_HOST_UNAVAILABLE',
    ];
    return {
        code: allowed.includes(code as ExtensionError['code'])
            ? (code as ExtensionError['code'])
            : 'ACTIVATION_FAILED',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 2_048),
    };
}

export function projectStatusForExtension(
    summary: ProjectStatusSummary,
): ExtensionProjectStatusSummary {
    return {
        ...summary,
        repositories: summary.repositories.map((repo) => {
            const projected = { ...repo };
            Reflect.deleteProperty(projected, 'rootPath');
            return projected;
        }),
    };
}

export function grantsForExtension(extension: DiscoveredExtension): ExtensionCapability[] {
    return extension.source === 'bundled' ? extension.manifest.caxri.capabilities : [];
}

interface ExtensionGrant {
    apiToken: string;
    capabilities: Set<ExtensionCapability>;
    projectIds: Set<string>;
}

/**
 * Owns manifest discovery, actual grants, the unique descriptor catalog, and Extension Host RPC.
 */
export class ExtensionService extends EventTarget {
    private catalogSnapshot?: ViewCatalogSnapshot;
    private discovered: DiscoveredExtension[] = [];
    private rejected: DiscoveryResult['rejected'] = [];
    private readonly states = new Map<string, CatalogExtensionState>();
    private readonly grants = new Map<string, ExtensionGrant>();
    private revision = 0;
    private supervisor?: ExtensionHostSupervisor;
    private projectIds: string[] = [];

    constructor(private readonly options: ExtensionServiceOptions) {
        super();
    }

    private applyDiscovery(result: DiscoveryResult, shouldAdvanceGenerations: boolean): void {
        const previousStates = new Map(this.states);
        this.discovered = result.extensions;
        this.rejected = result.rejected;
        this.states.clear();
        this.grants.clear();
        for (const extension of this.discovered) {
            const generation = shouldAdvanceGenerations
                ? (previousStates.get(extension.extensionId)?.generation ?? 0) + 1
                : 1;
            this.states.set(extension.extensionId, { generation, lifecycle: 'discovered' });
            // Bundled extensions are trusted, but declarations still do not become authority until recorded here.
            this.grants.set(extension.extensionId, {
                apiToken: randomUUID(),
                capabilities: new Set(grantsForExtension(extension)),
                projectIds: new Set(extension.source === 'bundled' ? this.projectIds : []),
            });
            this.options.logger.write('info', logEventCatalog.extensionHost.discovered, {
                fields: {
                    extensionId: extension.extensionId,
                    source: extension.source,
                    version: extension.manifest.version,
                },
            });
        }
    }

    private registrations(): ExtensionHostRegistration[] {
        const registrations: ExtensionHostRegistration[] = [];
        for (const extension of this.discovered) {
            const state = this.states.get(extension.extensionId);
            if (state?.lifecycle === 'error') continue;
            const grant = this.grants.get(extension.extensionId);
            if (!state || !grant)
                throw new Error(
                    `Extension registration state is missing: ${extension.extensionId}`,
                );
            registrations.push({
                extensionId: extension.extensionId,
                generation: state.generation,
                apiToken: grant.apiToken,
                rootPath: extension.rootPath,
                entryPath: extension.entryPath,
                manifest: extension.manifest,
                grants: [...grant.capabilities],
                projectIds: [...grant.projectIds],
            });
        }
        return registrations;
    }

    private async projectStatusForStableContext(
        active: {
            sessionId: string;
            workbenchProjectId: string;
        },
        refreshToken?: string,
    ): Promise<ExtensionProjectStatusSummary> {
        const result = await this.options.projectStatus(active.sessionId, refreshToken);
        return this.projectStatusIfContextUnchanged(active, result);
    }

    private async projectStatusIfContextUnchanged(
        active: { sessionId: string; workbenchProjectId: string },
        result: ProjectStatusSummary,
    ): Promise<ExtensionProjectStatusSummary> {
        const current = await this.options.activeContext();
        if (
            current.sessionId !== active.sessionId ||
            current.workbenchProjectId !== active.workbenchProjectId
        )
            throw Object.assign(
                new Error('Active Project changed while the extension request was running'),
                { code: 'GENERATION_EXPIRED' },
            );
        return projectStatusForExtension(result);
    }

    private async rebuildCatalog(extensionId?: string): Promise<void> {
        this.revision += 1;
        this.catalogSnapshot = await buildViewCatalog({
            extensions: this.discovered,
            rejected: this.rejected,
            states: this.states,
            revision: this.revision,
        });
        this.dispatchEvent(
            new CustomEvent('catalogChanged', { detail: { revision: this.revision, extensionId } }),
        );
    }

    private assertApiAccess(
        request: ExtensionHostApiRequest,
        capability: ExtensionCapability,
    ): void {
        const state = this.states.get(request.extensionId);
        if (!state || state.generation !== request.generation)
            throw Object.assign(new Error('Extension generation is no longer current'), {
                code: 'GENERATION_EXPIRED',
            });
        const grant = this.grants.get(request.extensionId);
        if (!grant || grant.apiToken !== request.apiToken)
            throw Object.assign(new Error('Extension API identity is invalid'), {
                code: 'GENERATION_EXPIRED',
            });
        if (!grant.capabilities.has(capability))
            throw Object.assign(new Error(`Extension lacks ${capability}`), {
                code: 'CAPABILITY_DENIED',
            });
    }

    private async activeContextForApi(
        request: ExtensionHostApiRequest,
        capability: ExtensionCapability,
    ): Promise<{ sessionId: string; workbenchProjectId: string }> {
        this.assertApiAccess(request, capability);
        const active = await this.options.activeContext();
        if (!active.sessionId || !active.workbenchProjectId)
            throw Object.assign(new Error('No active Session'), { code: 'PROJECT_SCOPE_DENIED' });
        const currentProjectIds = await this.options.projectIds();
        const currentProjectIdSet = new Set(currentProjectIds);
        this.projectIds = currentProjectIds;
        const grant = this.grants.get(request.extensionId);
        const extension = this.discovered.find(
            ({ extensionId }) => extensionId === request.extensionId,
        );
        if (grant && extension?.source === 'bundled') grant.projectIds = new Set(currentProjectIds);
        const activeProjectIds = [active.ownerProjectId, active.workbenchProjectId].filter(
            (projectId): projectId is string => Boolean(projectId),
        );
        if (
            activeProjectIds.some(
                (projectId) =>
                    !currentProjectIdSet.has(projectId) || !grant?.projectIds.has(projectId),
            )
        )
            throw Object.assign(new Error('Active Project is outside the extension grant'), {
                code: 'PROJECT_SCOPE_DENIED',
            });
        return {
            sessionId: active.sessionId,
            workbenchProjectId: active.workbenchProjectId,
        };
    }

    private async assertApiContextCurrent(
        request: ExtensionHostApiRequest,
        capability: ExtensionCapability,
        active: { sessionId: string; workbenchProjectId: string },
    ): Promise<void> {
        this.assertApiAccess(request, capability);
        const current = await this.options.activeContext();
        if (
            current.sessionId !== active.sessionId ||
            current.workbenchProjectId !== active.workbenchProjectId
        )
            throw Object.assign(
                new Error('Active Project changed while the extension request was running'),
                { code: 'GENERATION_EXPIRED' },
            );
    }

    private async requireOwnedFileOperation(
        operationId: string,
        active: { sessionId: string; workbenchProjectId: string },
    ): Promise<Record<string, unknown>> {
        const operation = validatedRuntimeWorkspaceResult(
            'files.operation.get',
            await this.options.workspaceRequest('files.operation.get', { operationId }, active),
        );
        if (!isRecord(operation) || !this.fileOperationBelongsToActiveProject(operation, active))
            throw Object.assign(new Error('File operation is outside the active Project'), {
                code: 'PROJECT_SCOPE_DENIED',
            });
        return operation;
    }

    private fileOperationBelongsToActiveProject(
        operation: Record<string, unknown>,
        active: { sessionId: string; workbenchProjectId: string },
    ): boolean {
        return typeof operation.workbenchProjectId === 'string'
            ? operation.workbenchProjectId === active.workbenchProjectId
            : operation.sessionId === active.sessionId;
    }

    private async workspaceApiRequest(
        request: Extract<ExtensionHostApiRequest, { method: 'workspace.request' }>,
        signal?: AbortSignal,
    ): Promise<unknown> {
        const { operation } = request.params;
        const capability = workspaceCapability(operation);
        const active = await this.activeContextForApi(request, capability);
        assertActiveViewContext(request.params.context, active);
        const parameters = workspaceParameters(
            operation,
            request.params.arguments,
            active.sessionId,
        );
        if (operation === 'files.operation.cancel' || operation === 'files.operation.acknowledge') {
            const operationId = (parameters as { operationId: string }).operationId;
            await this.requireOwnedFileOperation(operationId, active);
        }
        const workspaceResult = signal
            ? await this.options.workspaceRequest(operation, parameters, active, signal)
            : await this.options.workspaceRequest(operation, parameters, active);
        const result = validatedRuntimeWorkspaceResult(operation, workspaceResult);
        if (readWorkspaceOperations.has(operation))
            await this.assertApiContextCurrent(request, capability, active);
        if (operation === 'files.operation.list') {
            const visibleOperations: Array<Record<string, unknown>> = [];
            for (const fileOperation of result as Array<Record<string, unknown>>)
                if (this.fileOperationBelongsToActiveProject(fileOperation, active))
                    visibleOperations.push(projectFileOperation(fileOperation));
            return visibleOperations;
        }
        if (operation === 'files.operation.get' || operation === 'files.operation.cancel') {
            if (result === null) return null;
            if (!isRecord(result) || !this.fileOperationBelongsToActiveProject(result, active)) {
                if (operation === 'files.operation.get') return null;
                throw Object.assign(new Error('File operation is outside the active Project'), {
                    code: 'PROJECT_SCOPE_DENIED',
                });
            }
            return projectFileOperation(result);
        }
        return result;
    }

    private async handleApiRequest(
        request: ExtensionHostApiRequest,
        signal?: AbortSignal,
    ): Promise<unknown> {
        if (request.method === 'workspace.request')
            return this.workspaceApiRequest(request, signal);
        this.assertApiAccess(request, 'projects.read');
        const snapshot = await this.options.activeContext();
        if (!snapshot.sessionId)
            return {
                repositories: [],
                refreshedAt: Date.now(),
                error: 'No active Session',
            } satisfies ExtensionProjectStatusSummary;
        const active = await this.activeContextForApi(request, 'projects.read');
        const result = await this.projectStatusForStableContext(
            active,
            request.params.refreshToken,
        );
        await this.assertApiContextCurrent(request, 'projects.read', active);
        return result;
    }

    private extensionForView(viewId: string): DiscoveredExtension {
        const descriptor = this.catalog().views.find(({ id }) => id === viewId);
        if (descriptor?.source.kind !== 'extension')
            throw Object.assign(new Error(`Extension view not found: ${viewId}`), {
                code: 'PROVIDER_MISSING',
            });
        const extensionId = descriptor.source.extensionId;
        const extension = this.discovered.find(
            (extension) => extension.extensionId === extensionId,
        );
        if (!extension) throw new Error(`Extension not discovered: ${extensionId}`);
        return extension;
    }

    private async activate(extension: DiscoveredExtension, reason: string): Promise<void> {
        const state = this.states.get(extension.extensionId)!;
        if (state.lifecycle === 'active') return;
        this.states.set(extension.extensionId, {
            ...state,
            lifecycle: 'activating',
            error: undefined,
        });
        this.options.logger.write('info', logEventCatalog.extensionHost.activating, {
            fields: { extensionId: extension.extensionId, reason },
        });
        await this.rebuildCatalog(extension.extensionId);
        try {
            await this.supervisor?.request('activate', {
                extensionId: extension.extensionId,
                generation: state.generation,
                reason,
            });
            if (this.states.get(extension.extensionId)?.generation !== state.generation)
                throw Object.assign(
                    new Error('Extension generation changed while activation was running'),
                    { code: 'GENERATION_EXPIRED' },
                );
            this.states.set(extension.extensionId, {
                generation: state.generation,
                lifecycle: 'active',
            });
            this.options.logger.write('info', logEventCatalog.extensionHost.activated, {
                fields: { extensionId: extension.extensionId, reason },
            });
        } catch (error) {
            /**
             * A child crash advances every extension generation synchronously. The rejected activation from the retired
             * child must not overwrite that newer `crashed`/`discovered` state with its captured generation.
             */
            if (this.states.get(extension.extensionId)?.generation === state.generation)
                this.states.set(extension.extensionId, {
                    ...state,
                    lifecycle: 'error',
                    error: extensionFailure(error),
                });
            throw error;
        } finally {
            await this.rebuildCatalog(extension.extensionId);
        }
    }

    async start(): Promise<void> {
        this.projectIds = await this.options.projectIds();
        const result = await discoverExtensions({
            roots: this.options.extensionRoots,
            appVersion: this.options.appVersion,
            includeTestOnly: this.options.includeTestOnly,
        });
        this.applyDiscovery(result, false);
        await this.rebuildCatalog();
        this.supervisor = new ExtensionHostSupervisor({
            appVersion: this.options.appVersion,
            commit: this.options.commit,
            executable: this.options.executable,
            extensionHostPath: this.options.extensionHostPath,
            logger: this.options.logger,
            registrations: () => this.registrations(),
            requestApi: (request, signal) => this.handleApiRequest(request, signal),
        });
        this.supervisor.onEvent((event) => {
            const projected = projectExtensionHostViewEvent(
                event,
                this.states.get(event.extensionId)?.generation,
                this.catalogSnapshot?.views.find(({ id }) => id === event.viewId),
            );
            if (projected)
                this.dispatchEvent(
                    new CustomEvent(projected.eventName, { detail: projected.detail }),
                );
        });
        this.supervisor.onExit((code) => {
            this.options.logger.write('error', logEventCatalog.extensionHost.exit, {
                fields: { code },
            });
            for (const [extensionId, state] of this.states)
                this.states.set(extensionId, {
                    generation: state.generation + 1,
                    lifecycle: 'crashed',
                    error: {
                        code: 'EXTENSION_HOST_UNAVAILABLE',
                        message: 'Extension Host crashed and is restarting',
                    },
                });
            for (const grant of this.grants.values()) grant.apiToken = randomUUID();
            // The child-exit callback cannot await catalog publication; errors are logged locally.
            // eslint-disable-next-line unicorn/prefer-await
            this.rebuildCatalog().catch((error: unknown) =>
                this.options.logger.write(
                    'error',
                    logEventCatalog.extensionHost.catalogRebuildFailed,
                    {
                        fields: { message: error instanceof Error ? error.message : String(error) },
                    },
                ),
            );
        });
        this.supervisor.onStart(() => {
            this.options.logger.write('info', logEventCatalog.extensionHost.ready);
            for (const [extensionId, state] of this.states)
                if (state.lifecycle === 'crashed')
                    this.states.set(extensionId, {
                        generation: state.generation,
                        lifecycle: 'discovered',
                    });
            // The child-start callback cannot await catalog publication; errors are logged locally.
            // eslint-disable-next-line unicorn/prefer-await
            this.rebuildCatalog().catch((error: unknown) =>
                this.options.logger.write(
                    'error',
                    logEventCatalog.extensionHost.catalogRebuildFailed,
                    {
                        fields: { message: error instanceof Error ? error.message : String(error) },
                    },
                ),
            );
        });
        try {
            await this.supervisor.start();
        } catch (error) {
            this.options.logger.write('error', logEventCatalog.extensionHost.startFailed, {
                fields: { message: error instanceof Error ? error.message : String(error) },
            });
            await this.rebuildCatalog();
        }
    }

    catalog(): ViewCatalogSnapshot {
        if (!this.catalogSnapshot) throw new Error('Extension catalog has not started');
        return this.catalogSnapshot;
    }

    async treeChildren(parameters: {
        viewId: string;
        parentHandle?: string;
        requestId: string;
    }): Promise<TreeChildrenResult> {
        const extension = this.extensionForView(parameters.viewId);
        await this.activate(extension, `onView:${parameters.viewId}`);
        const generation = this.states.get(extension.extensionId)!.generation;
        const context = toExtensionViewEventContext(await this.options.activeContext());
        try {
            return (await this.supervisor?.request('treeChildren', {
                extensionId: extension.extensionId,
                generation,
                context,
                ...parameters,
            })) as TreeChildrenResult;
        } catch (error) {
            if (extensionFailure(error).code !== 'GENERATION_EXPIRED') throw error;
            /**
             * A provider refresh can invalidate either an in-flight root request or a branch handle before its
             * debounced treeChanged event reaches the Renderer. Recover both races with a current root snapshot while
             * preserving strict Extension Host rejection for every other failure.
             */
            const root = (await this.supervisor?.request('treeChildren', {
                extensionId: extension.extensionId,
                generation,
                viewId: parameters.viewId,
                requestId: parameters.requestId,
                context,
            })) as TreeChildrenResult;
            return { ...root, ...(parameters.parentHandle && { reset: true }) };
        }
    }

    async viewOperation(parameters: {
        viewId: string;
        operation: ExtensionWorkspaceOperation;
        arguments: unknown;
        requestId: string;
        context: ExtensionViewEventContext;
    }): Promise<unknown> {
        assertActiveViewContext(parameters.context, await this.options.activeContext());
        const extension = this.extensionForView(parameters.viewId);
        const descriptor = this.catalog().views.find(({ id }) => id === parameters.viewId);
        const expectedKind = parameters.operation.startsWith('files.')
            ? 'resource-explorer'
            : 'source-control';
        if (descriptor?.viewKind.kind !== expectedKind)
            throw Object.assign(
                new Error(`${expectedKind} operation cannot target ${parameters.viewId}`),
                { code: 'CAPABILITY_DENIED' },
            );
        await this.activate(extension, `onView:${parameters.viewId}`);
        assertActiveViewContext(parameters.context, await this.options.activeContext());
        const generation = this.states.get(extension.extensionId)!.generation;
        let result: unknown;
        try {
            result = await this.supervisor?.request('viewOperation', {
                extensionId: extension.extensionId,
                generation,
                ...parameters,
            });
        } catch (error) {
            /**
             * A nested Runtime request can reject before this outer view fence runs. Preserve an Extension Host
             * generation failure when that lifecycle actually changed; otherwise a retired Renderer scope owns the
             * outcome and must remain a typed cancellation instead of leaking Runtime conflict/generation details.
             */
            if (this.states.get(extension.extensionId)?.generation === generation)
                assertActiveViewContext(parameters.context, await this.options.activeContext());
            throw error;
        }
        if (this.states.get(extension.extensionId)?.generation !== generation)
            throw Object.assign(new Error('View provider generation expired'), {
                code: 'GENERATION_EXPIRED',
            });
        if (readWorkspaceOperations.has(parameters.operation))
            assertActiveViewContext(parameters.context, await this.options.activeContext());
        return validatedExtensionWorkspaceResult(parameters.operation, result);
    }

    async executeCommand(
        commandId: string,
        arguments_: unknown[],
        context: ExtensionViewEventContext,
    ): Promise<{ executed: true }> {
        const descriptor = this.catalog().commands.find(({ id }) => id === commandId);
        if (descriptor?.source.kind !== 'extension')
            throw Object.assign(new Error(`Extension command not found: ${commandId}`), {
                code: 'ACTIVATION_FAILED',
            });
        const extensionId = descriptor.source.extensionId;
        const extension = this.discovered.find(
            (extension) => extension.extensionId === extensionId,
        )!;
        await this.activate(extension, `onCommand:${commandId}`);
        return (await this.supervisor?.request('executeCommand', {
            extensionId: extension.extensionId,
            generation: this.states.get(extension.extensionId)!.generation,
            commandId,
            arguments: arguments_,
            context,
        })) as { executed: true };
    }

    async cancel(requestId: string): Promise<{ cancelled: boolean }> {
        return (await this.supervisor?.request('cancel', { requestId })) as { cancelled: boolean };
    }

    async activeContextChanged(context: ExtensionViewEventContext): Promise<void> {
        await this.supervisor?.request('activeContextChanged', { context });
    }

    async filesChanged(
        change: ExtensionFilesChange,
        context: ExtensionViewEventContext,
    ): Promise<void> {
        await this.supervisor?.request('filesChanged', { change, context });
    }

    async gitChanged(context: ExtensionViewEventContext): Promise<void> {
        await this.supervisor?.request('gitChanged', { context });
    }

    async projectStatusChanged(context: ExtensionViewEventContext): Promise<void> {
        await this.supervisor?.request('projectStatusChanged', { context });
    }

    async retry(extensionId: string): Promise<{ accepted: boolean; error?: ExtensionError }> {
        const state = this.states.get(extensionId);
        const rejected = this.rejected.find((extension) => extension.extensionId === extensionId);
        if (!state && !rejected)
            return {
                accepted: false,
                error: { code: 'MANIFEST_INVALID', message: 'Extension not found' },
            };
        if (rejected) {
            const result = await discoverExtensions({
                roots: this.options.extensionRoots,
                appVersion: this.options.appVersion,
                includeTestOnly: this.options.includeTestOnly,
            });
            const stillRejected = result.rejected.find(
                (extension) => extension.extensionId === extensionId,
            );
            if (stillRejected) {
                this.rejected = this.rejected.map((extension) =>
                    extension.extensionId === extensionId ? stillRejected : extension,
                );
                await this.rebuildCatalog(extensionId);
                return { accepted: false, error: stillRejected.error };
            }
            this.applyDiscovery(result, true);
            try {
                await this.supervisor?.restart();
                await this.rebuildCatalog(extensionId);
                return { accepted: true };
            } catch (error) {
                const failure = extensionFailure(error);
                for (const [currentExtensionId, currentState] of this.states)
                    this.states.set(currentExtensionId, {
                        ...currentState,
                        lifecycle: 'error',
                        error: failure,
                    });
                await this.rebuildCatalog(extensionId);
                return { accepted: false, error: failure };
            }
        }
        if (!state) throw new Error(`Extension retry state is missing: ${extensionId}`);
        for (const [currentExtensionId, currentState] of this.states)
            this.states.set(currentExtensionId, {
                generation: currentState.generation + 1,
                lifecycle: 'discovered',
            });
        for (const grant of this.grants.values()) grant.apiToken = randomUUID();
        try {
            await this.supervisor?.restart();
            await this.rebuildCatalog(extensionId);
            return { accepted: true };
        } catch (error) {
            const failure = extensionFailure(error);
            this.states.set(extensionId, {
                generation: state.generation + 1,
                lifecycle: 'error',
                error: failure,
            });
            await this.rebuildCatalog(extensionId);
            return { accepted: false, error: failure };
        }
    }

    processId(): number | undefined {
        return this.supervisor?.processId();
    }

    onCatalogChanged(listener: (event: CatalogChangedEvent) => void): () => void {
        return subscribeExtensionEvent(this, 'catalogChanged', listener);
    }

    onTreeChanged(listener: (event: TreeChangedEvent) => void): () => void {
        return subscribeExtensionEvent(this, 'treeChanged', listener);
    }

    onViewChanged(listener: (event: ViewChangedEvent) => void): () => void {
        return subscribeExtensionEvent(this, 'viewChanged', listener);
    }

    shutdown(): Promise<void> {
        return this.supervisor?.shutdown() ?? Promise.resolve();
    }
}

import { randomUUID } from 'node:crypto';

import type { ProjectStatusSummary } from '../../../packages/protocol/src/domain/domain';
import type {
    ExtensionCapability,
    ExtensionError,
    TreeChildrenResult,
    ViewCatalogSnapshot,
} from '../../../packages/protocol/src/domain/views';
import type {
    ExtensionHostApiRequest,
    ExtensionHostRegistration,
    ExtensionProjectStatusSummary,
} from '../../shared/extension-host-protocol';
import type { StructuredLogger } from '../../shared/node/logger';
import { logEventCatalog } from '../../shared/node/logger';
import type { CatalogExtensionState } from './catalog';
import { buildViewCatalog } from './catalog';
import type { DiscoveredExtension } from './discovery';
import { discoverExtensions } from './discovery';
import { ExtensionHostSupervisor } from './supervisor';

type DiscoveryResult = Awaited<ReturnType<typeof discoverExtensions>>;

export interface ExtensionServiceOptions {
    appVersion: string;
    commit: string;
    executable?: string;
    extensionHostPath: string;
    extensionRoots: string[];
    includeTestOnly: boolean;
    logger: StructuredLogger;
    activeContext(): Promise<{ projectId?: string; sessionId?: string }>;
    projectIds(): Promise<string[]>;
    projectStatus(sessionId: string, refreshToken?: string): Promise<ProjectStatusSummary>;
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
            projectId?: string;
            sessionId: string;
        },
        refreshToken?: string,
    ): Promise<ExtensionProjectStatusSummary> {
        const result = await this.options.projectStatus(active.sessionId, refreshToken);
        return this.projectStatusIfContextUnchanged(active, result);
    }

    private async projectStatusIfContextUnchanged(
        active: { projectId?: string; sessionId: string },
        result: ProjectStatusSummary,
    ): Promise<ExtensionProjectStatusSummary> {
        const current = await this.options.activeContext();
        if (current.sessionId !== active.sessionId || current.projectId !== active.projectId)
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
            this.states.set(extension.extensionId, { ...state, lifecycle: 'active' });
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
            getProjectStatus: async (request) => {
                this.assertApiAccess(request, 'projects.read');
                const active = await this.options.activeContext();
                if (!active.sessionId)
                    return {
                        repositories: [],
                        refreshedAt: Date.now(),
                        error: 'No active Session',
                    };
                const currentProjectIds = await this.options.projectIds();
                this.projectIds = currentProjectIds;
                const grant = this.grants.get(request.extensionId);
                const extension = this.discovered.find(
                    ({ extensionId }) => extensionId === request.extensionId,
                );
                if (grant && extension?.source === 'bundled')
                    grant.projectIds = new Set(currentProjectIds);
                if (
                    active.projectId &&
                    (!currentProjectIds.includes(active.projectId) ||
                        !grant?.projectIds.has(active.projectId))
                )
                    throw Object.assign(
                        new Error('Active Project is outside the extension grant'),
                        {
                            code: 'PROJECT_SCOPE_DENIED',
                        },
                    );
                return this.projectStatusForStableContext(
                    {
                        sessionId: active.sessionId,
                        ...(active.projectId && { projectId: active.projectId }),
                    },
                    request.params.refreshToken,
                );
            },
        });
        this.supervisor.onEvent((event) => {
            const state = this.states.get(event.extensionId);
            const descriptor = this.catalogSnapshot?.views.find(({ id }) => id === event.viewId);
            if (
                state?.generation !== event.generation ||
                descriptor?.source.kind !== 'extension' ||
                descriptor.source.extensionId !== event.extensionId
            )
                return;
            this.dispatchEvent(new CustomEvent('treeChanged', { detail: event }));
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
        try {
            return (await this.supervisor?.request('treeChildren', {
                extensionId: extension.extensionId,
                generation,
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
            })) as TreeChildrenResult;
            return { ...root, ...(parameters.parentHandle && { reset: true }) };
        }
    }

    async executeCommand(commandId: string, arguments_: unknown[]): Promise<{ executed: true }> {
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
        })) as { executed: true };
    }

    async cancel(requestId: string): Promise<{ cancelled: boolean }> {
        return (await this.supervisor?.request('cancel', { requestId })) as { cancelled: boolean };
    }

    async activeContextChanged(): Promise<void> {
        await this.supervisor?.request('activeContextChanged', {});
    }

    async projectStatusChanged(): Promise<void> {
        await this.supervisor?.request('projectStatusChanged', {});
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

    onCatalogChanged(
        listener: (event: { revision: number; extensionId?: string }) => void,
    ): () => void {
        const handler = (event: Event): void =>
            listener((event as CustomEvent<{ revision: number; extensionId?: string }>).detail);
        this.addEventListener('catalogChanged', handler);
        return () => this.removeEventListener('catalogChanged', handler);
    }

    onTreeChanged(listener: (event: { viewId: string; handles?: string[] }) => void): () => void {
        const handler = (event: Event): void =>
            listener((event as CustomEvent<{ viewId: string; handles?: string[] }>).detail);
        this.addEventListener('treeChanged', handler);
        return () => this.removeEventListener('treeChanged', handler);
    }

    shutdown(): Promise<void> {
        return this.supervisor?.shutdown() ?? Promise.resolve();
    }
}

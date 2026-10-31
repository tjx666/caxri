import { randomUUID } from 'node:crypto';

import type {
    AppSettings,
    ExtensionCapability,
    ExtensionError,
    ExtensionViewEventContext,
    ProjectStatusSummary,
    TreeChildrenResult,
    ViewCatalogSnapshot,
} from '@caxri/protocol';
import { CaxriError, extensionCommandResult, isExtensionViewReadOperation } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, SingleFlight } from '@caxri/system';

import type {
    ExtensionHostApiRequest,
    ExtensionHostRegistration,
    ExtensionViewOperation,
    ExtensionWorkspaceOperation,
} from '../../extension-host/protocol';
import type { CatalogExtensionState } from './catalog';
import { buildViewCatalog } from './catalog';
import type { DiscoveredExtension } from './discovery';
import { discoverExtensions } from './discovery';
import { ExtensionLanguage } from './extension-language';
import { extensionFailure } from './failure';
import type { ExtensionGrant } from './host-api-access';
import {
    grantsForExtension,
    projectStatusForExtension,
    projectStatusWithoutSession,
    readDeclaredConfig,
} from './host-api-access';
import type { ExtensionHostStartTrigger } from './host-start-gate';
import { ExtensionHostStartGate } from './host-start-gate';
import { logIgnoredLocalization } from './localization';
import type { CatalogChangedEvent, TreeChangedEvent, ViewChangedEvent } from './service-events';
import { projectExtensionHostViewEvent, subscribeExtensionEvent } from './service-events';
import type { ResolvedSessionContext, SessionContextReader, SessionScope } from './session-scope';
import {
    assertSessionScopeUnchanged,
    assertSessionWithinGrant,
    resolveViewContext,
    sessionScopeOf,
} from './session-scope';
import { ExtensionHostSupervisor } from './supervisor';
import { requestTreeChildren } from './tree-children';
import { assertViewContextCurrent, extensionForView } from './view-scope';
import {
    isReadWorkspaceOperation,
    workspaceCapability,
    workspaceParameters,
} from './workspace-requests';
import {
    validatedExtensionWorkspaceResult,
    validatedServerWorkspaceResult,
} from './workspace-results';

type DiscoveryResult = Awaited<ReturnType<typeof discoverExtensions>>;

export interface ExtensionServiceOptions {
    appVersion: string;
    bootId: string;
    buildId: string;
    commit: string;
    executable?: string;
    extensionHostPath: string;
    extensionRoots: string[];
    includeTestOnly: boolean;
    logger: StructuredLogger;
    serverId: string;
    userDataPath: string;
    projectIds(): Promise<string[]>;
    /**
     * One Session's Project and Workbench Root identities plus the visible Project IDs (`app.sessionContext`). Every
     * view request and nested API call is scoped to the Session it names, never to the focused window.
     */
    sessionContext(sessionId: string): Promise<ResolvedSessionContext>;
    projectStatus(sessionId: string, refreshToken?: string): Promise<ProjectStatusSummary>;
    settings?(): Promise<AppSettings>;
    workspaceRequest(
        operation: ExtensionWorkspaceOperation,
        parameters: unknown,
        context: { sessionId: string; workbenchRootProjectId: string },
        signal?: AbortSignal,
    ): Promise<unknown>;
}

/**
 * Owns manifest discovery, actual grants, the unique descriptor catalog, and Extension Host RPC.
 */
export class ExtensionService extends EventTarget {
    private catalogSnapshot?: ViewCatalogSnapshot;
    private discovered: DiscoveredExtension[] = [];
    private rejected: DiscoveryResult['rejected'] = [];
    private readonly states = new Map<string, CatalogExtensionState>();
    private readonly activations = new SingleFlight<string, void>();
    private readonly grants = new Map<string, ExtensionGrant>();
    private revision = 0;
    private supervisor?: ExtensionHostSupervisor;
    private readonly hostStartGate = new ExtensionHostStartGate();
    private projectIds: string[] = [];
    private readonly language = new ExtensionLanguage();
    private readonly readSessionContext: SessionContextReader = (sessionId) =>
        this.options.sessionContext(sessionId);

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
            logIgnoredLocalization(this.options.logger, extension);
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
                l10n: extension.localization.runtimeBundles,
            });
        }
        return registrations;
    }

    private async assertViewContext(context: ExtensionViewEventContext): Promise<void> {
        const resolved = await resolveViewContext(this.readSessionContext, context);
        assertViewContextCurrent(context, resolved);
    }

    private async rebuildCatalog(extensionId?: string): Promise<void> {
        this.revision += 1;
        this.catalogSnapshot = await buildViewCatalog({
            extensions: this.discovered,
            rejected: this.rejected,
            states: this.states,
            revision: this.revision,
            locale: this.language.locale,
        });
        this.dispatchEvent(
            new CustomEvent('catalogChanged', { detail: { revision: this.revision, extensionId } }),
        );
    }

    /**
     * For child-process callbacks, which cannot await catalog publication; a failure is logged locally.
     */
    private rebuildCatalogInBackground(): void {
        // eslint-disable-next-line unicorn/prefer-await
        this.rebuildCatalog().catch((error: unknown) =>
            this.options.logger.write('error', logEventCatalog.extensionHost.catalogRebuildFailed, {
                fields: { message: error instanceof Error ? error.message : String(error) },
            }),
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

    private async scopeForApi(
        request: ExtensionHostApiRequest,
        capability: ExtensionCapability,
        context: ExtensionViewEventContext,
    ): Promise<SessionScope> {
        this.assertApiAccess(request, capability);
        if (context.kind !== 'session')
            throw Object.assign(new Error('No Session in the request scope'), {
                code: 'PROJECT_SCOPE_DENIED',
            });
        const resolved = await this.options.sessionContext(context.sessionId);
        assertViewContextCurrent(context, resolved);
        this.projectIds = resolved.projectIds;
        const grant = this.grants.get(request.extensionId);
        const extension = this.discovered.find(
            ({ extensionId }) => extensionId === request.extensionId,
        );
        if (grant && extension?.source === 'bundled')
            grant.projectIds = new Set(resolved.projectIds);
        assertSessionWithinGrant(resolved, grant?.projectIds);
        return sessionScopeOf(context);
    }

    private async assertApiScopeCurrent(
        request: ExtensionHostApiRequest,
        capability: ExtensionCapability,
        scope: SessionScope,
    ): Promise<void> {
        this.assertApiAccess(request, capability);
        await assertSessionScopeUnchanged(this.readSessionContext, scope);
    }

    private async workspaceApiRequest(
        request: Extract<ExtensionHostApiRequest, { method: 'workspace.request' }>,
        signal?: AbortSignal,
    ): Promise<unknown> {
        const { operation } = request.params;
        const capability = workspaceCapability(operation);
        const scope = await this.scopeForApi(request, capability, request.params.context);
        const parameters = workspaceParameters(
            operation,
            request.params.arguments,
            scope.sessionId,
        );
        const workspaceResult = signal
            ? await this.options.workspaceRequest(operation, parameters, scope, signal)
            : await this.options.workspaceRequest(operation, parameters, scope);
        const result = validatedServerWorkspaceResult(operation, workspaceResult);
        if (isReadWorkspaceOperation(operation))
            await this.assertApiScopeCurrent(request, capability, scope);
        return result;
    }

    private async handleApiRequest(
        request: ExtensionHostApiRequest,
        signal?: AbortSignal,
    ): Promise<unknown> {
        if (request.method === 'workspace.request')
            return this.workspaceApiRequest(request, signal);
        if (request.method === 'workspace.getConfiguration')
            return readDeclaredConfig({
                assertAccess: () => this.assertApiAccess(request, 'settings.read'),
                discovered: this.discovered,
                extensionId: request.extensionId,
                key: request.params.key,
                settings: () => this.options.settings?.(),
            });
        this.assertApiAccess(request, 'projects.read');
        if (request.params.context.kind !== 'session') return projectStatusWithoutSession();
        const scope = await this.scopeForApi(request, 'projects.read', request.params.context);
        const result = await this.options.projectStatus(
            scope.sessionId,
            request.params.refreshToken,
        );
        await this.assertApiScopeCurrent(request, 'projects.read', scope);
        return projectStatusForExtension(result);
    }

    private extensionForView(viewId: string): DiscoveredExtension {
        return extensionForView(viewId, this.catalog(), this.discovered);
    }

    /**
     * Supervisor for a request that needs a live Extension Host; its `request` forks the child if it is not running.
     */
    private requireSupervisor(): ExtensionHostSupervisor | undefined {
        if (this.supervisor) this.hostStartGate.markRequested();
        return this.supervisor;
    }

    /**
     * Supervisor for a context-change notification, or `undefined` while the Host has never been started.
     */
    private startedSupervisor(): ExtensionHostSupervisor | undefined {
        return this.hostStartGate.hasStarted ? this.supervisor : undefined;
    }

    private activate(extension: DiscoveredExtension, reason: string): Promise<void> {
        const generation = this.states.get(extension.extensionId)!.generation;
        /**
         * Badge and content reads can activate together; a retired child must never own a new generation's work.
         */
        return this.activations.run(`${extension.extensionId}:${generation}`, () =>
            this.activateOnce(extension, reason),
        );
    }

    private async activateOnce(extension: DiscoveredExtension, reason: string): Promise<void> {
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
            await this.requireSupervisor()?.request('activate', {
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

    /**
     * Discovers Extensions, publishes the catalog, and prepares supervision. With `deferHost`, the Extension Host child
     * is not forked yet: it starts on {@link startHost} (Server Core calls it when a Desktop attaches) or on the first
     * request that needs it. A Server with no client, such as a detached remote Server waiting for Desktop to attach
     * over SSH, then does not keep an idle Extension Host resident.
     */
    async start(options: { deferHost?: boolean } = {}): Promise<void> {
        this.projectIds = await this.options.projectIds();
        const preference = (await this.options.settings?.())?.['workbench.language'] ?? null;
        this.language.update({ preference }, this.options.logger);
        const result = await discoverExtensions({
            roots: this.options.extensionRoots,
            appVersion: this.options.appVersion,
            includeTestOnly: this.options.includeTestOnly,
        });
        this.applyDiscovery(result, false);
        await this.rebuildCatalog();
        this.supervisor = new ExtensionHostSupervisor({
            appVersion: this.options.appVersion,
            bootId: this.options.bootId,
            buildId: this.options.buildId,
            commit: this.options.commit,
            executable: this.options.executable,
            extensionHostPath: this.options.extensionHostPath,
            logger: this.options.logger,
            serverId: this.options.serverId,
            userDataPath: this.options.userDataPath,
            configuration: () => ({
                extensions: this.registrations(),
                locale: this.language.locale,
            }),
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
        this.supervisor.onExit(() => {
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
            this.rebuildCatalogInBackground();
        });
        this.supervisor.onStart(() => {
            this.options.logger.write('info', logEventCatalog.extensionHost.ready, {
                fields: { trigger: this.hostStartGate.takeReadyTrigger() },
            });
            for (const [extensionId, state] of this.states)
                if (state.lifecycle === 'crashed')
                    this.states.set(extensionId, {
                        generation: state.generation,
                        lifecycle: 'discovered',
                    });
            this.rebuildCatalogInBackground();
        });
        if (!options.deferHost) await this.startHost('core-start');
    }

    /**
     * Forks the Extension Host once. A failed first start is logged and reflected in the catalog; later requests retry
     * through the supervisor's own start path, as before.
     */
    startHost(
        trigger: Extract<ExtensionHostStartTrigger, 'core-start' | 'desktop-attached'>,
    ): Promise<void> {
        const supervisor = this.supervisor;
        if (!supervisor) return Promise.resolve();
        return this.hostStartGate.start(trigger, async () => {
            try {
                await supervisor.start();
            } catch (error) {
                this.options.logger.write('error', logEventCatalog.extensionHost.startFailed, {
                    fields: { message: error instanceof Error ? error.message : String(error) },
                });
                await this.rebuildCatalog();
            }
        });
    }

    catalog(): ViewCatalogSnapshot {
        if (!this.catalogSnapshot) throw new Error('Extension catalog has not started');
        return this.catalogSnapshot;
    }

    /**
     * Scoped like `viewOperation` reads: the request's own Session, so deleting it or rebinding its Workbench Root
     * mid-load cancels instead of answering for a retired scope.
     */
    async treeChildren(parameters: {
        viewId: string;
        parentHandle?: string;
        requestId: string;
        context: ExtensionViewEventContext;
    }): Promise<TreeChildrenResult> {
        await this.assertViewContext(parameters.context);
        const extension = this.extensionForView(parameters.viewId);
        await this.activate(extension, `onView:${parameters.viewId}`);
        await this.assertViewContext(parameters.context);
        const generation = this.states.get(extension.extensionId)!.generation;
        const result = await requestTreeChildren(
            async (request) =>
                (await this.requireSupervisor()?.request('treeChildren', {
                    extensionId: extension.extensionId,
                    generation,
                    ...request,
                })) as TreeChildrenResult,
            parameters,
        );
        await this.assertViewContext(parameters.context);
        return result;
    }

    async viewOperation(parameters: {
        viewId: string;
        operation: ExtensionViewOperation;
        arguments: unknown;
        requestId: string;
        context: ExtensionViewEventContext;
    }): Promise<unknown> {
        await this.assertViewContext(parameters.context);
        const extension = this.extensionForView(parameters.viewId);
        const descriptor = this.catalog().views.find(({ id }) => id === parameters.viewId);
        const expectedKind = 'source-control';
        if (
            parameters.operation === 'badge.snapshot'
                ? descriptor?.badge !== true
                : descriptor?.viewKind.kind !== expectedKind
        )
            throw Object.assign(
                new Error(`${expectedKind} operation cannot target ${parameters.viewId}`),
                { code: 'CAPABILITY_DENIED' },
            );
        await this.activate(extension, `onView:${parameters.viewId}`);
        await this.assertViewContext(parameters.context);
        const generation = this.states.get(extension.extensionId)!.generation;
        let result: unknown;
        try {
            result = await this.requireSupervisor()?.request('viewOperation', {
                extensionId: extension.extensionId,
                generation,
                ...parameters,
            });
        } catch (error) {
            /**
             * A nested domain request can reject before this outer view fence runs, so a retired Renderer scope must
             * own the outcome before Extension failures are translated. Superseded reads are also normal request
             * retirement: Extension-only GENERATION_EXPIRED is not a public wire code, so letting it escape would decay
             * to INTERNAL and turn recovery races into false faults.
             */
            const isSameGeneration =
                this.states.get(extension.extensionId)?.generation === generation;
            if (isSameGeneration) await this.assertViewContext(parameters.context);
            const failure = extensionFailure(error);
            if (failure.code === 'GENERATION_EXPIRED') {
                if (isExtensionViewReadOperation(parameters.operation))
                    throw new CaxriError('CANCELLED', failure.message);
                /**
                 * Same generation and scope: the provider refused a mutation against a revision a concurrent snapshot
                 * replaced, before running anything: contention the Renderer re-resolves, not a fault (as INTERNAL it
                 * toasted whenever a click raced a watcher refresh). A turned-over generation stays a fault.
                 */
                const message = 'Source Control changed before the action ran';
                if (isSameGeneration) throw new CaxriError('CONFLICT', message);
            }
            throw error;
        }
        if (this.states.get(extension.extensionId)?.generation !== generation) {
            const message = 'View provider generation expired';
            if (isExtensionViewReadOperation(parameters.operation))
                throw new CaxriError('CANCELLED', message);
            throw Object.assign(new Error(message), { code: 'GENERATION_EXPIRED' });
        }
        if (isExtensionViewReadOperation(parameters.operation))
            await this.assertViewContext(parameters.context);
        return validatedExtensionWorkspaceResult(parameters.operation, result);
    }

    /**
     * Runs a command for the Session its caller captured. The Session must still exist on the same Workbench Root, but
     * it need not be the focused window's: a command from a second window or a phone acts on the Session it shows.
     */
    async executeCommand(
        commandId: string,
        arguments_: unknown[],
        context: ExtensionViewEventContext,
    ) {
        if (context.kind !== 'session')
            throw new CaxriError('FORBIDDEN', 'Extension commands require a Session');
        await this.assertViewContext(context);
        const descriptor = this.catalog().commands.find(({ id }) => id === commandId);
        if (descriptor?.source.kind !== 'extension')
            throw Object.assign(new Error(`Extension command not found: ${commandId}`), {
                code: 'ACTIVATION_FAILED',
            });
        const extensionId = descriptor.source.extensionId;
        const extension = this.discovered.find((item) => item.extensionId === extensionId)!;
        await this.activate(extension, `onCommand:${commandId}`);
        // The Extension Host is a separate process, so its result is revalidated here.
        const result = await this.requireSupervisor()?.request('executeCommand', {
            extensionId: extension.extensionId,
            generation: this.states.get(extension.extensionId)!.generation,
            commandId,
            arguments: arguments_,
            context,
        });
        return extensionCommandResult(result);
    }

    async cancel(requestId: string): Promise<{ cancelled: boolean }> {
        const supervisor = this.startedSupervisor();
        if (!supervisor) return { cancelled: false };
        return (await supervisor.request('cancel', { requestId })) as { cancelled: boolean };
    }

    /**
     * Switches the Host before republishing the catalog, whose `catalogChanged` makes clients re-read titles and views.
     */
    async updateLanguage(update: Parameters<ExtensionLanguage['update']>[0]): Promise<void> {
        const locale = this.language.update(update, this.options.logger);
        if (!locale) return;
        await this.startedSupervisor()?.request('languageChanged', { locale });
        await this.rebuildCatalog();
    }

    /**
     * Re-reads `workbench.language` after any settings change, since `settings.changed` names no key.
     */
    async settingsChanged(): Promise<void> {
        const settings = await this.options.settings?.();
        if (settings) await this.updateLanguage({ preference: settings['workbench.language'] });
    }

    async activeContextChanged(context: ExtensionViewEventContext): Promise<void> {
        await this.startedSupervisor()?.request('activeContextChanged', { context });
    }

    async gitChanged(context: ExtensionViewEventContext): Promise<void> {
        await this.startedSupervisor()?.request('gitChanged', { context });
    }

    async projectStatusChanged(context: ExtensionViewEventContext): Promise<void> {
        await this.startedSupervisor()?.request('projectStatusChanged', { context });
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
                await this.requireSupervisor()?.restart();
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
            await this.requireSupervisor()?.restart();
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

    /**
     * Called synchronously at the start of Server Core's `stop()` so an Extension Host killed by the same OS signal
     * before {@link shutdown} runs is treated as teardown rather than a crash to restart.
     */
    markCoreStopping(): void {
        this.hostStartGate.markCoreStopping();
        this.supervisor?.markCoreStopping();
    }

    shutdown(): Promise<void> {
        return this.supervisor?.shutdown() ?? Promise.resolve();
    }
}

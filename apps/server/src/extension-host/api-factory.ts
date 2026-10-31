import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { AppLocale, ExtensionCommandResult, TreeItemDto } from '@caxri/protocol';
import {
    extensionCommandResult,
    MAX_VIEW_TREE_DEPTH,
    MAX_VIEW_TREE_HANDLES,
    MAX_VIEW_TREE_ITEMS,
    MAX_VIEW_TREE_PAYLOAD_BYTES,
} from '@caxri/protocol';
import { disposeAll } from '@caxri/utils';
import type {
    CancellationToken,
    CaxriApi,
    ExtensionContext,
    ProjectStatusRequestOptions,
    TreeDataProvider,
    WorkspaceChangeContext,
} from 'caxri';
import { CancellationTokenSource, Disposable, EventEmitter } from 'caxri';

import { extensionApiRuntime } from './api-runtime';
import { createLanguageApi, setAppLanguage } from './app-language';
import type { HostRequestState } from './extension-error';
import {
    createProviderRequestScope,
    hostError,
    providerFailure,
    runExtensionCode,
    supersededError,
} from './extension-error';
import type {
    ExtensionHostMessage,
    ExtensionHostRegistration,
    ExtensionViewEventScope,
    ExtensionWorkspaceOperation,
} from './protocol';
import {
    createServerApiRequester,
    requestConfig,
    requestProjectStatus,
} from './server-api-binding';
import {
    rejectPendingApiRequests,
    settleApiReply as settleServerApiReply,
} from './server-api-request';
import { serializeTreeItem } from './tree-item-dto';
import type { ProviderRegistration, TreeScopeState } from './tree-provider-handles';
import {
    collectDescendantHandles,
    resetTreeScope,
    retireTreeHandles,
    stableTreeHandle,
    treeScopeFor,
    treeScopeKey,
} from './tree-provider-handles';
import type { TreeRefreshBatch } from './tree-refresh-coalescing';
import { mergeTreeRefresh } from './tree-refresh-coalescing';
import {
    currentViewEventContext,
    fireWorkspaceChange,
    withViewEventContext,
    workspaceChangeContext,
} from './view-event-context';
import {
    createControlledViewRegistrationApi,
    didCancelViewRequest,
    retireViewProviders,
} from './view-provider-service';
import { createWorkspaceApiClient } from './workspace-api-client';

interface ApiBinding {
    api: CaxriApi;
    notifyActiveContext(context: ExtensionViewEventScope): void;
    notifyGit(context: ExtensionViewEventScope): void;
    notifyLanguage(locale: AppLocale): void;
    notifyProjectStatus(context: ExtensionViewEventScope): void;
    runtime: typeof extensionApiRuntime;
}

interface ExtensionInstance {
    registration: ExtensionHostRegistration;
    apiBinding: ApiBinding;
    context: ExtensionContext;
    activation?: Promise<void>;
    retired: boolean;
}

const extensions = new Map<string, ExtensionInstance>();
const providers = new Map<string, ProviderRegistration>();
const commands = new Map<
    string,
    {
        extensionId: string;
        generation: number;
        run: (...arguments_: readonly unknown[]) => unknown;
    }
>();
const cancellations = new Map<string, CancellationTokenSource>();
/**
 * Coalesced tree refreshes keyed by view and scope, so a refresh for one Session never flushes or merges into another
 * Session's pending batch.
 */
const pendingRefreshes = new Map<
    string,
    {
        viewId: string;
        batch: TreeRefreshBatch;
        timer: NodeJS.Timeout;
        context: ExtensionViewEventScope;
    }
>();

function pendingRefreshKey(viewId: string, scopeKey: string): string {
    return `${viewId}\0${scopeKey}`;
}

function cancelPendingRefresh(viewId: string): void {
    for (const [key, pending] of pendingRefreshes) {
        if (pending.viewId !== viewId) continue;
        clearTimeout(pending.timer);
        pendingRefreshes.delete(key);
    }
}

function send(message: ExtensionHostMessage): void {
    if (process.connected) process.send?.(message);
}

function assertCurrent(extensionId: string, generation: number): ExtensionInstance {
    const runtime = extensions.get(extensionId);
    if (!runtime || runtime.registration.generation !== generation)
        throw hostError('GENERATION_EXPIRED', `Extension generation expired: ${extensionId}`);
    return runtime;
}

function scheduleRefresh(viewId: string, provider: ProviderRegistration, changed: unknown): void {
    if (providers.get(viewId) !== provider) return;
    const context = currentViewEventContext();
    // Generic TreeDataProviders may refresh outside a Server-scoped notification (for example, an internal timer). Keep
    // every scope's local handles generation-safe, but fail closed by suppressing an unscoped cross-process event.
    if (!context) {
        if (changed === undefined)
            for (const state of provider.scopes.values()) resetTreeScope(state);
        return;
    }
    const scopeKey = treeScopeKey(context);
    const state = provider.scopes.get(scopeKey);
    if (changed === undefined && state) resetTreeScope(state);
    const key = pendingRefreshKey(viewId, scopeKey);
    const mergeWith = pendingRefreshes.get(key);
    const changedElements: readonly unknown[] = Array.isArray(changed)
        ? changed
        : changed !== undefined
          ? [changed]
          : [];
    const handles = changedElements
        .map((element) =>
            typeof element === 'object' && element !== null
                ? state?.handles.get(element)
                : undefined,
        )
        .filter((handle): handle is string => Boolean(handle));
    const batch = mergeTreeRefresh(mergeWith?.batch, changed === undefined ? undefined : handles);
    if (!batch || batch === mergeWith?.batch) return;
    if (mergeWith) clearTimeout(mergeWith.timer);
    const timer = setTimeout(() => {
        pendingRefreshes.delete(key);
        if (providers.get(viewId) !== provider) return;
        send({
            type: 'event',
            event: 'treeChanged',
            extensionId: provider.extensionId,
            generation: provider.generation,
            viewId,
            eventId: randomUUID(),
            context,
            ...(!batch.root && { handles: [...batch.handles] }),
        });
    }, 25);
    timer.unref();
    pendingRefreshes.set(key, { viewId, batch, timer, context });
}

function createBinding(registration: ExtensionHostRegistration): ApiBinding {
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    const activeContext = new EventEmitter<WorkspaceChangeContext>();
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    const git = new EventEmitter<WorkspaceChangeContext>();
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    const projectStatus = new EventEmitter<WorkspaceChangeContext>();
    const language = createLanguageApi(registration);
    const allowedViewKinds = new Map(
        Object.values(registration.manifest.contributes.views)
            .flat()
            .map(({ id, type }) => [id, type]),
    );
    const allowedCommands = new Set(
        registration.manifest.contributes.commands.map(({ command }) => command),
    );
    const request = createServerApiRequester({
        apiToken: registration.apiToken,
        extensionId: registration.extensionId,
        generation: registration.generation,
        assertCurrent: () => assertCurrent(registration.extensionId, registration.generation),
        isApiTokenCurrent: (currentToken) =>
            extensions
                .values()
                .some(({ registration: current }) => current.apiToken === currentToken),
        send,
    });
    const workspace = createWorkspaceApiClient(
        <Result>(
            operation: ExtensionWorkspaceOperation,
            arguments_: unknown,
            token?: CancellationToken,
        ) =>
            request<Result>(
                {
                    method: 'workspace.request',
                    params: {
                        operation,
                        arguments: arguments_,
                        context: currentViewEventContext() ?? { kind: 'no-session' },
                    },
                },
                token,
            ),
    );
    const controlledViews = createControlledViewRegistrationApi({
        extensionId: registration.extensionId,
        generation: registration.generation,
        viewKinds: allowedViewKinds,
        badgeViewIds: new Set(
            Object.values(registration.manifest.contributes.views)
                .flat()
                .flatMap((view) => (view.badge ? [view.id] : [])),
        ),
        assertCurrent: () => {
            assertBindingCurrent(registration);
        },
        send,
    });
    const api: CaxriApi = Object.freeze({
        commands: Object.freeze({
            registerCommand(
                commandId: string,
                callback: (...arguments_: readonly unknown[]) => unknown,
            ) {
                assertBindingCurrent(registration);
                if (!allowedCommands.has(commandId))
                    throw Object.assign(new Error(`Command is not declared: ${commandId}`), {
                        code: 'CAPABILITY_DENIED',
                    });
                commands.set(commandId, {
                    extensionId: registration.extensionId,
                    generation: registration.generation,
                    run: callback,
                });
                return new Disposable(() => commands.delete(commandId));
            },
        }),
        views: Object.freeze({
            ...controlledViews,
            registerTreeDataProvider<T>(viewId: string, provider: TreeDataProvider<T>) {
                assertBindingCurrent(registration);
                if (allowedViewKinds.get(viewId) !== 'tree')
                    throw Object.assign(new Error(`View is not declared: ${viewId}`), {
                        code: 'PROVIDER_MISSING',
                    });
                if (providers.has(viewId))
                    throw Object.assign(new Error(`Tree provider already registered: ${viewId}`), {
                        code: 'DUPLICATE_ID',
                    });
                const providerRegistration: ProviderRegistration = {
                    extensionId: registration.extensionId,
                    generation: registration.generation,
                    provider,
                    scopes: new Map(),
                };
                if (provider.onDidChangeTreeData)
                    providerRegistration.subscription = provider.onDidChangeTreeData((element) =>
                        scheduleRefresh(viewId, providerRegistration, element),
                    );
                providers.set(viewId, providerRegistration);
                return new Disposable(() => {
                    providerRegistration.subscription?.dispose();
                    if (providers.get(viewId) === providerRegistration) {
                        cancelPendingRefresh(viewId);
                        providers.delete(viewId);
                    }
                });
            },
        }),
        workspace: Object.freeze({
            onDidChangeActiveContext: activeContext.event,
            onDidChangeGit: git.event,
            onDidChangeProjectStatus: projectStatus.event,
            git: workspace.git,
            getCurrentContext: () => {
                const context = currentViewEventContext();
                return context ? workspaceChangeContext(context) : undefined;
            },
            getConfiguration: <Value>(key: string) => requestConfig<Value>(request, key),
            getProjectStatus: (options?: ProjectStatusRequestOptions) => {
                assertBindingCurrent(registration);
                return requestProjectStatus(
                    request,
                    currentViewEventContext() ?? { kind: 'no-session' },
                    options?.refreshToken,
                );
            },
        }),
        env: language.env,
        l10n: language.l10n,
        supersededError,
    });
    return {
        api,
        notifyActiveContext: (context) => fireWorkspaceChange(activeContext, context),
        notifyGit: (context) => fireWorkspaceChange(git, context),
        notifyLanguage: (locale) => language.notify(locale),
        notifyProjectStatus: (context) => fireWorkspaceChange(projectStatus, context),
        runtime: extensionApiRuntime,
    };
}

function notifyActivated(notify: (binding: ApiBinding) => void): { notified: number } {
    let notified = 0;
    for (const runtime of extensions.values()) {
        if (!runtime.activation) continue;
        notify(runtime.apiBinding);
        notified += 1;
    }
    return { notified };
}

export function notifyActiveContextChanged(context: ExtensionViewEventScope): { notified: number } {
    return notifyActivated((binding) => binding.notifyActiveContext(context));
}

export function notifyProjectStatusChanged(context: ExtensionViewEventScope): { notified: number } {
    return notifyActivated((binding) => binding.notifyProjectStatus(context));
}

/**
 * Switches the language bindings read, then lets activated extensions drop copy cached in the old one.
 */
export function notifyLanguageChanged(locale: AppLocale): { notified: number } {
    setAppLanguage(locale);
    return notifyActivated((binding) => binding.notifyLanguage(locale));
}

export function notifyGitChanged(context: ExtensionViewEventScope): { notified: number } {
    return notifyActivated((binding) => binding.notifyGit(context));
}

function disposeExtension(runtime: ExtensionInstance): void {
    runtime.retired = true;
    // One extension disposable must not prevent the rest of its generation from retiring, and a retiring extension's
    // teardown failure has no caller left to act on it.
    disposeAll(runtime.context.subscriptions.toReversed());
    for (const [viewId, provider] of providers)
        if (provider.extensionId === runtime.registration.extensionId) {
            cancelPendingRefresh(viewId);
            providers.delete(viewId);
        }
    for (const [commandId, command] of commands)
        if (command.extensionId === runtime.registration.extensionId) commands.delete(commandId);
    retireViewProviders(runtime.registration.extensionId);
}

export function configureExtensions(registrations: readonly ExtensionHostRegistration[]): void {
    for (const runtime of extensions.values()) disposeExtension(runtime);
    extensions.clear();
    for (const { timer } of pendingRefreshes.values()) clearTimeout(timer);
    pendingRefreshes.clear();
    rejectPendingApiRequests('Extension generation was reconfigured');
    for (const registration of registrations) {
        const context: ExtensionContext = {
            extensionId: registration.extensionId,
            generation: registration.generation,
            subscriptions: [],
        };
        extensions.set(registration.extensionId, {
            registration,
            context,
            apiBinding: createBinding(registration),
            retired: false,
        });
    }
}

export function extensionApiBinding(apiToken: string): ApiBinding {
    const runtime = extensions
        .values()
        .find(({ registration }) => registration.apiToken === apiToken);
    if (!runtime) throw hostError('GENERATION_EXPIRED', 'Extension API binding has expired');
    return runtime.apiBinding;
}

function assertBindingCurrent(registration: ExtensionHostRegistration): ExtensionInstance {
    const runtime = extensions.get(registration.extensionId);
    if (
        !runtime ||
        runtime.retired ||
        runtime.registration.generation !== registration.generation ||
        runtime.registration.apiToken !== registration.apiToken
    )
        throw hostError('GENERATION_EXPIRED', 'Extension API binding has expired');
    return runtime;
}

function isInstanceCurrent(runtime: ExtensionInstance): boolean {
    return extensions.get(runtime.registration.extensionId) === runtime && !runtime.retired;
}

function assertInstanceCurrent(runtime: ExtensionInstance): void {
    if (!isInstanceCurrent(runtime))
        throw hostError('GENERATION_EXPIRED', 'Extension generation expired during the request');
}

export async function activateExtension(extensionId: string, generation: number): Promise<void> {
    const runtime = assertCurrent(extensionId, generation);
    runtime.activation ??= (async () => {
        const entryUrl = pathToFileURL(runtime.registration.entryPath);
        entryUrl.searchParams.set('caxriGeneration', String(generation));
        const module = (await import(entryUrl.href)) as {
            activate?: (context: ExtensionContext) => unknown;
        };
        if (typeof module.activate !== 'function')
            throw Object.assign(new Error(`Extension ${extensionId} does not export activate()`), {
                code: 'ACTIVATION_FAILED',
            });
        const activate = module.activate;
        await runExtensionCode(
            () => activate(runtime.context),
            () => ({ cancelled: false, generationExpired: !isInstanceCurrent(runtime) }),
            { message: 'Extension activation failed', code: 'ACTIVATION_FAILED' },
        );
        assertInstanceCurrent(runtime);
    })();
    await runtime.activation;
}

function isRequestCancelled(cancellation: CancellationTokenSource): boolean {
    return cancellation.token.isCancellationRequested;
}

function assertRefreshCurrent(state: TreeScopeState, refreshEpoch: number): void {
    if (state.refreshEpoch !== refreshEpoch)
        throw hostError(
            'GENERATION_EXPIRED',
            'Tree provider refreshed while the request was running',
        );
}

export async function getTreeChildren(parameters: {
    extensionId: string;
    generation: number;
    viewId: string;
    parentHandle?: string;
    requestId: string;
    context?: ExtensionViewEventScope;
}): Promise<{ items: TreeItemDto[] }> {
    await activateExtension(parameters.extensionId, parameters.generation);
    const runtime = assertCurrent(parameters.extensionId, parameters.generation);
    const provider = providers.get(parameters.viewId);
    if (
        !provider ||
        provider.extensionId !== parameters.extensionId ||
        provider.generation !== parameters.generation
    )
        throw Object.assign(new Error(`No provider registered for ${parameters.viewId}`), {
            code: 'PROVIDER_MISSING',
        });
    const state = treeScopeFor(provider, treeScopeKey(parameters.context));
    const parent = parameters.parentHandle
        ? state.elements.get(parameters.parentHandle)
        : undefined;
    if (parent === undefined && parameters.parentHandle)
        throw hostError('GENERATION_EXPIRED', 'Tree handle belongs to an expired generation');
    const parentDepth = parameters.parentHandle ? state.depths.get(parameters.parentHandle) : -1;
    if (parentDepth === undefined)
        throw hostError('GENERATION_EXPIRED', 'Tree handle depth belongs to an expired generation');
    const childDepth = parentDepth + 1;
    if (childDepth > MAX_VIEW_TREE_DEPTH)
        throw Object.assign(new Error('Tree provider exceeded the depth limit'), {
            code: 'PROVIDER_CAPACITY',
        });
    const parentKey = parameters.parentHandle ?? '';
    if (cancellations.has(parameters.requestId))
        throw Object.assign(new Error('Tree request id is already active'), {
            code: 'PROVIDER_CAPACITY',
        });
    const cancellation = new CancellationTokenSource();
    const refreshEpoch = state.refreshEpoch;
    const scope = createProviderRequestScope();
    cancellations.set(parameters.requestId, cancellation);
    /**
     * Read at catch time so turnover that happened while the provider was running counts. The provider's own refresh
     * epoch is not consulted here; see `HostRequestState.generationExpired`.
     */
    const treeHostState = (): Omit<HostRequestState, 'scope'> => ({
        cancelled: isRequestCancelled(cancellation),
        generationExpired: !isInstanceCurrent(runtime),
    });
    const invokeProvider = <Result>(call: () => Promise<Result> | Result): Promise<Result> =>
        runExtensionCode(
            () => (parameters.context ? withViewEventContext(parameters.context, call) : call()),
            treeHostState,
            { message: 'Tree provider failed' },
            scope,
        );
    try {
        const children =
            (await invokeProvider(() =>
                provider.provider.getChildren(parent, cancellation.token),
            )) ?? [];
        assertInstanceCurrent(runtime);
        assertRefreshCurrent(state, refreshEpoch);
        if (isRequestCancelled(cancellation)) return { items: [] };
        if (children.length > MAX_VIEW_TREE_ITEMS)
            throw Object.assign(new Error('Tree provider exceeded the item limit'), {
                code: 'PROVIDER_CAPACITY',
            });
        const stagedItems = await Promise.all(
            children.map(async (element) => {
                const item = await invokeProvider(() => provider.provider.getTreeItem(element));
                if (!item)
                    throw Object.assign(new Error('Tree provider returned an empty TreeItem'), {
                        code: 'PROVIDER_FAILED',
                    });
                return { element, item };
            }),
        );
        assertInstanceCurrent(runtime);
        assertRefreshCurrent(state, refreshEpoch);
        if (isRequestCancelled(cancellation)) return { items: [] };
        assertInstanceCurrent(runtime);
        const retiredHandles = collectDescendantHandles(state, parentKey);
        if (state.elements.size - retiredHandles.size + children.length > MAX_VIEW_TREE_HANDLES)
            throw Object.assign(new Error('Tree provider exceeded the handle limit'), {
                code: 'PROVIDER_CAPACITY',
            });
        let nextHandle = state.nextHandle;
        const stagedIds = new Set<string>();
        const stagedObjects = new WeakSet<object>();
        const stagedHandles = new Set<string>();
        const prepared = stagedItems.map(({ element, item }) => {
            let handle: string;
            if (item.id) {
                if (stagedIds.has(item.id))
                    throw Object.assign(new Error(`Duplicate TreeItem id: ${item.id}`), {
                        code: 'DUPLICATE_ID',
                    });
                stagedIds.add(item.id);
                const existingHandle = state.ids.get(item.id);
                if (existingHandle && !retiredHandles.has(existingHandle))
                    throw Object.assign(new Error(`Duplicate TreeItem id: ${item.id}`), {
                        code: 'DUPLICATE_ID',
                    });
                handle = stableTreeHandle(item.id);
            } else {
                const objectElement =
                    typeof element === 'object' && element !== null ? element : undefined;
                if (objectElement && stagedObjects.has(objectElement))
                    throw Object.assign(new Error('Tree provider returned one element twice'), {
                        code: 'DUPLICATE_ID',
                    });
                if (objectElement) stagedObjects.add(objectElement);
                const existingHandle = objectElement ? state.handles.get(objectElement) : undefined;
                if (existingHandle && !retiredHandles.has(existingHandle))
                    throw Object.assign(new Error('Tree element belongs to another parent'), {
                        code: 'DUPLICATE_ID',
                    });
                handle = existingHandle ?? `${parameters.generation}:${++nextHandle}`;
            }
            if (stagedHandles.has(handle))
                throw Object.assign(new Error('Tree provider returned duplicate identity'), {
                    code: 'DUPLICATE_ID',
                });
            stagedHandles.add(handle);
            let dto: TreeItemDto;
            try {
                dto = serializeTreeItem(handle, item);
            } catch (error) {
                throw providerFailure(error, { ...treeHostState(), scope }, 'Tree provider failed');
            }
            return { dto, element, handle };
        });
        const items = prepared.map(({ dto }) => dto);
        if (Buffer.byteLength(JSON.stringify(items), 'utf8') > MAX_VIEW_TREE_PAYLOAD_BYTES)
            throw Object.assign(new Error('Tree provider payload exceeded the byte limit'), {
                code: 'PAYLOAD_TOO_LARGE',
            });
        if (isRequestCancelled(cancellation)) return { items: [] };
        state.nextHandle = nextHandle;
        retireTreeHandles(state, retiredHandles);
        state.children.set(parentKey, new Set(prepared.map(({ handle }) => handle)));
        for (const { dto, element, handle } of prepared) {
            state.elements.set(handle, element);
            state.depths.set(handle, childDepth);
            state.parents.set(handle, parentKey);
            if (dto.id) {
                state.ids.set(dto.id, handle);
                state.itemIds.set(handle, dto.id);
            }
            if (typeof element === 'object' && element !== null) state.handles.set(element, handle);
        }
        return { items };
    } finally {
        cancellations.delete(parameters.requestId);
    }
}

export async function executeExtensionCommand(parameters: {
    extensionId: string;
    generation: number;
    commandId: string;
    arguments: unknown[];
    context: ExtensionViewEventScope;
}): Promise<ExtensionCommandResult> {
    await activateExtension(parameters.extensionId, parameters.generation);
    const runtime = assertCurrent(parameters.extensionId, parameters.generation);
    const command = commands.get(parameters.commandId);
    if (
        !command ||
        command.extensionId !== parameters.extensionId ||
        command.generation !== parameters.generation
    )
        throw Object.assign(new Error(`Command is not registered: ${parameters.commandId}`), {
            code: 'ACTIVATION_FAILED',
        });
    // Commands have no host cancellation token, so only instance/registration turnover or a host-rejected API call can
    // corroborate a non-fault code; a re-thrown host-minted error loses its origin here like at a provider.
    const value = await runExtensionCode(
        () => withViewEventContext(parameters.context, () => command.run(...parameters.arguments)),
        () => ({ cancelled: false, generationExpired: !isInstanceCurrent(runtime) }),
        { message: 'Extension command failed', code: 'ACTIVATION_FAILED' },
    );
    assertInstanceCurrent(runtime);
    return extensionCommandResult(value);
}

export function cancelTreeRequest(requestId: string): { cancelled: boolean } {
    const cancellation = cancellations.get(requestId);
    cancellation?.cancel();
    return { cancelled: Boolean(cancellation) || didCancelViewRequest(requestId) };
}

export function settleApiReply(message: {
    id: string;
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string };
}): void {
    settleServerApiReply(message, (apiToken) =>
        extensions.values().some(({ registration }) => registration.apiToken === apiToken),
    );
}

export function disposeAllExtensions(): void {
    for (const runtime of extensions.values()) disposeExtension(runtime);
    extensions.clear();
    retireViewProviders();
    rejectPendingApiRequests('Extension Host is stopping', 'EXTENSION_HOST_UNAVAILABLE');
}

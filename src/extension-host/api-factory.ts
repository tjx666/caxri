import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { TreeItemDto } from '@caxri/protocol';
import {
    MAX_VIEW_TREE_DEPTH,
    MAX_VIEW_TREE_HANDLES,
    MAX_VIEW_TREE_ITEMS,
    MAX_VIEW_TREE_PAYLOAD_BYTES,
    treeItemSchema,
} from '@caxri/protocol';
import type {
    CaxriApi,
    DisposableLike,
    ExtensionContext,
    ProjectStatusRequestOptions,
    ProjectStatusSummary,
    TreeDataProvider,
} from 'caxri';
import {
    CancellationTokenSource,
    Disposable,
    EventEmitter,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState,
} from 'caxri';

import type {
    ExtensionHostApiRequest,
    ExtensionHostMessage,
    ExtensionHostRegistration,
} from '../shared/extension-host-protocol';
import { MAX_EXTENSION_PROJECT_STATUS_REFRESH_TOKEN_LENGTH } from '../shared/extension-host-protocol';
import type { TreeRefreshBatch } from './tree-refresh-coalescing';
import { mergeTreeRefresh } from './tree-refresh-coalescing';

interface ApiBinding {
    api: CaxriApi;
    notifyActiveContext(): void;
    notifyProjectStatus(): void;
    runtime: {
        CancellationTokenSource: typeof CancellationTokenSource;
        Disposable: typeof Disposable;
        EventEmitter: typeof EventEmitter;
        ThemeIcon: typeof ThemeIcon;
        TreeItem: typeof TreeItem;
        TreeItemCollapsibleState: typeof TreeItemCollapsibleState;
    };
}

interface ProviderRegistration {
    extensionId: string;
    generation: number;
    provider: TreeDataProvider<unknown>;
    subscription?: DisposableLike;
    elements: Map<string, unknown>;
    handles: WeakMap<object, string>;
    depths: Map<string, number>;
    children: Map<string, Set<string>>;
    parents: Map<string, string>;
    ids: Map<string, string>;
    itemIds: Map<string, string>;
    nextHandle: number;
    refreshEpoch: number;
}

interface ExtensionRuntime {
    registration: ExtensionHostRegistration;
    apiBinding: ApiBinding;
    context: ExtensionContext;
    activation?: Promise<void>;
    retired: boolean;
}

interface PendingApiRequest {
    apiToken: string;
    resolve(value: ProjectStatusSummary): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
}

const extensions = new Map<string, ExtensionRuntime>();
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
const pendingApi = new Map<string, PendingApiRequest>();
const pendingRefreshes = new Map<string, { batch: TreeRefreshBatch; timer: NodeJS.Timeout }>();
const HOST_API_TIMEOUT_MS = 15_000;
const ROOT_TREE_PARENT = '';

function cancelPendingRefresh(viewId: string): void {
    const pending = pendingRefreshes.get(viewId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRefreshes.delete(viewId);
}

function send(message: ExtensionHostMessage): void {
    if (process.connected) process.send?.(message);
}

function assertCurrent(extensionId: string, generation: number): ExtensionRuntime {
    const runtime = extensions.get(extensionId);
    if (!runtime || runtime.registration.generation !== generation)
        throw Object.assign(new Error(`Extension generation expired: ${extensionId}`), {
            code: 'GENERATION_EXPIRED',
        });
    return runtime;
}

function scheduleRefresh(viewId: string, provider: ProviderRegistration, changed: unknown): void {
    if (providers.get(viewId) !== provider) return;
    if (changed === undefined) {
        provider.refreshEpoch += 1;
        provider.elements.clear();
        provider.depths.clear();
        provider.children.clear();
        provider.parents.clear();
        provider.ids.clear();
        provider.itemIds.clear();
        provider.handles = new WeakMap();
        provider.nextHandle = 0;
    }
    const existing = pendingRefreshes.get(viewId);
    const changedElements: readonly unknown[] = Array.isArray(changed)
        ? changed
        : changed !== undefined
          ? [changed]
          : [];
    const handles = changedElements
        .map((element) =>
            typeof element === 'object' && element !== null
                ? provider.handles.get(element)
                : undefined,
        )
        .filter((handle): handle is string => Boolean(handle));
    const batch = mergeTreeRefresh(existing?.batch, changed === undefined ? undefined : handles);
    if (!batch || batch === existing?.batch) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
        pendingRefreshes.delete(viewId);
        if (providers.get(viewId) !== provider) return;
        send({
            type: 'event',
            event: 'treeChanged',
            extensionId: provider.extensionId,
            generation: provider.generation,
            viewId,
            ...(!batch.root && { handles: [...batch.handles] }),
        });
    }, 25);
    timer.unref();
    pendingRefreshes.set(viewId, { batch, timer });
}

function requestProjectStatus(
    extensionId: string,
    generation: number,
    apiToken: string,
    refreshToken?: string,
): Promise<ProjectStatusSummary> {
    assertCurrent(extensionId, generation);
    if (
        refreshToken !== undefined &&
        (refreshToken.length === 0 ||
            refreshToken.length > MAX_EXTENSION_PROJECT_STATUS_REFRESH_TOKEN_LENGTH)
    )
        throw Object.assign(new Error('Project Status refresh token is invalid'), {
            code: 'PROVIDER_FAILED',
        });
    const id = randomUUID();
    const request: ExtensionHostApiRequest = {
        type: 'api-request',
        id,
        extensionId,
        generation,
        apiToken,
        method: 'workspace.getProjectStatus',
        params: { ...(refreshToken && { refreshToken }) },
    };
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingApi.delete(id);
            reject(
                Object.assign(new Error('Host API request timed out'), {
                    code: 'EXTENSION_HOST_UNAVAILABLE',
                }),
            );
        }, HOST_API_TIMEOUT_MS);
        timer.unref();
        pendingApi.set(id, { apiToken, resolve, reject, timer });
        send(request);
    });
}

function createBinding(registration: ExtensionHostRegistration): ApiBinding {
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    const activeContext = new EventEmitter<void>();
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    const projectStatus = new EventEmitter<void>();
    const allowedViews = new Set(
        Object.values(registration.manifest.contributes.views)
            .flat()
            .map(({ id }) => id),
    );
    const allowedCommands = new Set(
        registration.manifest.contributes.commands.map(({ command }) => command),
    );
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
            registerTreeDataProvider<T>(viewId: string, provider: TreeDataProvider<T>) {
                assertBindingCurrent(registration);
                if (!allowedViews.has(viewId))
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
                    elements: new Map(),
                    handles: new WeakMap(),
                    depths: new Map(),
                    children: new Map(),
                    parents: new Map(),
                    ids: new Map(),
                    itemIds: new Map(),
                    nextHandle: 0,
                    refreshEpoch: 0,
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
            onDidChangeProjectStatus: projectStatus.event,
            getProjectStatus: (options?: ProjectStatusRequestOptions) => {
                assertBindingCurrent(registration);
                return requestProjectStatus(
                    registration.extensionId,
                    registration.generation,
                    registration.apiToken,
                    options?.refreshToken,
                );
            },
        }),
    });
    return {
        api,
        notifyActiveContext: () => activeContext.fire(),
        notifyProjectStatus: () => projectStatus.fire(),
        runtime: {
            CancellationTokenSource,
            Disposable,
            EventEmitter,
            ThemeIcon,
            TreeItem,
            TreeItemCollapsibleState,
        },
    };
}

export function notifyActiveContextChanged(): { notified: number } {
    let notified = 0;
    for (const runtime of extensions.values()) {
        if (!runtime.activation) continue;
        runtime.apiBinding.notifyActiveContext();
        notified += 1;
    }
    return { notified };
}

export function notifyProjectStatusChanged(): { notified: number } {
    let notified = 0;
    for (const runtime of extensions.values()) {
        if (!runtime.activation) continue;
        runtime.apiBinding.notifyProjectStatus();
        notified += 1;
    }
    return { notified };
}

function disposeExtension(runtime: ExtensionRuntime): void {
    runtime.retired = true;
    for (const disposable of runtime.context.subscriptions.toReversed()) {
        try {
            disposable.dispose();
        } catch {
            // One extension disposable must not prevent the rest of its generation from retiring.
        }
    }
    for (const [viewId, provider] of providers)
        if (provider.extensionId === runtime.registration.extensionId) {
            cancelPendingRefresh(viewId);
            providers.delete(viewId);
        }
    for (const [commandId, command] of commands)
        if (command.extensionId === runtime.registration.extensionId) commands.delete(commandId);
}

export function configureExtensions(registrations: readonly ExtensionHostRegistration[]): void {
    for (const runtime of extensions.values()) disposeExtension(runtime);
    extensions.clear();
    for (const { timer } of pendingRefreshes.values()) clearTimeout(timer);
    pendingRefreshes.clear();
    for (const pending of pendingApi.values()) {
        clearTimeout(pending.timer);
        pending.reject(
            Object.assign(new Error('Extension generation was reconfigured'), {
                code: 'GENERATION_EXPIRED',
            }),
        );
    }
    pendingApi.clear();
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
    if (!runtime)
        throw Object.assign(new Error('Extension API binding has expired'), {
            code: 'GENERATION_EXPIRED',
        });
    return runtime.apiBinding;
}

function assertBindingCurrent(registration: ExtensionHostRegistration): ExtensionRuntime {
    const runtime = extensions.get(registration.extensionId);
    if (
        !runtime ||
        runtime.retired ||
        runtime.registration.generation !== registration.generation ||
        runtime.registration.apiToken !== registration.apiToken
    )
        throw Object.assign(new Error('Extension API binding has expired'), {
            code: 'GENERATION_EXPIRED',
        });
    return runtime;
}

function assertRuntimeCurrent(runtime: ExtensionRuntime): void {
    if (extensions.get(runtime.registration.extensionId) !== runtime || runtime.retired)
        throw Object.assign(new Error('Extension generation expired during the request'), {
            code: 'GENERATION_EXPIRED',
        });
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
        await module.activate(runtime.context);
        assertRuntimeCurrent(runtime);
    })();
    await runtime.activation;
}

function collapsibleState(value: number): TreeItemDto['collapsibleState'] {
    if (value === TreeItemCollapsibleState.Collapsed) return 'collapsed';
    if (value === TreeItemCollapsibleState.Expanded) return 'expanded';
    return 'none';
}

function providerErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function providerFailure(error: unknown): Error {
    if (error instanceof Error && 'code' in error) return error;
    if (typeof error === 'object' && error !== null && 'code' in error)
        return Object.assign(new Error(providerErrorMessage(error)), { code: error.code });
    return Object.assign(
        new Error(error instanceof Error ? error.message : 'Tree provider failed'),
        { code: 'PROVIDER_FAILED' },
    );
}

function stableTreeHandle(id: string): string {
    return `id:${id}`;
}

function collectDescendantHandles(
    provider: ProviderRegistration,
    parentHandle: string,
): Set<string> {
    const descendants = new Set<string>();
    const visit = (parent: string): void => {
        const childHandles = provider.children.get(parent) ?? [];
        for (const child of childHandles) {
            if (descendants.has(child)) continue;
            descendants.add(child);
            visit(child);
        }
    };
    visit(parentHandle);
    return descendants;
}

function retireTreeHandles(provider: ProviderRegistration, handles: ReadonlySet<string>): void {
    for (const handle of handles) {
        const element = provider.elements.get(handle);
        if (typeof element === 'object' && element !== null) provider.handles.delete(element);
        const id = provider.itemIds.get(handle);
        if (id && provider.ids.get(id) === handle) provider.ids.delete(id);
        provider.elements.delete(handle);
        provider.depths.delete(handle);
        provider.parents.delete(handle);
        provider.itemIds.delete(handle);
        provider.children.delete(handle);
    }
}

function isRequestCancelled(cancellation: CancellationTokenSource): boolean {
    return cancellation.token.isCancellationRequested;
}

function assertRefreshCurrent(provider: ProviderRegistration, refreshEpoch: number): void {
    if (provider.refreshEpoch !== refreshEpoch)
        throw Object.assign(new Error('Tree provider refreshed while the request was running'), {
            code: 'GENERATION_EXPIRED',
        });
}

export async function getTreeChildren(parameters: {
    extensionId: string;
    generation: number;
    viewId: string;
    parentHandle?: string;
    requestId: string;
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
    const parent = parameters.parentHandle
        ? provider.elements.get(parameters.parentHandle)
        : undefined;
    if (parent === undefined && parameters.parentHandle)
        throw Object.assign(new Error('Tree handle belongs to an expired generation'), {
            code: 'GENERATION_EXPIRED',
        });
    const parentDepth = parameters.parentHandle ? provider.depths.get(parameters.parentHandle) : -1;
    if (parentDepth === undefined)
        throw Object.assign(new Error('Tree handle depth belongs to an expired generation'), {
            code: 'GENERATION_EXPIRED',
        });
    const childDepth = parentDepth + 1;
    if (childDepth > MAX_VIEW_TREE_DEPTH)
        throw Object.assign(new Error('Tree provider exceeded the depth limit'), {
            code: 'PROVIDER_CAPACITY',
        });
    const parentKey = parameters.parentHandle ?? ROOT_TREE_PARENT;
    if (cancellations.has(parameters.requestId))
        throw Object.assign(new Error('Tree request id is already active'), {
            code: 'PROVIDER_CAPACITY',
        });
    const cancellation = new CancellationTokenSource();
    const refreshEpoch = provider.refreshEpoch;
    cancellations.set(parameters.requestId, cancellation);
    try {
        let children: readonly unknown[];
        try {
            children = (await provider.provider.getChildren(parent, cancellation.token)) ?? [];
        } catch (error) {
            throw providerFailure(error);
        }
        assertRuntimeCurrent(runtime);
        assertRefreshCurrent(provider, refreshEpoch);
        if (isRequestCancelled(cancellation)) return { items: [] };
        if (children.length > MAX_VIEW_TREE_ITEMS)
            throw Object.assign(new Error('Tree provider exceeded the item limit'), {
                code: 'PROVIDER_CAPACITY',
            });
        const stagedItems = await Promise.all(
            children.map(async (element) => {
                let item: TreeItem | null | undefined;
                try {
                    item = await provider.provider.getTreeItem(element);
                } catch (error) {
                    throw providerFailure(error);
                }
                if (!item)
                    throw Object.assign(new Error('Tree provider returned an empty TreeItem'), {
                        code: 'PROVIDER_FAILED',
                    });
                return { element, item };
            }),
        );
        assertRuntimeCurrent(runtime);
        assertRefreshCurrent(provider, refreshEpoch);
        if (isRequestCancelled(cancellation)) return { items: [] };
        assertRuntimeCurrent(runtime);
        const retiredHandles = collectDescendantHandles(provider, parentKey);
        if (provider.elements.size - retiredHandles.size + children.length > MAX_VIEW_TREE_HANDLES)
            throw Object.assign(new Error('Tree provider exceeded the handle limit'), {
                code: 'PROVIDER_CAPACITY',
            });
        let nextHandle = provider.nextHandle;
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
                const existingHandle = provider.ids.get(item.id);
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
                const existingHandle = objectElement
                    ? provider.handles.get(objectElement)
                    : undefined;
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
                dto = treeItemSchema.parse({
                    handle,
                    ...(item.id && { id: item.id }),
                    label: item.label,
                    ...(item.description && { description: item.description }),
                    ...(item.tooltip && { tooltip: item.tooltip }),
                    accessibilityLabel: item.accessibilityInformation?.label ?? item.label,
                    collapsibleState: collapsibleState(item.collapsibleState),
                    ...(item.iconPath && { icon: { kind: 'theme', id: item.iconPath.id } }),
                    ...(item.command && {
                        command: {
                            id: item.command.command,
                            title: item.command.title,
                            ...(item.command.arguments && {
                                arguments: [...item.command.arguments],
                            }),
                        },
                    }),
                });
            } catch (error) {
                throw providerFailure(error);
            }
            return { dto, element, handle };
        });
        const items = prepared.map(({ dto }) => dto);
        if (Buffer.byteLength(JSON.stringify(items), 'utf8') > MAX_VIEW_TREE_PAYLOAD_BYTES)
            throw Object.assign(new Error('Tree provider payload exceeded the byte limit'), {
                code: 'PAYLOAD_TOO_LARGE',
            });
        if (isRequestCancelled(cancellation)) return { items: [] };
        provider.nextHandle = nextHandle;
        retireTreeHandles(provider, retiredHandles);
        provider.children.set(parentKey, new Set(prepared.map(({ handle }) => handle)));
        for (const { dto, element, handle } of prepared) {
            provider.elements.set(handle, element);
            provider.depths.set(handle, childDepth);
            provider.parents.set(handle, parentKey);
            if (dto.id) {
                provider.ids.set(dto.id, handle);
                provider.itemIds.set(handle, dto.id);
            }
            if (typeof element === 'object' && element !== null)
                provider.handles.set(element, handle);
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
}): Promise<{ executed: true }> {
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
    await command.run(...parameters.arguments);
    assertRuntimeCurrent(runtime);
    return { executed: true };
}

export function cancelTreeRequest(requestId: string): { cancelled: boolean } {
    const cancellation = cancellations.get(requestId);
    cancellation?.cancel();
    return { cancelled: Boolean(cancellation) };
}

export function settleApiReply(message: {
    id: string;
    ok: boolean;
    result?: ProjectStatusSummary;
    error?: { code: string; message: string };
}): void {
    const pending = pendingApi.get(message.id);
    if (!pending) return;
    pendingApi.delete(message.id);
    clearTimeout(pending.timer);
    if (extensions.values().every(({ registration }) => registration.apiToken !== pending.apiToken))
        return;
    if (message.ok && message.result) pending.resolve(message.result);
    else
        pending.reject(
            Object.assign(new Error(message.error?.message ?? 'Host API request failed'), {
                code: message.error?.code ?? 'EXTENSION_HOST_UNAVAILABLE',
            }),
        );
}

export function disposeAllExtensions(): void {
    for (const runtime of extensions.values()) disposeExtension(runtime);
    extensions.clear();
    for (const pending of pendingApi.values()) {
        clearTimeout(pending.timer);
        pending.reject(
            Object.assign(new Error('Extension Host is stopping'), {
                code: 'EXTENSION_HOST_UNAVAILABLE',
            }),
        );
    }
    pendingApi.clear();
}

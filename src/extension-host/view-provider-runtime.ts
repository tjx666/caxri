import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type {
    CaxriApi,
    DisposableLike,
    ResourceExplorerChange,
    ResourceExplorerProvider,
    SourceControlChange,
    SourceControlProvider,
} from 'caxri';
import { CancellationTokenSource, Disposable } from 'caxri';

import type {
    ExtensionHostMessage,
    ExtensionViewEventScope,
    ExtensionWorkspaceOperation,
} from '../shared/extension-host-protocol';

type ControlledViewProvider =
    | { kind: 'resource-explorer'; provider: ResourceExplorerProvider }
    | { kind: 'source-control'; provider: SourceControlProvider };

interface ViewProviderRegistration {
    extensionId: string;
    generation: number;
    subscription?: DisposableLike;
    view: ControlledViewProvider;
}

const providers = new Map<string, ViewProviderRegistration>();
const cancellations = new Map<string, CancellationTokenSource>();
const cancelTombstones = new Map<string, number>();
const MAX_CANCEL_TOMBSTONES = 256;
const CANCEL_TOMBSTONE_TTL_MS = 30_000;
const viewEventContext = new AsyncLocalStorage<ExtensionViewEventScope>();

function pruneCancelTombstones(now = Date.now()): void {
    for (const [requestId, expiresAt] of cancelTombstones)
        if (expiresAt <= now) cancelTombstones.delete(requestId);
    while (cancelTombstones.size > MAX_CANCEL_TOMBSTONES)
        cancelTombstones.delete(cancelTombstones.keys().next().value!);
}

function didConsumeCancelTombstone(requestId: string): boolean {
    pruneCancelTombstones();
    if (!cancelTombstones.has(requestId)) return false;
    cancelTombstones.delete(requestId);
    return true;
}

/**
 * Keeps provider events emitted while a Host notification or extension command is running tied to that request's
 * Workbench Root. Events without an active scope are deliberately dropped instead of becoming global UI broadcasts.
 */
export function withViewEventContext<Result>(
    context: ExtensionViewEventScope,
    callback: () => Result,
): Result {
    return viewEventContext.run(context, callback);
}

export function currentViewEventContext(): ExtensionViewEventScope | undefined {
    return viewEventContext.getStore();
}

function providerFailure(error: unknown): Error {
    if (error instanceof Error && 'code' in error) return error;
    return Object.assign(
        new Error(error instanceof Error ? error.message : 'View provider failed'),
        {
            code: 'PROVIDER_FAILED',
        },
    );
}

function registerProvider(
    viewId: string,
    registration: Omit<ViewProviderRegistration, 'subscription'>,
    onDidChange: ResourceExplorerProvider['onDidChange'] | SourceControlProvider['onDidChange'],
    send: (message: ExtensionHostMessage) => void,
): Disposable {
    if (providers.has(viewId))
        throw Object.assign(new Error(`View provider already registered: ${viewId}`), {
            code: 'DUPLICATE_ID',
        });
    const current: ViewProviderRegistration = registration;
    if (onDidChange)
        current.subscription = onDidChange(
            (change: ResourceExplorerChange | SourceControlChange) => {
                if (providers.get(viewId) !== current) return;
                const context = currentViewEventContext();
                if (!context) return;
                const serializedChange =
                    change.kind === 'content' && 'paths' in change && change.paths
                        ? { ...change, paths: [...change.paths] }
                        : change;
                send({
                    type: 'event',
                    event: 'viewChanged',
                    extensionId: current.extensionId,
                    generation: current.generation,
                    viewId,
                    eventId: randomUUID(),
                    context,
                    change: serializedChange,
                });
            },
        );
    providers.set(viewId, current);
    return new Disposable(() => {
        current.subscription?.dispose();
        if (providers.get(viewId) === current) providers.delete(viewId);
    });
}

function registerResourceExplorerProvider(
    extensionId: string,
    generation: number,
    viewId: string,
    provider: ResourceExplorerProvider,
    send: (message: ExtensionHostMessage) => void,
): Disposable {
    return registerProvider(
        viewId,
        { extensionId, generation, view: { kind: 'resource-explorer', provider } },
        provider.onDidChange,
        send,
    );
}

function registerSourceControlProvider(
    extensionId: string,
    generation: number,
    viewId: string,
    provider: SourceControlProvider,
    send: (message: ExtensionHostMessage) => void,
): Disposable {
    return registerProvider(
        viewId,
        { extensionId, generation, view: { kind: 'source-control', provider } },
        provider.onDidChange,
        send,
    );
}

export function createControlledViewRegistrationApi(options: {
    extensionId: string;
    generation: number;
    viewKinds: ReadonlyMap<string, string>;
    assertCurrent(): void;
    send(message: ExtensionHostMessage): void;
}): Pick<CaxriApi['views'], 'registerResourceExplorerProvider' | 'registerSourceControlProvider'> {
    return {
        registerResourceExplorerProvider: (viewId, provider) => {
            options.assertCurrent();
            if (options.viewKinds.get(viewId) !== 'resource-explorer')
                throw Object.assign(
                    new Error(`Resource Explorer view is not declared: ${viewId}`),
                    { code: 'PROVIDER_MISSING' },
                );
            return registerResourceExplorerProvider(
                options.extensionId,
                options.generation,
                viewId,
                provider,
                (message) => options.send(message),
            );
        },
        registerSourceControlProvider: (viewId, provider) => {
            options.assertCurrent();
            if (options.viewKinds.get(viewId) !== 'source-control')
                throw Object.assign(new Error(`Source Control view is not declared: ${viewId}`), {
                    code: 'PROVIDER_MISSING',
                });
            return registerSourceControlProvider(
                options.extensionId,
                options.generation,
                viewId,
                provider,
                (message) => options.send(message),
            );
        },
    };
}

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null)
        throw Object.assign(new Error('View operation arguments must be an object'), {
            code: 'PROVIDER_FAILED',
        });
    return value as Record<string, unknown>;
}

async function executeResourceOperation(
    provider: ResourceExplorerProvider,
    operation: ExtensionWorkspaceOperation,
    arguments_: Record<string, unknown>,
    cancellation: CancellationTokenSource,
): Promise<unknown> {
    const token = cancellation.token;
    switch (operation) {
        case 'files.list':
            return provider.list(arguments_.directory as string | undefined, token);
        case 'files.search':
            return provider.search(arguments_ as never, token);
        case 'files.create':
            return provider.create(arguments_ as never, token);
        case 'files.copy':
            return provider.copy(arguments_.path as string, arguments_.directory as string, token);
        case 'files.rename':
            return provider.rename(arguments_ as never, token);
        case 'files.move':
            return provider.move(arguments_ as never, token);
        case 'files.operation.get':
            return provider.getOperation(arguments_.operationId as string, token);
        case 'files.operation.list':
            return provider.listOperations(token);
        case 'files.operation.cancel':
            return provider.cancelOperation(arguments_.operationId as string, token);
        case 'files.operation.acknowledge':
            await provider.acknowledgeOperation(arguments_.operationId as string, token);
            return null;
        case 'files.trash':
            return provider.trash(
                arguments_.path as string,
                arguments_.hasUnsavedChanges === undefined
                    ? undefined
                    : { hasUnsavedChanges: arguments_.hasUnsavedChanges as boolean },
                token,
            );
        case 'files.reveal':
            await provider.reveal(arguments_.path as string, token);
            return null;
        default:
            throw Object.assign(
                new Error(`Unsupported Resource Explorer operation: ${operation}`),
                {
                    code: 'CAPABILITY_DENIED',
                },
            );
    }
}

async function executeSourceControlOperation(
    provider: SourceControlProvider,
    operation: ExtensionWorkspaceOperation,
    arguments_: Record<string, unknown>,
    cancellation: CancellationTokenSource,
): Promise<unknown> {
    const token = cancellation.token;
    switch (operation) {
        case 'git.summary':
            return provider.summary(arguments_.refresh as number, token);
        case 'git.sync':
            await provider.sync(arguments_.repositoryId as string, token);
            return null;
        case 'git.discard':
            return provider.discard(
                {
                    id: arguments_.repositoryId as string,
                    name: arguments_.repositoryName as string,
                },
                arguments_.scope as never,
                token,
            );
        case 'git.pullRequestChanges':
            return provider.pullRequestChanges(
                arguments_.repositoryId as string,
                arguments_.refresh as number,
                token,
            );
        case 'git.commits':
            return provider.commits(arguments_ as never, token);
        case 'git.commitDetails':
            return provider.commitDetails(arguments_ as never, token);
        case 'git.remoteHost':
            return provider.remoteHost(arguments_.repositoryId as string, token);
        default:
            throw Object.assign(new Error(`Unsupported Source Control operation: ${operation}`), {
                code: 'CAPABILITY_DENIED',
            });
    }
}

export async function executeViewOperation(parameters: {
    extensionId: string;
    generation: number;
    viewId: string;
    operation: ExtensionWorkspaceOperation;
    arguments: unknown;
    requestId: string;
    context?: ExtensionViewEventScope;
}): Promise<unknown> {
    if (didConsumeCancelTombstone(parameters.requestId))
        throw Object.assign(new Error('View request was cancelled before registration'), {
            code: 'CANCELLED',
        });
    const registration = providers.get(parameters.viewId);
    if (
        !registration ||
        registration.extensionId !== parameters.extensionId ||
        registration.generation !== parameters.generation
    )
        throw Object.assign(new Error(`No provider registered for ${parameters.viewId}`), {
            code: 'PROVIDER_MISSING',
        });
    if (cancellations.has(parameters.requestId))
        throw Object.assign(new Error('View request id is already active'), {
            code: 'PROVIDER_CAPACITY',
        });
    const cancellation = new CancellationTokenSource();
    cancellations.set(parameters.requestId, cancellation);
    try {
        const arguments_ = record(parameters.arguments);
        const invoke = (): Promise<unknown> =>
            registration.view.kind === 'resource-explorer'
                ? executeResourceOperation(
                      registration.view.provider,
                      parameters.operation,
                      arguments_,
                      cancellation,
                  )
                : executeSourceControlOperation(
                      registration.view.provider,
                      parameters.operation,
                      arguments_,
                      cancellation,
                  );
        const result = await (parameters.context
            ? withViewEventContext(parameters.context, invoke)
            : invoke());
        // The token can change while the provider Promise above is awaited.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- asynchronous cancellation race
        if (cancellation.token.isCancellationRequested)
            throw Object.assign(new Error('View request was cancelled'), {
                code: 'CANCELLED',
            });
        if (providers.get(parameters.viewId) !== registration)
            throw Object.assign(new Error('View provider generation expired'), {
                code: 'GENERATION_EXPIRED',
            });
        return result;
    } catch (error) {
        throw providerFailure(error);
    } finally {
        cancellations.delete(parameters.requestId);
        cancellation.dispose();
    }
}

export function didCancelViewRequest(requestId: string): boolean {
    const cancellation = cancellations.get(requestId);
    if (cancellation) {
        cancellation.cancel();
        return true;
    }
    pruneCancelTombstones();
    cancelTombstones.set(requestId, Date.now() + CANCEL_TOMBSTONE_TTL_MS);
    pruneCancelTombstones();
    return true;
}

export function retireViewProviders(extensionId?: string): void {
    for (const [viewId, registration] of providers)
        if (extensionId === undefined || registration.extensionId === extensionId) {
            registration.subscription?.dispose();
            providers.delete(viewId);
        }
    if (extensionId === undefined) cancelTombstones.clear();
}

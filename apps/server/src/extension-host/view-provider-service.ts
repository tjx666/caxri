import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { CaxriApi, DisposableLike, SourceControlChange, SourceControlProvider } from 'caxri';
import { CancellationTokenSource, Disposable } from 'caxri';

import type {
    ExtensionHostMessage,
    ExtensionViewEventScope,
    ExtensionViewOperation,
} from './protocol';

interface ViewProviderRegistration {
    extensionId: string;
    generation: number;
    subscription?: DisposableLike;
    provider: SourceControlProvider;
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
 * Keeps provider events emitted while a Server notification or extension command is running tied to that request's
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
    onDidChange: SourceControlProvider['onDidChange'],
    send: (message: ExtensionHostMessage) => void,
): Disposable {
    if (providers.has(viewId))
        throw Object.assign(new Error(`View provider already registered: ${viewId}`), {
            code: 'DUPLICATE_ID',
        });
    const current: ViewProviderRegistration = registration;
    if (onDidChange)
        current.subscription = onDidChange((change: SourceControlChange) => {
            if (providers.get(viewId) !== current) return;
            const context = currentViewEventContext();
            if (!context) return;
            send({
                type: 'event',
                event: 'viewChanged',
                extensionId: current.extensionId,
                generation: current.generation,
                viewId,
                eventId: randomUUID(),
                context,
                change,
            });
        });
    providers.set(viewId, current);
    return new Disposable(() => {
        current.subscription?.dispose();
        if (providers.get(viewId) === current) providers.delete(viewId);
    });
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
        { extensionId, generation, provider },
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
}): Pick<CaxriApi['views'], 'registerSourceControlProvider'> {
    return {
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

async function executeSourceControlOperation(
    provider: SourceControlProvider,
    operation: ExtensionViewOperation,
    arguments_: Record<string, unknown>,
    cancellation: CancellationTokenSource,
    context?: ExtensionViewEventScope,
): Promise<unknown> {
    const token = cancellation.token;
    const scopeId =
        context?.kind === 'session'
            ? `${context.sessionId}:${context.workbenchProjectId}`
            : 'no-session';
    const scopedArguments = { ...arguments_, scopeId };
    switch (operation) {
        case 'source.snapshot':
            return provider.provideView(scopedArguments as never, token);
        case 'source.historyPage':
            return provider.provideHistoryPage(scopedArguments as never, token);
        case 'source.historyDetails':
            return provider.provideHistoryDetails(scopedArguments as never, token);
        case 'source.action':
            return provider.runAction(scopedArguments as never, token);
        default:
            throw Object.assign(new Error('Unsupported Source Control operation'), {
                code: 'CAPABILITY_DENIED',
            });
    }
}

export async function executeViewOperation(parameters: {
    extensionId: string;
    generation: number;
    viewId: string;
    operation: ExtensionViewOperation;
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
            executeSourceControlOperation(
                registration.provider,
                parameters.operation,
                arguments_,
                cancellation,
                parameters.context,
            );
        const result = await (parameters.context
            ? withViewEventContext(parameters.context, invoke)
            : invoke());
        if (providers.get(parameters.viewId) !== registration)
            throw Object.assign(new Error('View provider generation expired'), {
                code: 'GENERATION_EXPIRED',
            });
        /**
         * Reads must not commit a late result after cancellation. An action is different: cancellation is advisory once
         * its provider has crossed a mutation boundary, so a successfully returned result is authoritative.
         */
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- asynchronous cancellation race
        if (parameters.operation !== 'source.action' && cancellation.token.isCancellationRequested)
            throw Object.assign(new Error('View request was cancelled'), {
                code: 'CANCELLED',
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

import { randomUUID } from 'node:crypto';

import {
    assertNever,
    extensionViewOperationMetadata,
    isExtensionViewReadOperation,
} from '@caxri/protocol';
import type {
    CaxriApi,
    DisposableLike,
    Event,
    SourceControlChange,
    SourceControlProvider,
    ViewBadgeProvider,
} from 'caxri';
import { CancellationTokenSource, Disposable } from 'caxri';

import {
    createProviderRequestScope,
    hostError,
    providerFailure,
    withProviderRequestScope,
} from './extension-error';
import type {
    ExtensionHostMessage,
    ExtensionViewEventScope,
    ExtensionViewOperation,
} from './protocol';
import { currentViewEventContext, withViewEventContext } from './view-event-context';

interface ViewProviderRegistration {
    extensionId: string;
    generation: number;
    subscription?: DisposableLike;
    provider: SourceControlProvider | ViewBadgeProvider;
    /**
     * Set only by host-driven retirement ({@link retireViewProviders}). The extension owns the registration's
     * Disposable, so map identity alone cannot corroborate a `GENERATION_EXPIRED` the provider throws (issue #606).
     */
    retired?: boolean;
}

const providers = new Map<string, ViewProviderRegistration>();
const cancellations = new Map<string, CancellationTokenSource>();
const cancelTombstones = new Map<string, number>();
const MAX_CANCEL_TOMBSTONES = 256;
const CANCEL_TOMBSTONE_TTL_MS = 30_000;

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

function registerProvider(
    viewId: string,
    registration: Omit<ViewProviderRegistration, 'subscription'>,
    onDidChange: Event<SourceControlChange | { kind: 'badge' }> | undefined,
    send: (message: ExtensionHostMessage) => void,
    role: 'source' | 'badge' = 'source',
): Disposable {
    const key = `${role}:${viewId}`;
    if (providers.has(key))
        throw Object.assign(new Error(`View provider already registered: ${viewId}`), {
            code: 'DUPLICATE_ID',
        });
    const current: ViewProviderRegistration = registration;
    if (onDidChange)
        current.subscription = onDidChange((change) => {
            if (providers.get(key) !== current) return;
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
    providers.set(key, current);
    return new Disposable(() => {
        current.subscription?.dispose();
        if (providers.get(key) === current) providers.delete(key);
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
    badgeViewIds?: ReadonlySet<string>;
    assertCurrent(): void;
    send(message: ExtensionHostMessage): void;
}): Pick<CaxriApi['views'], 'registerSourceControlProvider' | 'registerViewBadgeProvider'> {
    return {
        registerViewBadgeProvider: (viewId, provider) => {
            options.assertCurrent();
            if (!options.badgeViewIds?.has(viewId))
                throw Object.assign(new Error(`View badge is not declared: ${viewId}`), {
                    code: 'CAPABILITY_DENIED',
                });
            const onDidChange = provider.onDidChangeBadge;
            return registerProvider(
                viewId,
                { extensionId: options.extensionId, generation: options.generation, provider },
                onDidChange
                    ? (listener) => onDidChange(() => listener({ kind: 'badge' }))
                    : undefined,
                (message) => options.send(message),
                'badge',
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

async function executeProviderOperation(
    provider: SourceControlProvider | ViewBadgeProvider,
    operation: ExtensionViewOperation,
    arguments_: Record<string, unknown>,
    cancellation: CancellationTokenSource,
    context?: ExtensionViewEventScope,
): Promise<unknown> {
    const token = cancellation.token;
    const scopeId =
        context?.kind === 'session'
            ? `${context.sessionId}:${context.workbenchRootProjectId}`
            : 'no-session';
    if (operation === 'badge.snapshot') {
        if ('provideBadge' in provider)
            return (await provider.provideBadge({ scopeId }, token)) ?? null;
        throw hostError('CAPABILITY_DENIED', 'View provider does not support this operation');
    }
    if (!('provideView' in provider))
        throw hostError('CAPABILITY_DENIED', 'View provider does not support this operation');
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
            return assertNever(operation, 'Unsupported Source Control operation');
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
        throw hostError('CANCELLED', 'View request was cancelled before registration');
    const key = `${extensionViewOperationMetadata[parameters.operation].provider}:${parameters.viewId}`;
    const registration = providers.get(key);
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
    const scope = createProviderRequestScope();
    cancellations.set(parameters.requestId, cancellation);
    try {
        const arguments_ = record(parameters.arguments);
        const invoke = (): Promise<unknown> =>
            withProviderRequestScope(scope, () =>
                executeProviderOperation(
                    registration.provider,
                    parameters.operation,
                    arguments_,
                    cancellation,
                    parameters.context,
                ),
            );
        const result = await (parameters.context
            ? withViewEventContext(parameters.context, invoke)
            : invoke());
        if (providers.get(key) !== registration)
            throw hostError('GENERATION_EXPIRED', 'View provider generation expired');
        /**
         * Reads must not commit a late result after cancellation. An action is different: cancellation is advisory once
         * its provider has crossed a mutation boundary, so a successfully returned result is authoritative.
         */
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- asynchronous cancellation race
        if (
            isExtensionViewReadOperation(parameters.operation) &&
            cancellation.token.isCancellationRequested
        )
            throw hostError('CANCELLED', 'View request was cancelled');
        return result;
    } catch (error) {
        throw providerFailure(
            error,
            {
                cancelled: cancellation.token.isCancellationRequested,
                generationExpired: registration.retired === true,
                scope,
            },
            'View provider failed',
        );
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
            registration.retired = true;
            registration.subscription?.dispose();
            providers.delete(viewId);
        }
    if (extensionId === undefined) cancelTombstones.clear();
}

import { AsyncLocalStorage } from 'node:async_hooks';

const OBSERVATION_ID = /^[A-Za-z0-9][\w.:-]{0,199}$/u;

export interface ObservationContext {
    agentRunId?: string;
    bootId?: string;
    buildId?: string;
    clientId?: string;
    connectionId?: string;
    operationId?: string;
    processId?: number;
    projectId?: string;
    requestId?: string;
    serverId?: string;
    sessionId?: string;
    terminalId?: string;
    traceId?: string;
}

const storage = new AsyncLocalStorage<Readonly<ObservationContext>>();

function observationId(value: unknown): string | undefined {
    return typeof value === 'string' && OBSERVATION_ID.test(value) ? value : undefined;
}

/**
 * Keeps correlation data content-free. Values that look like paths, prose, credentials, or unbounded user content are
 * omitted instead of being copied into logs, manifests, or fault receipts.
 */
export function normalizeObservationContext(value: ObservationContext): ObservationContext {
    const processId =
        typeof value.processId === 'number' &&
        Number.isSafeInteger(value.processId) &&
        value.processId > 0
            ? value.processId
            : undefined;
    return {
        ...(observationId(value.agentRunId) && { agentRunId: value.agentRunId }),
        ...(observationId(value.bootId) && { bootId: value.bootId }),
        ...(observationId(value.buildId) && { buildId: value.buildId }),
        ...(observationId(value.clientId) && { clientId: value.clientId }),
        ...(observationId(value.connectionId) && { connectionId: value.connectionId }),
        ...(observationId(value.operationId) && { operationId: value.operationId }),
        ...(processId !== undefined && { processId }),
        ...(observationId(value.projectId) && { projectId: value.projectId }),
        ...(observationId(value.requestId) && { requestId: value.requestId }),
        ...(observationId(value.serverId) && { serverId: value.serverId }),
        ...(observationId(value.sessionId) && { sessionId: value.sessionId }),
        ...(observationId(value.terminalId) && { terminalId: value.terminalId }),
        ...(observationId(value.traceId) && { traceId: value.traceId }),
    };
}

export function currentObservationContext(): Readonly<ObservationContext> {
    return storage.getStore() ?? {};
}

export function mergeObservationContext(
    ...contexts: Array<ObservationContext | undefined>
): ObservationContext {
    const merged: ObservationContext = {};
    for (const context of contexts) {
        if (context) Object.assign(merged, context);
    }
    return normalizeObservationContext(merged);
}

/**
 * Carries correlation across asynchronous work in one process. Private process protocols must explicitly forward the
 * normalized value because async-local state intentionally cannot cross a process boundary.
 */
export function runWithObservationContext<T>(context: ObservationContext, action: () => T): T {
    return storage.run(mergeObservationContext(currentObservationContext(), context), action);
}

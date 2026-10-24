import type { ServerOperation } from '@caxri/protocol';
import { isCallerHandledFailure } from '@caxri/protocol';

/**
 * Renderer polling and focus reads that succeed thousands of times a day without explaining anything. A slow call is
 * still logged at `warn` by the control boundary, and every failure is logged.
 */
const POLLED_READ_METHODS = [
    'app.activeContext',
    'app.records',
    'app.sessionContext',
    'session.refreshDeliveryOnFocus',
    'terminal.agentThroughput',
    'terminal.agentUsage',
    'terminal.agentTaskUsage',
    'terminal.queryForPrincipal',
    'terminal.resources',
] satisfies ServerOperation[];

/**
 * Successful high-frequency domain requests use aggregate telemetry instead of one log line per call. A successful
 * `logs.query` is excluded at both boundaries because its cursor follower reads the same records they write: recording
 * the read would make the next read observe only its predecessor and create a self-sustaining request loop. Failures
 * remain logged at both boundaries.
 */
const UNLOGGED_SUCCESS_METHODS = {
    control: new Set<string>([
        'logs.query',
        'terminal.inputBinary',
        ...POLLED_READ_METHODS,
    ] satisfies ServerOperation[]),
    domain: new Set<string>([
        ...POLLED_READ_METHODS,
        'logs.query',
        'terminal.input',
        'terminal.inputBinary',
        'terminal.inputAgentExact',
        'terminal.resize',
    ] satisfies ServerOperation[]),
} satisfies Record<RequestLogBoundary, ReadonlySet<string>>;

type RequestLogBoundary = 'control' | 'domain';

export function shouldLogSuccessfulRequest(boundary: RequestLogBoundary, method: string): boolean {
    return !UNLOGGED_SUCCESS_METHODS[boundary].has(method);
}

/**
 * Method-scoped failures the caller absorbs as an ordinary outcome, on top of the protocol-wide
 * `isCallerHandledFailure` codes. A watcher-driven reload (`readDocuments` in the Renderer's external sync) reads a
 * path the watcher just reported, and the user can delete it before the read lands: saving a file and moving it to
 * Trash a few milliseconds later is enough. That `NOT_FOUND` is filesystem state, not a Caxri defect, and Desktop Main
 * already records the same reply at `warn`; recording it at `error` here paged as a production error and failed the E2E
 * error gate (https://github.com/tjx666/caxri/issues/1418).
 */
const CALLER_HANDLED_METHOD_FAILURES: Partial<Record<ServerOperation, ReadonlySet<string>>> = {
    'files.read': new Set(['NOT_FOUND']),
    /**
     * PR auto-detection calls this for every clean named-branch repository on open; `gh` missing, signed out, or rate
     * limited is an expected `UNAVAILABLE` outcome the caller already absorbs
     * (https://github.com/tjx666/caxri/issues/2041).
     */
    'git.pullRequestChanges': new Set(['UNAVAILABLE']),
};

export function requestFailureLogLevel(method: string, code: string): 'error' | 'warn' {
    if (isCallerHandledFailure(code)) return 'warn';
    return CALLER_HANDLED_METHOD_FAILURES[method as ServerOperation]?.has(code) ? 'warn' : 'error';
}

const DELEGATION_METHOD_PREFIX = 'agent.delegation.';
const DELEGATION_ID = /^[A-Za-z0-9][\w.:-]{0,199}$/u;

function delegationIdOf(value: unknown): string | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as { delegationId?: unknown; receipt?: unknown };
    if (typeof record.delegationId === 'string' && DELEGATION_ID.test(record.delegationId))
        return record.delegationId;
    return record.receipt === undefined ? undefined : delegationIdOf(record.receipt);
}

/**
 * The `delegationId` an `agent.delegation.*` request concerns, as an `ipc.request` log field, so one Commander CLI call
 * links to the task it created or read (`caxri logs query` projects `fields`, not the observation context). The request
 * names it for every task-scoped method; `agent.delegation.create` learns it only from its receipt, so a successful
 * result is the fallback. Opaque IDs only: the prompt, answer, and launch input never leave the request.
 */
export function delegationRequestLogFields(
    method: string,
    parameters: unknown,
    result?: unknown,
): { delegationId?: string } {
    if (!method.startsWith(DELEGATION_METHOD_PREFIX)) return {};
    const delegationId = delegationIdOf(parameters) ?? delegationIdOf(result);
    return delegationId ? { delegationId } : {};
}

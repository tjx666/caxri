import type { ServerOperation } from '@caxri/protocol';
import { isCallerHandledFailure } from '@caxri/protocol';

/**
 * Renderer polling and focus reads that succeed thousands of times a day without explaining anything. A slow call is
 * still logged at `warn` by the control boundary, and every failure is logged.
 */
const POLLED_READ_METHODS = [
    'app.activeContext',
    'app.records',
    'session.refreshDeliveryOnFocus',
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
 * path the watcher just reported, and the user can delete it before the read lands — saving a file and moving it to
 * Trash a few milliseconds later is enough. That `NOT_FOUND` is filesystem state, not a Caxri defect, and Desktop Main
 * already records the same reply at `warn`; recording it at `error` here paged as a production error and failed the E2E
 * error gate (https://github.com/tjx666/caxri/issues/1418).
 */
const CALLER_HANDLED_METHOD_FAILURES: Partial<Record<ServerOperation, ReadonlySet<string>>> = {
    'files.read': new Set(['NOT_FOUND']),
};

export function requestFailureLogLevel(method: string, code: string): 'error' | 'warn' {
    if (isCallerHandledFailure(code)) return 'warn';
    return CALLER_HANDLED_METHOD_FAILURES[method as ServerOperation]?.has(code) ? 'warn' : 'error';
}

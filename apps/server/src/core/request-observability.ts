import type { ServerOperation } from '@caxri/protocol';

/**
 * Successful high-frequency domain requests use aggregate telemetry instead of one log line per call. A successful
 * `logs.query` is excluded at both boundaries because its cursor follower reads the same records they write: recording
 * the read would make the next read observe only its predecessor and create a self-sustaining request loop. Failures
 * remain logged at both boundaries.
 */
const UNLOGGED_SUCCESS_METHODS = {
    control: new Set<string>(['logs.query'] satisfies ServerOperation[]),
    domain: new Set<string>([
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

import { randomUUID } from 'node:crypto';

import type { StructuredLogger } from '@caxri/system';
import { runWithObservationContext } from '@caxri/system';

import type { CliFailureKind, ExternalStatusSource } from './command';
import { ExternalStatusCliError, externalStatusCommandOperation, isNoPullRequest } from './command';

type FailureReason =
    | CliFailureKind
    | 'network'
    | 'tls'
    | 'permission-denied'
    | 'invalid-arguments'
    | 'no-pull-request';

/**
 * Classify locally, then discard prose: CLI stderr may contain credentials, URLs, paths, or provider response bodies.
 * Keep this diagnostic detail separate from the existing UI/limiter classification so logging cannot change retries.
 */
function failureReason(error: unknown): FailureReason {
    if (isNoPullRequest(error)) return 'no-pull-request';
    if (error instanceof ExternalStatusCliError && error.kind !== 'other') return error.kind;
    const message = error instanceof Error ? error.message : '';
    if (
        /certificate|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|self.signed|TLS|SSL/i.test(
            message,
        )
    )
        return 'tls';
    if (
        /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|fetch failed|socket hang up/i.test(
            message,
        )
    )
        return 'network';
    if (
        /EACCES|EPERM|permission denied|forbidden|not authorized|access denied|HTTP 403/i.test(
            message,
        )
    )
        return 'permission-denied';
    if (
        /unknown (?:option|argument|flag)|invalid (?:option|argument|flag)|unexpected argument|requires? an argument/i.test(
            message,
        )
    )
        return 'invalid-arguments';
    return 'other';
}

/**
 * One command identity spans start and completion while AsyncLocalStorage retains the parent request/session context.
 * Both Status and Session PR queries use this boundary; no argv, cwd, stdout, stderr, or error message enters the log.
 */
export function observeExternalStatusCommand(options: {
    logger: StructuredLogger;
    event: 'project_status.cli' | 'session_pull_requests.cli';
    command: ExternalStatusSource;
    arguments: readonly string[];
    /**
     * The one identifier a per-item query is about, when the caller fans out over several (Linear issue references).
     * Without it a failure is unattributable: the panel shows one error while the log records only that "a" query
     * failed, so a bogus reference cannot be told apart from a real outage. Callers pass a validated identifier — never
     * argv, a URL, or CLI output — so this stays inside the no-prose rule above.
     */
    subject?: string;
    run: () => Promise<string>;
}): Promise<string> {
    return runWithObservationContext({ operationId: randomUUID() }, async () => {
        const startedAt = performance.now();
        const fields = {
            command: options.command,
            operation: externalStatusCommandOperation(options.command, options.arguments),
            ...(options.subject !== undefined && { subject: options.subject }),
        };
        options.logger.write('debug', options.event, { fields: { ...fields, result: 'started' } });
        try {
            const result = await options.run();
            options.logger.write('debug', options.event, {
                durationMs: performance.now() - startedAt,
                fields: { ...fields, result: 'success' },
            });
            return result;
        } catch (error) {
            options.logger.write(isNoPullRequest(error) ? 'debug' : 'warn', options.event, {
                durationMs: performance.now() - startedAt,
                fields: {
                    ...fields,
                    result: 'failure',
                    failureKind: error instanceof ExternalStatusCliError ? error.kind : 'other',
                    failureReason: failureReason(error),
                    exitCode:
                        error instanceof ExternalStatusCliError &&
                        Number.isSafeInteger(error.exitCode) &&
                        error.exitCode !== null &&
                        error.exitCode >= 0
                            ? error.exitCode
                            : null,
                },
            });
            throw error;
        }
    });
}

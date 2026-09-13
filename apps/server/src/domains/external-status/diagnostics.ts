import { randomUUID } from 'node:crypto';

import type { StructuredLogger } from '@caxri/system';
import { runWithObservationContext } from '@caxri/system';

import type { ExternalStatusSource } from './command';
import {
    ExternalStatusCliError,
    externalStatusCommandOperation,
    failureReason,
    isNoPullRequest,
} from './command';

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

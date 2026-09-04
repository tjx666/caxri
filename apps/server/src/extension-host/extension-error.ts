import type { FailureReason, LogRecord, RemediationCategory } from '@caxri/system';

/**
 * The two outcomes `docs/extensions.md` defines as typed non-faults, for Source Control snapshots as well as Tree RPC.
 * They are the ordinary result of a Session switch, an extension reconfiguration, or an Extension Host restart racing a
 * request that is still in flight, and they reach this catch from every generation-checked path — `treeChildren`,
 * `activate`, `executeCommand`, `viewOperation`, and `workspace.*` calls alike. Neither may be reported as a fault that
 * recommends restarting a healthy Extension Host: an automated recovery path reading `remediation` would otherwise
 * restart the process on routine turnover.
 */
const NON_FAULT_REASONS: ReadonlyMap<string, FailureReason> = new Map([
    ['CANCELLED', 'cancelled'],
    ['GENERATION_EXPIRED', 'generation-superseded'],
]);

export interface ExtensionRequestFailureRecord {
    failure: {
        code: string;
        owner: 'extension-host';
        phase: 'execute';
        reason: FailureReason;
        remediation: RemediationCategory;
        retryable: boolean;
    };
    level: LogRecord['level'];
}

/**
 * Classifies a failed Extension Host request for the diagnostic log. A non-fault drops to `debug` because cancellation
 * and generation turnover are frequent and expected; keeping them at `warn` spent the production log budget on records
 * that describe healthy behavior. Real failures keep the original `warn` level and fault shape.
 */
export function extensionRequestFailureRecord(code: string): ExtensionRequestFailureRecord {
    const nonFaultReason = NON_FAULT_REASONS.get(code);
    if (nonFaultReason)
        return {
            failure: {
                code,
                owner: 'extension-host',
                phase: 'execute',
                reason: nonFaultReason,
                remediation: 'none',
                retryable: true,
            },
            level: 'debug',
        };
    return {
        failure: {
            code,
            owner: 'extension-host',
            phase: 'execute',
            reason: 'unknown',
            remediation: 'restart-extension-host',
            retryable: false,
        },
        level: 'warn',
    };
}

/**
 * Normalizes loader and provider failures into the stable Extension Host error taxonomy.
 */
export function extensionErrorShape(error: unknown): { code: string; message: string } {
    const rawCode =
        typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : undefined;
    const rawMessage = error instanceof Error ? error.message : String(error);
    const rawStableCode =
        [
            'ERR_PACKAGE_PATH_NOT_EXPORTED',
            'ERR_REQUIRE_ESM',
            'ERR_MODULE_NOT_FOUND',
            'MODULE_NOT_FOUND',
        ].includes(rawCode ?? '') && rawMessage.includes('caxri')
            ? 'COMMONJS_API_UNSUPPORTED'
            : (rawCode ?? 'ACTIVATION_FAILED');
    /**
     * Server Core treats oversized child messages as a compromised Extension Host. Normalize errors here so one noisy
     * provider cannot turn its local failure into a shared-host crash.
     */
    const code = rawStableCode.slice(0, 100) || 'ACTIVATION_FAILED';
    const message = rawMessage.slice(0, 2_048) || 'Extension failed without an error message';
    return { code, message };
}

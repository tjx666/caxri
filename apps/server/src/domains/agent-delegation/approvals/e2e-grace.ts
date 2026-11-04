import { APPROVAL_ESCALATION_GRACE_MS } from '@caxri/protocol';

const MIN_E2E_APPROVAL_GRACE_MS = 500;

/**
 * Resolves the escalation grace of a held parent approval. Production uses `APPROVAL_ESCALATION_GRACE_MS` and ignores
 * the variable even when it is present in the ambient environment. Focused Electron coverage shortens it to a few
 * seconds so the escalation workflow does not spend the real 90 seconds; the production value is pinned by the protocol
 * and approvals unit tests.
 */
export function resolveApprovalGraceMs(environment: NodeJS.ProcessEnv): number {
    if (environment.CAXRI_E2E !== '1') return APPROVAL_ESCALATION_GRACE_MS;
    const source = environment.CAXRI_E2E_APPROVAL_GRACE_MS;
    if (source === undefined) return APPROVAL_ESCALATION_GRACE_MS;
    const value = Number(source);
    if (
        !/^[1-9]\d*$/u.test(source) ||
        value < MIN_E2E_APPROVAL_GRACE_MS ||
        value >= APPROVAL_ESCALATION_GRACE_MS
    )
        throw new Error(
            `CAXRI_E2E_APPROVAL_GRACE_MS must be an integer from ${MIN_E2E_APPROVAL_GRACE_MS} to ${APPROVAL_ESCALATION_GRACE_MS - 1}`,
        );
    return value;
}

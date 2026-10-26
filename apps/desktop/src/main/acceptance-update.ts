import { join } from 'node:path';

import { appendAcceptanceReceipt } from './acceptance-fixtures/fixture-io';
import type { AcceptanceUpdateDiscovery } from './updates/update-service-contract';

/**
 * The one update state an Acceptance case can declare (`updateFixture` in the frozen plan). The launcher arms it as
 * `CAXRI_ACCEPTANCE_UPDATE=<fixture id>:<case id>` only for the launched case whose frozen plan declares it.
 */
export const ACCEPTANCE_UPDATE_FIXTURE_ID = 'available';
/**
 * Deliberately far above any real Caxri release so a reviewer reading the screenshot can never mistake the fixture for
 * a published version, and so it stays newer than every build the fixture runs against.
 */
const FIXTURE_VERSION = '999.0.0';
const RECEIPT_FILE_NAME = 'acceptance-update-receipt.jsonl';
/**
 * Mirrors the Acceptance report's case-id contract (`.agents/skills/acceptance/scripts/runtime-state.ts`), which Main
 * cannot import.
 */
const ACCEPTANCE_CASE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/u;

type AcceptanceUpdateRejection = 'invalid-case-id' | 'unknown-fixture';

export type AcceptanceUpdateAdmission =
    | { admitted: true; caseId: string; release: { fileName: string; version: string } }
    | { admitted: false; reason: 'not-requested' | 'outside-acceptance' | 'packaged-build' }
    | { admitted: false; reason: AcceptanceUpdateRejection; rejected: true };

/**
 * Decides whether this Main process may replace GitHub release discovery with the fixed Acceptance release. Only the
 * exact value the launcher derives from a frozen-plan declaration is admitted. A packaged build or a launch outside the
 * Acceptance and E2E gates keeps its ordinary update behavior, so a stray variable can neither fake an update nor break
 * the product. Inside Acceptance, any other value is a `rejected` request the caller must surface, never ignore.
 */
export function admitAcceptanceUpdateFixture(
    environment: NodeJS.ProcessEnv,
    options: { isPackaged: boolean },
): AcceptanceUpdateAdmission {
    const requested = environment.CAXRI_ACCEPTANCE_UPDATE;
    if (requested === undefined) return { admitted: false, reason: 'not-requested' };
    if (options.isPackaged) return { admitted: false, reason: 'packaged-build' };
    if (environment.CAXRI_ACCEPTANCE !== '1' || environment.CAXRI_E2E !== '1')
        return { admitted: false, reason: 'outside-acceptance' };
    const [fixtureId, ...caseIdParts] = requested.split(':');
    if (fixtureId !== ACCEPTANCE_UPDATE_FIXTURE_ID)
        return { admitted: false, reason: 'unknown-fixture', rejected: true };
    const caseId = caseIdParts.join(':');
    if (!ACCEPTANCE_CASE_ID_PATTERN.test(caseId))
        return { admitted: false, reason: 'invalid-case-id', rejected: true };
    return {
        admitted: true,
        caseId,
        release: { fileName: `Caxri-${FIXTURE_VERSION}-arm64.dmg`, version: FIXTURE_VERSION },
    };
}

/**
 * Replaces only release discovery for a declared Acceptance case: the update service still publishes `checking` and
 * `available` through its normal state stream, and the Renderer still decides whether to announce it. No release URL
 * exists, so download and install stay disabled. The fixture is served at most once per launch and appends one receipt
 * line naming the case, so the evidence can prove the notification came from this fixture rather than from GitHub. A
 * rejected Acceptance request returns a discovery that always fails, so the update surfaces show an error instead of
 * silently falling back to the ordinary unpackaged state.
 */
export function createAcceptanceUpdateFixture(options: {
    environment: NodeJS.ProcessEnv;
    isPackaged: boolean;
    userDataPath: string;
}): AcceptanceUpdateDiscovery | undefined {
    const admission = admitAcceptanceUpdateFixture(options.environment, {
        isPackaged: options.isPackaged,
    });
    if (!admission.admitted) {
        if (!('rejected' in admission)) return undefined;
        const message = `The Acceptance update fixture request was rejected (${admission.reason}).`;
        return { discover: () => Promise.reject(new Error(message)) };
    }
    const receiptPath = join(options.userDataPath, RECEIPT_FILE_NAME);
    let isServed = false;
    return {
        async discover() {
            if (isServed)
                throw new Error('The Acceptance update fixture was already served in this launch.');
            await appendAcceptanceReceipt(receiptPath, {
                caseId: admission.caseId,
                fixture: ACCEPTANCE_UPDATE_FIXTURE_ID,
                version: admission.release.version,
            });
            isServed = true;
            return admission.release;
        },
    };
}

import {
    ACCEPTANCE_EXTENSION_HOST_FAULT_SEQUENCE,
    acceptanceExtensionHostFaultCaseIds,
    e2eAgentEnvironmentKeys,
    EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY,
} from '@caxri/system';

import { acceptanceSessionDeleteCaseIds } from '../../../../apps/desktop/src/main/acceptance-session-delete';
import type { DeclaredPlanFixtures } from './plan-fixtures';

/**
 * Fixture switches an Acceptance launch must never inherit from the developer's shell, kept beside the launcher so its
 * lifecycle logic stays within the file budget. Inheriting one silently arms a fixture the frozen case never declared.
 */
export const AMBIENT_ACCEPTANCE_ENVIRONMENT_KEYS = [
    ...e2eAgentEnvironmentKeys(),
    'CAXRI_E2E_AGENT_HOOKS',
    'CAXRI_ACCEPTANCE_EXTERNAL_OPEN',
    'CAXRI_ACCEPTANCE_SESSION_DELETE',
    'CAXRI_ACCEPTANCE_NATIVE_THEME_IMPORT',
    'CAXRI_ACCEPTANCE_THEME_IMPORT',
    'CAXRI_ACCEPTANCE_UPDATE',
    'CAXRI_TEST_ROOT_PATH',
    'CAXRI_TEST_ROOT_PATHS',
    'CAXRI_REAL_AGENT_E2E',
    'CAXRI_REAL_AGENT_OK',
    EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY,
] as const;

export interface AcceptanceFixtureEnvironmentInput {
    caseId: string | undefined;
    declared?: DeclaredPlanFixtures;
    hasTestRootFixture: boolean;
    /**
     * Whether this launcher process carries the explicit native-dialog authorization marker.
     */
    isNativeDialogAuthorized: boolean;
}

/**
 * Arms exactly the fixtures the launched case is admitted to, and nothing else. Theme import and update fixtures are
 * admitted by the case's frozen-plan declaration; the remaining fixed-case sets live with their own fixtures. Main
 * rejects an Acceptance **Import Theme** that was armed neither for the fixture nor for the native handoff, instead of
 * opening the real macOS panel.
 */
export function acceptanceFixtureEnvironment({
    caseId,
    declared = {},
    hasTestRootFixture,
    isNativeDialogAuthorized,
}: AcceptanceFixtureEnvironmentInput) {
    if (!hasTestRootFixture && declared.themeImportFixture === true) {
        throw new Error(
            `Acceptance case ${caseId} declares themeImportFixture, which needs the default test-root fixture; drop --native-dialog`,
        );
    }
    return {
        CAXRI_ACCEPTANCE_EXTERNAL_OPEN:
            caseId === 'session-pr-open-parity' ? 'session-pr-open-parity-v1' : undefined,
        /**
         * Only a case that declared `themeImportFixture: false` may reach the real panel, and only under the explicit
         * native-dialog authorization; Main never reads the raw marker itself.
         */
        CAXRI_ACCEPTANCE_NATIVE_THEME_IMPORT:
            isNativeDialogAuthorized && declared.themeImportFixture === false ? '1' : undefined,
        CAXRI_ACCEPTANCE_SESSION_DELETE: acceptanceSessionDeleteCaseIds.has(caseId ?? '')
            ? caseId
            : undefined,
        CAXRI_ACCEPTANCE_THEME_IMPORT: declared.themeImportFixture === true ? caseId : undefined,
        CAXRI_ACCEPTANCE_UPDATE:
            caseId && declared.updateFixture ? `${declared.updateFixture}:${caseId}` : undefined,
        [EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY]: acceptanceExtensionHostFaultCaseIds.has(
            caseId ?? '',
        )
            ? ACCEPTANCE_EXTENSION_HOST_FAULT_SEQUENCE
            : undefined,
    };
}

import {
    ACCEPTANCE_EXTENSION_HOST_FAULT_SEQUENCE,
    acceptanceExtensionHostFaultCaseIds,
    e2eAgentEnvironmentKeys,
    EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY,
} from '@caxri/system';

import { acceptanceSessionDeleteCaseIds } from '../../../../apps/desktop/src/main/acceptance-session-delete';
import { acceptanceThemeImportCaseIds } from '../../../../apps/desktop/src/main/acceptance-theme-import';

/**
 * Fixture switches an Acceptance launch must never inherit from the developer's shell, kept beside the launcher so its
 * lifecycle logic stays within the file budget. Inheriting one silently arms a fixture the frozen case never declared.
 */
export const AMBIENT_ACCEPTANCE_ENVIRONMENT_KEYS = [
    ...e2eAgentEnvironmentKeys(),
    'CAXRI_E2E_AGENT_HOOKS',
    'CAXRI_ACCEPTANCE_EXTERNAL_OPEN',
    'CAXRI_ACCEPTANCE_SESSION_DELETE',
    'CAXRI_ACCEPTANCE_THEME_IMPORT',
    'CAXRI_TEST_ROOT_PATH',
    'CAXRI_TEST_ROOT_PATHS',
    'CAXRI_REAL_AGENT_E2E',
    'CAXRI_REAL_AGENT_OK',
    EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY,
] as const;

/**
 * Arms exactly the fixtures the launched case id is admitted to, and nothing else. Each admitted-id set lives with its
 * own fixture, so an unlisted case degrades into the real native boundary rather than a silently faked one.
 */
export function acceptanceFixtureEnvironment(
    caseId: string | undefined,
    hasTestRootFixture: boolean,
) {
    return {
        CAXRI_ACCEPTANCE_EXTERNAL_OPEN:
            caseId === 'session-pr-open-parity' ? 'session-pr-open-parity-v1' : undefined,
        CAXRI_ACCEPTANCE_SESSION_DELETE: acceptanceSessionDeleteCaseIds.has(caseId ?? '')
            ? caseId
            : undefined,
        CAXRI_ACCEPTANCE_THEME_IMPORT:
            hasTestRootFixture && acceptanceThemeImportCaseIds.has(caseId ?? '')
                ? caseId
                : undefined,
        [EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY]: acceptanceExtensionHostFaultCaseIds.has(
            caseId ?? '',
        )
            ? ACCEPTANCE_EXTENSION_HOST_FAULT_SEQUENCE
            : undefined,
    };
}

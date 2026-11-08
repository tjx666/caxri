import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileUiAuditScenario } from '../mobile-ui-audit-scenarios';

export const handlers = {
    'MOB-SESSION-SEARCH-01': executeMobileUiAuditScenario,
    'MOB-SESSION-SEARCH-ZH-01': executeMobileUiAuditScenario,
    'MOB-UI-01': executeMobileUiAuditScenario,
    'MOB-UI-02': executeMobileUiAuditScenario,
    'MOB-UI-03': executeMobileUiAuditScenario,
    'MOB-UI-05': executeMobileUiAuditScenario,
    'MOB-UI-06': executeMobileUiAuditScenario,
    'MOB-UI-07': executeMobileUiAuditScenario,
    'MOB-UI-08': executeMobileUiAuditScenario,
    'MOB-UI-09': executeMobileUiAuditScenario,
    'MOB-UI-10': executeMobileUiAuditScenario,
    'MOB-UI-DESKTOP-UPDATE-01': executeMobileUiAuditScenario,
    'MOB-UI-HEADER-ACTIONS-01': executeMobileUiAuditScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;

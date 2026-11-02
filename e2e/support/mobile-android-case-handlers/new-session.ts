import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { requireLaunchIdentity } from '../mobile-android-case-registry';
import { executeMobileNewSessionScenario } from '../mobile-new-session-scenarios';
import { executeMobileNewSessionSwitchScenario } from '../mobile-new-session-switch-scenario';

const executeNewSession: MobileAndroidCaseHandler = (environment, artifacts) =>
    executeMobileNewSessionScenario(requireLaunchIdentity(environment, 'New Session'), artifacts);

export const handlers = {
    'MOB-CROSS-01': executeNewSession,
    'MOB-NEW-01': executeNewSession,
    'MOB-NEW-02': executeNewSession,
    'MOB-NEW-SWITCH-01': executeMobileNewSessionSwitchScenario,
    'MOB-PARTIAL-01': executeNewSession,
} satisfies Record<string, MobileAndroidCaseHandler>;

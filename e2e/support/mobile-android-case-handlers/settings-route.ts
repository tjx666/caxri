import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileSettingsRouteScenario } from '../mobile-settings-route-scenario';

export const handlers = {
    'MOB-SETTINGS-ROUTE-01': executeMobileSettingsRouteScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;

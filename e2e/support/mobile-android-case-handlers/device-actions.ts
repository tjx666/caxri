import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileDeviceActionsScenario } from '../mobile-device-actions-scenario';

export const handlers = {
    'MOB-DEVICE-ACTIONS-01': executeMobileDeviceActionsScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;

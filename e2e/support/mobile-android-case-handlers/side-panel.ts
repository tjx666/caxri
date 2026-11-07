import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import {
    executeMobileSidePanelContentSwitchScenario,
    executeMobileSidePanelPhoneScenario,
    executeMobileSidePanelTabletScenario,
} from '../mobile-session-side-panel-scenario';

export const handlers = {
    'MOB-SIDE-PANEL-PHONE-01': executeMobileSidePanelPhoneScenario,
    'MOB-SIDE-PANEL-PHONE-02': executeMobileSidePanelContentSwitchScenario,
    'MOB-SIDE-PANEL-TABLET-01': executeMobileSidePanelTabletScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;

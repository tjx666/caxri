import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileSidePanelCloseScenario } from '../mobile-session-side-panel-close-scenario';
import {
    executeMobileSidePanelContentSwitchScenario,
    executeMobileSidePanelPhoneScenario,
    executeMobileSidePanelTabletScenario,
} from '../mobile-session-side-panel-scenario';

export const handlers = {
    'MOB-SIDE-PANEL-PHONE-01': executeMobileSidePanelPhoneScenario,
    'MOB-SIDE-PANEL-PHONE-02': executeMobileSidePanelContentSwitchScenario,
    'MOB-SIDE-PANEL-PHONE-03': executeMobileSidePanelCloseScenario,
    'MOB-SIDE-PANEL-TABLET-01': executeMobileSidePanelTabletScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;

import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import {
    executeMobileSessionArchiveTimeoutScenario,
    executeMobileSessionArchiveUndoOfflineScenario,
    executeMobileSessionArchiveUndoScenario,
} from '../mobile-session-archive-undo-scenario';

export const handlers = {
    'MOB-SESSION-ARCHIVE-UNDO-01': executeMobileSessionArchiveUndoScenario,
    'MOB-SESSION-ARCHIVE-UNDO-02': executeMobileSessionArchiveTimeoutScenario,
    'MOB-SESSION-ARCHIVE-UNDO-03': executeMobileSessionArchiveUndoOfflineScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;

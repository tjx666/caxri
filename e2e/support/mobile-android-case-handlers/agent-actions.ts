import {
    executeMobileComposerSuggestionsScenario,
    executeMobileFileEditScenario,
    executeMobileImageAttachmentScenario,
} from '../mobile-agent-actions-scenarios';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { requireRemoteVideoPath } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-COMPOSE-01': (environment, artifacts) =>
        executeMobileComposerSuggestionsScenario(
            environment,
            artifacts,
            requireRemoteVideoPath(environment),
        ),
    'MOB-COMPOSE-02': (environment, artifacts) =>
        executeMobileImageAttachmentScenario(
            environment,
            artifacts,
            requireRemoteVideoPath(environment),
        ),
    'MOB-EDIT-01': executeMobileFileEditScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;

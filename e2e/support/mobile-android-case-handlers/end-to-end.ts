import { test } from '../fixtures';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { requireLaunchIdentity } from '../mobile-android-case-registry';
import { executeMobileEndToEndScenario } from '../mobile-end-to-end-scenarios';

const executeJourney: MobileAndroidCaseHandler = (environment, artifacts) => {
    test.setTimeout(420_000);
    return executeMobileEndToEndScenario(
        requireLaunchIdentity(environment, 'Integrated journey'),
        artifacts,
    );
};

export const handlers = {
    'MOB-E2E-01': executeJourney,
    'MOB-E2E-02A': executeJourney,
    'MOB-E2E-02B': executeJourney,
    'MOB-E2E-02C': executeJourney,
    'MOB-E2E-02D': executeJourney,
    'MOB-E2E-03': executeJourney,
} satisfies Record<string, MobileAndroidCaseHandler>;

import { tapMobileCheck } from './mobile-android';
import type { UiAuditScenarioEnvironment } from './mobile-ui-audit-support';
import { capture, finish, hasCheck, waitFor } from './mobile-ui-audit-support';

/**
 * Settings' Computer section with the Acceptance update fixture armed on the paired Desktop: the computer's version and
 * the staged `999.0.0` update. An unpackaged Desktop can only install it by hand, so the phone names that instead of
 * offering the restart.
 */
export async function executeMobileDesktopUpdateSettings(
    environment: UiAuditScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    await tapMobileCheck(serial, 'computer-menu-button');
    await waitFor(serial, (nodes) => hasCheck(nodes, 'settings-action'));
    await tapMobileCheck(serial, 'settings-action');
    await waitFor(
        serial,
        (nodes) =>
            hasCheck(nodes, 'settings-desktop-version') &&
            hasCheck(nodes, 'settings-desktop-update'),
    );
    await capture(environment, 'computer-update', artifacts, 'settings-desktop-update');
    await tapMobileCheck(serial, 'settings-back');
    await waitFor(serial, (nodes) => hasCheck(nodes, 'new-session-button'));
    await finish(environment, artifacts, { status: 'passed' });
}

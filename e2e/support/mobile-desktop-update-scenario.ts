import { mobileSemantics, tapMobileCheck } from './mobile-android';
import type { UiAuditScenarioEnvironment } from './mobile-ui-audit-support';
import { assertStaysAbsent, capture, finish, hasCheck, waitFor } from './mobile-ui-audit-support';

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
    // A manual install offers no restart from the phone: both rows stay disabled and no confirmation opens.
    const nodes = await mobileSemantics(serial);
    const enabled = nodes.filter(
        ({ checkId, enabled }) =>
            enabled &&
            (checkId === 'settings-desktop-update' || checkId === 'settings-desktop-version'),
    );
    if (enabled.length > 0)
        throw new Error(
            `A manual install must not be actionable: ${enabled.map(({ checkId }) => checkId).join(', ')}`,
        );
    await assertStaysAbsent(serial, ['desktop-update-confirm-sheet']);
    await tapMobileCheck(serial, 'settings-back');
    await waitFor(serial, (nodes) => hasCheck(nodes, 'new-session-button'));
    await finish(environment, artifacts, { status: 'passed' });
}

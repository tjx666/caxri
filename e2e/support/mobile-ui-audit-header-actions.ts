import { adbShell, androidBounds, mobileSemantics, tapMobileCheck } from './mobile-android';
import { captureScenarioFrame } from './mobile-scenario-capture';
import type { UiAuditScenarioEnvironment } from './mobile-ui-audit-support';
import { capture, finish, hasCheck, waitFor } from './mobile-ui-audit-support';

/**
 * Holds a finger on a control and captures the frame mid-press, so the evidence shows the Android ripple rather than
 * the settled state. The bounds are read before the gesture starts, because a semantic dump during the hold would
 * outlast the wait before the capture.
 */
async function captureWhilePressed(
    environment: UiAuditScenarioEnvironment,
    checkId: string,
    label: string,
    artifacts: string[],
): Promise<void> {
    const nodes = await mobileSemantics(environment.serial);
    const target = nodes.find((node) => node.checkId === checkId);
    const bounds = target && androidBounds(target.bounds);
    if (!bounds) throw new Error(`UI audit Acceptance did not reach ${checkId}`);
    const x = String(Math.floor((bounds.left + bounds.right) / 2));
    const y = String(Math.floor((bounds.top + bounds.bottom) / 2));
    const hold = adbShell(environment.serial, ['input', 'swipe', x, y, x, y, '3000']);
    await new Promise((resolve) => {
        setTimeout(resolve, 700);
    });
    await captureScenarioFrame(environment, label, artifacts);
    await hold;
}

/**
 * The distance between the centers of the home header's Search and computer menu buttons, in dp. The New Session
 * button's fixed 58dp width supplies the density, so the check holds on any emulator.
 */
async function headerActionSpacingDp(serial: string): Promise<number> {
    const nodes = await waitFor(serial, (current) => hasCheck(current, 'computer-menu-button'));
    const boundsOf = (checkId: string) => {
        const node = nodes.find((current) => current.checkId === checkId);
        const bounds = node && androidBounds(node.bounds);
        if (!bounds) throw new Error(`UI audit Acceptance did not reach ${checkId}`);
        return bounds;
    };
    const search = boundsOf('session-search-button');
    const menu = boundsOf('computer-menu-button');
    const fab = boundsOf('new-session-button');
    const density = (fab.right - fab.left) / 58;
    return ((menu.left + menu.right) / 2 - (search.left + search.right) / 2) / density;
}

/**
 * The home header's trailing actions and the round New Session button, then the Session detail header's trailing
 * actions, each settled and mid-press.
 */
export async function headerActions(
    environment: UiAuditScenarioEnvironment,
    artifacts: string[],
    sessionId: string,
) {
    const { serial } = environment;
    await capture(environment, 'home', artifacts, 'new-session-button');
    const spacingDp = await headerActionSpacingDp(serial);
    await captureWhilePressed(
        environment,
        'session-search-button',
        'home-search-pressed',
        artifacts,
    );
    // Releasing the hold opens search; Back returns to the list.
    await waitFor(serial, (nodes) => hasCheck(nodes, 'session-search-input'));
    await adbShell(serial, ['input', 'keyevent', '4']);
    await waitFor(serial, (nodes) => hasCheck(nodes, 'new-session-button'));
    await captureWhilePressed(environment, 'new-session-button', 'new-session-pressed', artifacts);
    await waitFor(serial, (nodes) => hasCheck(nodes, 'new-session-agent-claude'));
    await adbShell(serial, ['input', 'keyevent', '4']);
    await waitFor(serial, (nodes) => hasCheck(nodes, `session-row-${sessionId}`));
    await tapMobileCheck(serial, `session-row-${sessionId}`);
    await waitFor(serial, (nodes) => hasCheck(nodes, 'session-panel-button'));
    await capture(environment, 'detail', artifacts, 'session-detail-menu');
    await captureWhilePressed(environment, 'session-detail-menu', 'detail-menu-pressed', artifacts);
    // Asserted after every capture, so a baseline run on the old 44dp buttons still leaves its screenshots.
    if (spacingDp > 41)
        throw new Error(`Home header actions sit ${spacingDp.toFixed(1)}dp apart, above 41dp`);
    await finish(environment, artifacts, { headerActionSpacingDp: spacingDp, status: 'passed' });
}

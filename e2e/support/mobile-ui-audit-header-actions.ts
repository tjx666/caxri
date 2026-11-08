import { adbShell, androidBounds, mobileSemantics, tapMobileCheck } from './mobile-android';
import { captureScenarioFrame } from './mobile-scenario-capture';
import { closeSessionSidePanel } from './mobile-session-panel';
import type { UiAuditScenarioEnvironment } from './mobile-ui-audit-support';
import { capture, finish, hasCheck, waitFor } from './mobile-ui-audit-support';

/**
 * The target center distance between neighboring header actions is 40dp (two 40dp toolbar buttons with no gap); 1dp
 * absorbs pixel rounding. The old 44dp buttons sat 44dp apart on the home header and 48dp on Session detail.
 */
const MAX_ACTION_SPACING_DP = 41;

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
 * Pixels per dp, from the New Session button's fixed 58dp width, so the spacing check holds on any emulator.
 */
async function densityFromNewSessionButton(serial: string): Promise<number> {
    const nodes = await mobileSemantics(serial);
    const node = nodes.find((current) => current.checkId === 'new-session-button');
    const bounds = node && androidBounds(node.bounds);
    if (!bounds) throw new Error('UI audit Acceptance did not reach new-session-button');
    return (bounds.right - bounds.left) / 58;
}

/**
 * The distance between the centers of two neighboring header actions, in dp.
 */
async function actionSpacingDp(
    serial: string,
    leading: string,
    trailing: string,
    density: number,
): Promise<number> {
    const nodes = await waitFor(serial, (current) => hasCheck(current, trailing));
    const boundsOf = (checkId: string) => {
        const node = nodes.find((current) => current.checkId === checkId);
        const bounds = node && androidBounds(node.bounds);
        if (!bounds) throw new Error(`UI audit Acceptance did not reach ${checkId}`);
        return bounds;
    };
    const first = boundsOf(leading);
    const second = boundsOf(trailing);
    return ((second.left + second.right) / 2 - (first.left + first.right) / 2) / density;
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
    const density = await densityFromNewSessionButton(serial);
    const homeSpacingDp = await actionSpacingDp(
        serial,
        'session-search-button',
        'computer-menu-button',
        density,
    );
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
    // Releasing the hold opens New Session; Back returns to the list.
    await waitFor(serial, (nodes) => hasCheck(nodes, 'new-session-agent-claude'));
    await adbShell(serial, ['input', 'keyevent', '4']);
    await waitFor(serial, (nodes) => hasCheck(nodes, `session-row-${sessionId}`));
    await tapMobileCheck(serial, `session-row-${sessionId}`);
    await waitFor(serial, (nodes) => hasCheck(nodes, 'session-panel-button'));
    await capture(environment, 'detail', artifacts, 'session-detail-menu');
    const detailSpacingDp = await actionSpacingDp(
        serial,
        'session-panel-button',
        'session-detail-menu',
        density,
    );
    await captureWhilePressed(
        environment,
        'session-panel-button',
        'detail-panel-pressed',
        artifacts,
    );
    // Releasing the hold opens the side panel, which would cover the menu button.
    await waitFor(serial, (nodes) => hasCheck(nodes, 'session-side-panel'));
    await closeSessionSidePanel(serial);
    await captureWhilePressed(environment, 'session-detail-menu', 'detail-menu-pressed', artifacts);
    const receipt = { detailSpacingDp, homeSpacingDp };
    // Asserted after every capture, so a baseline run on the old buttons still leaves its screenshots.
    if (homeSpacingDp > MAX_ACTION_SPACING_DP || detailSpacingDp > MAX_ACTION_SPACING_DP)
        throw new Error(`Header actions sit too far apart: ${JSON.stringify(receipt)}`);
    await finish(environment, artifacts, { ...receipt, status: 'passed' });
}

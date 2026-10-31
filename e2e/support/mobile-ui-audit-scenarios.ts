import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomic } from '../../scripts/atomic-json';
import { pageRequest } from './helpers';
import type { MobileAcceptanceFixture } from './mobile-acceptance-fixture';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import {
    adbShell,
    androidBounds,
    captureMobileFramebuffer,
    mobileSemantics,
    setMobileNetworkAvailable,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import { seedMobileChangesFixture } from './mobile-changes-fixture';

interface UiAuditScenarioEnvironment {
    artifactManifestPath: string;
    assetsDirectory: string;
    caseId: string;
    scenarioReceiptPath: string;
    serial: string;
}

type SemanticNodes = Awaited<ReturnType<typeof mobileSemantics>>;

const hasCheck = (nodes: SemanticNodes, id: string): boolean =>
    nodes.some(({ checkId }) => checkId === id);

const waitFor = (serial: string, isReady: (nodes: SemanticNodes) => boolean) =>
    waitForMobile(() => mobileSemantics(serial), isReady);

/**
 * A missing control is only proven by repeated observations after the screen has settled, not by one early read.
 */
export async function assertStaysAbsent(serial: string, ids: readonly string[]): Promise<void> {
    for (let sample = 0; sample < 5; sample += 1) {
        // eslint-disable-next-line no-await-in-loop -- each sample is one timed observation of the same screen.
        const nodes = await mobileSemantics(serial);
        const present = ids.filter((id) => hasCheck(nodes, id));
        if (present.length > 0) throw new Error(`UI audit expected no ${present.join(', ')}`);
        // eslint-disable-next-line no-await-in-loop -- samples are spaced so a late render is caught.
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}

/**
 * Terminal frames need the fixture preflight before capture, so these scenarios refuse to screenshot one.
 */
async function capture(
    environment: UiAuditScenarioEnvironment,
    label: string,
    artifacts: string[],
    requiredId: string,
): Promise<void> {
    const nodes = await mobileSemantics(environment.serial);
    if (hasCheck(nodes, 'terminal-live-webview'))
        throw new Error('UI audit Acceptance cannot capture a Terminal frame');
    if (!hasCheck(nodes, requiredId))
        throw new Error(`UI audit Acceptance did not reach ${requiredId}`);
    const name = `${environment.caseId}-${label}-android.png`;
    await captureMobileFramebuffer(environment.serial, join(environment.assetsDirectory, name));
    artifacts.push(`assets/${name}`);
}

async function finish(
    environment: UiAuditScenarioEnvironment,
    artifacts: string[],
    receipt: Record<string, unknown>,
): Promise<void> {
    await Promise.all([
        writeJsonAtomic(environment.artifactManifestPath, { artifacts, schemaVersion: 1 }),
        writeFile(
            environment.scenarioReceiptPath,
            `${JSON.stringify({ ...receipt, caseId: environment.caseId, schemaVersion: 1 }, null, 2)}\n`,
            'utf8',
        ),
    ]);
}

async function openSession(serial: string, sessionId: string): Promise<void> {
    await tapMobileCheck(serial, `session-row-${sessionId}`);
    await waitFor(serial, (nodes) => hasCheck(nodes, 'session-segment-terminal'));
}

async function projectTab(environment: UiAuditScenarioEnvironment, artifacts: string[]) {
    await waitFor(environment.serial, (current) =>
        hasCheck(current, 'session-segment-panel-caxri.files'),
    );
    await tapMobileCheck(environment.serial, 'session-segment-panel-caxri.files');
    const nodes = await waitFor(environment.serial, (current) => hasCheck(current, 'files-panel'));
    if (hasCheck(nodes, 'session-segment-panel-caxri.git'))
        throw new Error('The Session tabs still list the Git view the Changes tab owns');
    await capture(environment, 'project-tab', artifacts, 'panels-view');
    await finish(environment, artifacts, {
        gitSubTab: 'absent',
        status: 'passed',
    });
}

async function changesPolish(environment: UiAuditScenarioEnvironment, artifacts: string[]) {
    await tapMobileCheck(environment.serial, 'session-segment-changes');
    await waitFor(environment.serial, (nodes) => hasCheck(nodes, 'changes-file-row-0'));
    await capture(environment, 'changes-list', artifacts, 'changes-summary');
    await tapMobileCheck(environment.serial, 'changes-file-row-0');
    await waitFor(environment.serial, (nodes) => hasCheck(nodes, 'changes-diff-scroll'));
    await capture(environment, 'text-diff', artifacts, 'changes-diff-scroll');
    await finish(environment, artifacts, { status: 'passed' });
}

async function offlineStates(environment: UiAuditScenarioEnvironment, artifacts: string[]) {
    const { serial } = environment;
    /**
     * The Files tab appears once the panel list loads online; it is then opened for the first time while offline, so
     * its reads are pending but idle and it must explain the missing connection instead of spinning. It runs before the
     * Terminal ever mounts so the capture stays clean.
     */
    await waitFor(serial, (nodes) => hasCheck(nodes, 'session-segment-panel-caxri.files'));
    await setMobileNetworkAvailable(serial, false);
    try {
        await tapMobileCheck(serial, 'session-segment-panel-caxri.files');
        await waitFor(serial, (nodes) => hasCheck(nodes, 'panels-offline'));
        await capture(environment, 'project-offline', artifacts, 'panels-offline');
    } finally {
        await setMobileNetworkAvailable(serial, true);
    }
    await waitFor(serial, (nodes) => !hasCheck(nodes, 'connection-stale-banner'));
    await waitFor(serial, (nodes) => hasCheck(nodes, 'files-panel'));
    await capture(environment, 'project-recovered', artifacts, 'files-panel');
    await tapMobileCheck(serial, 'session-segment-terminal');
    await waitFor(serial, (nodes) => hasCheck(nodes, 'terminal-live-webview'));
    await setMobileNetworkAvailable(serial, false);
    try {
        await waitFor(serial, (nodes) => hasCheck(nodes, 'connection-stale-banner'));
        await assertStaysAbsent(serial, ['terminal-stale']);
        await tapMobileCheck(serial, 'session-detail-back');
        await waitFor(serial, (nodes) => hasCheck(nodes, 'new-session-button'));
        await tapMobileCheck(serial, 'new-session-button');
        await waitFor(serial, (nodes) => hasCheck(nodes, 'new-session-agent-claude'));
        await capture(environment, 'new-session-offline', artifacts, 'new-session-agent-claude');
    } finally {
        await setMobileNetworkAvailable(serial, true);
    }
    await finish(environment, artifacts, {
        offlineProjectTab: 'reconnect-message',
        offlineTerminalStaleChip: 'absent-while-banner-shown',
        status: 'passed',
    });
}

async function projectIcons(
    environment: UiAuditScenarioEnvironment,
    artifacts: string[],
    fixture: MobileAcceptanceFixture,
    sessionId: string,
) {
    const { serial } = environment;
    /**
     * Extension trees follow Desktop's active Session, so select it there before the phone reads them.
     */
    await pageRequest(fixture.running.page, 'session.select', { sessionId });
    await waitFor(serial, (nodes) => hasCheck(nodes, 'session-segment-panel-caxri.files'));
    await tapMobileCheck(serial, 'session-segment-panel-caxri.files');
    await waitFor(serial, (nodes) => hasCheck(nodes, 'files-panel'));
    await capture(environment, 'files', artifacts, 'files-panel');
    const nodes = await mobileSemantics(serial);
    const treeTabs = nodes
        .map(({ checkId }) => checkId)
        .filter(
            (id) =>
                id.startsWith('session-segment-panel-') &&
                id !== 'session-segment-panel-caxri.files',
        );
    if (treeTabs.length === 0) throw new Error('The Session tabs list no tree view besides Files');
    /**
     * Tabs are keyed by panel id while the tree body is keyed by view id, so wait for any rendered tree body rather
     * than deriving its id from the tab.
     */
    const treeViews: string[] = [];
    const TREE_STATES = new Set(['tree-panel-error']);
    const isNewTree = (id: string) =>
        id.startsWith('tree-panel-') && !TREE_STATES.has(id) && !treeViews.includes(id);
    for (const [index, treeTab] of treeTabs.entries()) {
        // eslint-disable-next-line no-await-in-loop -- Each tab is opened and captured in turn on one device.
        await tapMobileCheck(serial, treeTab);
        // eslint-disable-next-line no-await-in-loop -- The capture must follow this tab's render.
        const rendered = await waitFor(
            serial,
            (current) =>
                current.some(({ checkId }) => isNewTree(checkId)) &&
                current.some(({ checkId }) => checkId === 'tree-row' || TREE_STATES.has(checkId)),
        );
        const ids = rendered.map(({ checkId }) => checkId);
        const failedState = ids.find((id) => TREE_STATES.has(id));
        if (failedState) throw new Error(`Tree view did not load rows: ${failedState}`);
        const treePanel = ids.find((id) => isNewTree(id));
        if (!treePanel) throw new Error('Tree view body is missing');
        treeViews.push(treePanel);
        // eslint-disable-next-line no-await-in-loop -- Captures are sequential device reads.
        await capture(environment, `tree-view-${index + 1}`, artifacts, treePanel);
    }
    await finish(environment, artifacts, { status: 'passed', treeViews: treeViews.length });
}

/**
 * Drags a Session row leftward from its right side, away from the system Back gesture edges, to reveal its action. The
 * caller passes bounds it already knows, so no semantic read has to run right before the gesture.
 */
export async function swipeRowBoundsLeft(
    serial: string,
    bounds: { bottom: number; left: number; right: number; top: number },
    durationMs = 300,
): Promise<void> {
    const y = Math.floor((bounds.top + bounds.bottom) / 2);
    const width = bounds.right - bounds.left;
    await adbShell(serial, [
        'input',
        'swipe',
        String(Math.floor(bounds.left + width * 0.8)),
        String(y),
        String(Math.floor(bounds.left + width * 0.3)),
        String(y),
        String(durationMs),
    ]);
}

/**
 * Reads the current bounds of the Session row `rowId`, then swipes it like `swipeRowBoundsLeft`.
 */
async function swipeRowLeft(serial: string, rowId: string): Promise<void> {
    const row = (await mobileSemantics(serial)).find(({ checkId }) => checkId === rowId);
    const bounds = row && androidBounds(row.bounds);
    if (!bounds) throw new Error('Synthetic Session row is unavailable');
    await swipeRowBoundsLeft(serial, bounds);
}

const sessionTitle = async (fixture: MobileAcceptanceFixture, sessionId: string) => {
    const result = await pageRequest<{
        sessions: Array<{ archivedAt?: number; title: string }>;
    }>(fixture.running.page, 'session.query', { mode: 'show', selector: sessionId });
    const session = result.sessions.at(0);
    if (!session) throw new Error('Synthetic Session disappeared');
    return session;
};

async function sessionManagement(
    environment: UiAuditScenarioEnvironment,
    artifacts: string[],
    fixture: MobileAcceptanceFixture,
    sessionId: string,
) {
    const { serial } = environment;
    const row = `session-row-${sessionId}`;
    await tapMobileCheck(serial, row, { isLongPress: true });
    await waitFor(serial, (nodes) => hasCheck(nodes, 'session-action-rename'));
    await capture(environment, 'actions', artifacts, 'session-actions-sheet');
    await tapMobileCheck(serial, 'session-action-rename');
    await waitFor(serial, (nodes) => hasCheck(nodes, 'session-rename-input'));
    /**
     * The field selects its text on focus, so typed ASCII replaces the old title; `%s` is ADB's escaped space.
     */
    await adbShell(serial, ['input', 'text', 'Mobile%sRenamed']);
    await capture(environment, 'rename', artifacts, 'session-rename-save');
    await tapMobileCheck(serial, 'session-rename-save');
    await waitFor(serial, (nodes) => !hasCheck(nodes, 'session-actions-sheet'));
    const renamed = await sessionTitle(fixture, sessionId);
    if (renamed.title !== 'Mobile Renamed')
        throw new Error('The Desktop Session title did not change');

    await tapMobileCheck(serial, row, { isLongPress: true });
    await waitFor(serial, (nodes) => hasCheck(nodes, 'session-action-archive'));
    await tapMobileCheck(serial, 'session-action-archive');
    await waitFor(
        serial,
        (nodes) => !hasCheck(nodes, row) && !hasCheck(nodes, 'session-actions-sheet'),
    );
    if ((await sessionTitle(fixture, sessionId)).archivedAt === undefined)
        throw new Error('The Desktop Session was not archived');

    await tapMobileCheck(serial, 'computer-menu-button');
    await waitFor(serial, (nodes) => hasCheck(nodes, 'archived-sessions-action'));
    await tapMobileCheck(serial, 'archived-sessions-action');
    await waitFor(serial, (nodes) => hasCheck(nodes, `archived-session-restore-${sessionId}`));
    await capture(environment, 'archived-list', artifacts, 'archived-sessions-screen');
    await tapMobileCheck(serial, `archived-session-restore-${sessionId}`);
    await waitFor(serial, (nodes) => !hasCheck(nodes, `archived-session-${sessionId}`));
    await capture(environment, 'archived-empty', artifacts, 'archived-sessions-screen');
    if ((await sessionTitle(fixture, sessionId)).archivedAt !== undefined)
        throw new Error('The Desktop Session was not restored');
    await tapMobileCheck(serial, 'archived-sessions-back');
    await waitFor(serial, (nodes) => hasCheck(nodes, row));
    await capture(environment, 'restored-home', artifacts, row);

    const swipeArchive = `session-swipe-archive-${sessionId}`;
    await swipeRowLeft(serial, row);
    await waitFor(serial, (nodes) => hasCheck(nodes, swipeArchive));
    await capture(environment, 'swipe-archive', artifacts, swipeArchive);
    await tapMobileCheck(serial, swipeArchive);
    await waitFor(serial, (nodes) => !hasCheck(nodes, row));
    if ((await sessionTitle(fixture, sessionId)).archivedAt === undefined)
        throw new Error('The swiped Desktop Session was not archived');
    await finish(environment, artifacts, {
        archive: 'removed-from-home-and-archived-on-desktop',
        swipeArchive: 'revealed-then-archived-on-desktop',
        rename: 'desktop-title-updated',
        restore: 'listed-then-restored-to-home',
        status: 'passed',
    });
}

/**
 * Proves the Rename Session sheet stays usable once the keyboard opens (#1444). The capture is visual evidence that the
 * input and Save button render above the keyboard; the Save tap itself is the behavioral assertion, because a button
 * hidden underneath the keyboard receives the tap at its real screen coordinates and never responds, which is exactly
 * how this regressed before the `BottomSheet` keyboard-avoidance fix.
 */
async function renameKeyboardAvoidance(
    environment: UiAuditScenarioEnvironment,
    artifacts: string[],
    sessionId: string,
) {
    const { serial } = environment;
    const row = `session-row-${sessionId}`;
    await tapMobileCheck(serial, row, { isLongPress: true });
    await waitFor(serial, (nodes) => hasCheck(nodes, 'session-action-rename'));
    await tapMobileCheck(serial, 'session-action-rename');
    await waitFor(serial, (nodes) => hasCheck(nodes, 'session-rename-input'));
    await adbShell(serial, ['input', 'text', 'Mobile%sKeyboard%sRenamed']);
    /**
     * `capture()` takes a single accessibility snapshot instead of polling, so it can race the re-render that `input
     * text` triggers; wait for the settled tree first instead of asserting on whichever frame lands first.
     */
    await waitFor(serial, (nodes) => hasCheck(nodes, 'session-rename-save'));
    await capture(environment, 'keyboard-open', artifacts, 'session-rename-save');
    await tapMobileCheck(serial, 'session-rename-save');
    await waitFor(serial, (nodes) => !hasCheck(nodes, 'session-actions-sheet'));
    await capture(environment, 'saved', artifacts, row);
    await finish(environment, artifacts, {
        keyboardAvoidance: 'input-and-save-remained-reachable',
        status: 'passed',
    });
}

async function settingsPage(environment: UiAuditScenarioEnvironment, artifacts: string[]) {
    const { serial } = environment;
    await tapMobileCheck(serial, 'computer-menu-button');
    // The computer menu names the paired computer the Session home no longer titles itself with.
    await waitFor(
        serial,
        (nodes) => hasCheck(nodes, 'settings-action') && hasCheck(nodes, 'computer-menu-name'),
    );
    await capture(environment, 'menu', artifacts, 'settings-action');
    await tapMobileCheck(serial, 'settings-action');
    await waitFor(
        serial,
        (nodes) =>
            hasCheck(nodes, 'settings-access-level') &&
            hasCheck(nodes, 'settings-release-notes') &&
            hasCheck(nodes, 'settings-source-code') &&
            hasCheck(nodes, 'forget-this-computer-action'),
    );
    await capture(environment, 'settings', artifacts, 'settings-screen');
    await tapMobileCheck(serial, 'settings-back');
    await waitFor(serial, (nodes) => hasCheck(nodes, 'new-session-button'));
    await finish(environment, artifacts, { status: 'passed' });
}

/**
 * Scrolls the Computer status list by most of a screen, starting inside the list and away from Android's edge-back
 * gesture.
 */
async function scrollHostStatus(serial: string): Promise<void> {
    const scroll = (await mobileSemantics(serial)).find(
        ({ checkId }) => checkId === 'host-status-scroll',
    );
    const bounds = scroll && androidBounds(scroll.bounds);
    if (!bounds) throw new Error('Computer status list is unavailable');
    const x = Math.floor((bounds.left + bounds.right) / 2);
    const height = bounds.bottom - bounds.top;
    await adbShell(serial, [
        'input',
        'swipe',
        String(x),
        String(Math.floor(bounds.top + height * 0.8)),
        String(x),
        String(Math.floor(bounds.top + height * 0.2)),
        '400',
    ]);
}

/**
 * The Computer status screen: overview with the fixture's running Session, the memory sort, the offline banner that
 * keeps the last reading, and opening a Session from its load row.
 */
async function hostStatus(
    environment: UiAuditScenarioEnvironment,
    artifacts: string[],
    sessionId: string,
) {
    const { serial } = environment;
    const sessionRow = `host-status-session-${sessionId}`;
    await tapMobileCheck(serial, 'computer-menu-button');
    await waitFor(serial, (nodes) => hasCheck(nodes, 'computer-status-action'));
    await capture(environment, 'menu', artifacts, 'computer-status-action');
    await tapMobileCheck(serial, 'computer-status-action');
    await waitFor(
        serial,
        (nodes) =>
            hasCheck(nodes, 'host-status-cpu') &&
            hasCheck(nodes, 'host-status-memory') &&
            hasCheck(nodes, sessionRow),
    );
    await capture(environment, 'overview', artifacts, sessionRow);
    await scrollHostStatus(serial);
    await waitFor(serial, (nodes) => hasCheck(nodes, 'host-status-sort-memory'));
    await capture(environment, 'processes-by-cpu', artifacts, 'host-status-processes');
    await tapMobileCheck(serial, 'host-status-sort-memory');
    await waitFor(serial, (nodes) => hasCheck(nodes, 'host-status-processes'));
    await capture(environment, 'processes-by-memory', artifacts, 'host-status-processes');
    await setMobileNetworkAvailable(serial, false);
    try {
        await waitFor(serial, (nodes) => hasCheck(nodes, 'host-status-stale'));
        await capture(environment, 'offline', artifacts, 'host-status-stale');
    } finally {
        await setMobileNetworkAvailable(serial, true);
    }
    await waitFor(serial, (nodes) => !hasCheck(nodes, 'host-status-stale'));
    await capture(environment, 'recovered', artifacts, 'host-status-processes');
    await tapMobileCheck(serial, 'host-status-back');
    await waitFor(serial, (nodes) => hasCheck(nodes, 'new-session-button'));
    await tapMobileCheck(serial, 'computer-menu-button');
    await waitFor(serial, (nodes) => hasCheck(nodes, 'computer-status-action'));
    await tapMobileCheck(serial, 'computer-status-action');
    await waitFor(serial, (nodes) => hasCheck(nodes, sessionRow));
    await tapMobileCheck(serial, sessionRow);
    await waitFor(serial, (nodes) => hasCheck(nodes, 'session-detail-back'));
    await capture(environment, 'session-opened', artifacts, 'session-detail-back');
    await finish(environment, artifacts, {
        offline: 'last-reading-kept-with-banner',
        sessionRow: 'opens-session',
        status: 'passed',
    });
}

/**
 * Runs the synthetic Acceptance cases for the page-by-page mobile UI audit.
 */
export async function executeMobileUiAuditScenario(
    environment: UiAuditScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'conversation',
        seedProject: (root) => seedMobileChangesFixture(root, 'standard'),
        serial: environment.serial,
    });
    try {
        await fixture.pair();
        const sessionId = fixture.allowedSessionId;
        if (!sessionId) throw new Error('Synthetic UI audit Session is unavailable');
        await waitFor(environment.serial, (nodes) => hasCheck(nodes, `session-row-${sessionId}`));
        switch (environment.caseId) {
            case 'MOB-UI-01':
                await openSession(environment.serial, sessionId);
                await projectTab(environment, artifacts);
                break;
            case 'MOB-UI-02':
                await openSession(environment.serial, sessionId);
                await changesPolish(environment, artifacts);
                break;
            case 'MOB-UI-03':
                await openSession(environment.serial, sessionId);
                await offlineStates(environment, artifacts);
                break;
            case 'MOB-UI-05':
                await openSession(environment.serial, sessionId);
                await projectIcons(environment, artifacts, fixture, sessionId);
                break;
            case 'MOB-UI-06':
                await sessionManagement(environment, artifacts, fixture, sessionId);
                break;
            case 'MOB-UI-07':
                await settingsPage(environment, artifacts);
                break;
            case 'MOB-UI-08':
                await renameKeyboardAvoidance(environment, artifacts, sessionId);
                break;
            case 'MOB-UI-09':
            case 'MOB-UI-10':
                await hostStatus(environment, artifacts, sessionId);
                break;
            default:
                throw new Error(`Unsupported UI audit Acceptance case: ${environment.caseId}`);
        }
    } finally {
        await fixture.stop();
    }
}

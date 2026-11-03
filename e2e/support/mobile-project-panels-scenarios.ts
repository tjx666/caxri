import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';

import { writeJsonAtomic } from '../../scripts/atomic-json';
import { allowE2EErrors } from './fixtures';
import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import {
    adbShell,
    androidBounds,
    coldStartMobileApp,
    mobileRegionFingerprint,
    mobileSemantics,
    setMobileNetworkAvailable,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';
import { captureScenarioFrame } from './mobile-scenario-capture';

export interface Environment {
    artifactManifestPath: string;
    assetsDirectory: string;
    caseId: string;
    remoteVideoPath?: string;
    scenarioReceiptPath: string;
    serial: string;
}

export const hasCheck = (nodes: Awaited<ReturnType<typeof mobileSemantics>>, id: string): boolean =>
    nodes.some(({ checkId }) => checkId === id);

export async function capture(
    environment: Environment,
    label: string,
    artifacts: string[],
): Promise<void> {
    await captureScenarioFrame(environment, label, artifacts);
}

export async function finish(
    environment: Environment,
    artifacts: string[],
    result: Record<string, unknown>,
): Promise<void> {
    await Promise.all([
        writeJsonAtomic(environment.artifactManifestPath, { artifacts, schemaVersion: 1 }),
        writeFile(
            environment.scenarioReceiptPath,
            `${JSON.stringify({ ...result, caseId: environment.caseId, schemaVersion: 1 }, null, 2)}\n`,
            'utf8',
        ),
    ]);
}

type Fixture = Awaited<ReturnType<typeof createMobileAcceptanceFixture>>;

/**
 * Adds the isolated home's `mobile-new-project/nested` folder from the phone's New Session screen, which grants it to
 * the paired device and selects it for the new Session. `artifacts` receives the browse screenshots when present.
 */
export async function addProjectFromPhone(
    environment: Environment,
    fixture: Fixture,
    artifacts?: string[],
): Promise<string> {
    await tapMobileCheck(environment.serial, 'new-session-button');
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) => hasCheck(nodes, 'new-session-add-project'),
    );
    await tapMobileCheck(environment.serial, 'new-session-add-project');
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) => hasCheck(nodes, 'add-project-folder-mobile-new-project'),
    );
    if (artifacts) await capture(environment, 'browse-home', artifacts);
    await tapMobileCheck(environment.serial, 'add-project-folder-mobile-new-project');
    const nestedId = 'add-project-add-mobile-new-project/nested';
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) => hasCheck(nodes, nestedId),
    );
    if (artifacts) await capture(environment, 'browse-nested', artifacts);
    await tapMobileCheck(environment.serial, nestedId);
    const rootPath = await realpath(
        join(
            fixture.testDirectory,
            'user-data',
            'e2e-agents',
            'home',
            'mobile-new-project',
            'nested',
        ),
    );
    const state = await waitForMobile(
        () => pageRequest<BootstrapState>(fixture.running.page, 'app.bootstrap'),
        (current) => current.projects.some(({ rootPath: root }) => root === rootPath),
    );
    const added = state.projects.find((project) => project.rootPath === rootPath)!;
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) =>
            hasCheck(nodes, 'new-session-screen') &&
            nodes.some(
                ({ checkId, selected }) =>
                    checkId === `new-session-project-${added.id}` && selected,
            ),
    );
    return added.id;
}

async function addNestedProject(environment: Environment, artifacts: string[]): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        isolatedProjectHome: true,
        mode: 'launch-failure',
        serial: environment.serial,
    });
    try {
        await fixture.pair();
        await addProjectFromPhone(environment, fixture, artifacts);
        await capture(environment, 'selected-project', artifacts);
        await finish(environment, artifacts, {
            nestedTap: 'semantic',
            projectGrantedAndSelected: true,
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

async function browsePanels(environment: Environment, artifacts: string[]): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'launch-failure',
        serial: environment.serial,
    });
    try {
        const projectRoot = join(fixture.testDirectory, 'allowed-project');
        const removedFolder = join(projectRoot, 'removed-folder');
        await Promise.all([
            mkdir(join(projectRoot, 'empty-folder'), { recursive: true }),
            mkdir(removedFolder, { recursive: true }),
        ]);
        await fixture.pair();
        if (!fixture.allowedSessionId || !fixture.deniedSessionId)
            throw new Error('Panels Sessions are unavailable');
        /**
         * Desktop focuses another Session on purpose: the phone's panels, including the Extension Host Status tree,
         * must serve the Session the phone opened rather than the one Desktop is showing.
         */
        await pageRequest(fixture.running.page, 'session.select', {
            sessionId: fixture.deniedSessionId,
        });
        await waitForMobile(
            () => pageRequest<BootstrapState>(fixture.running.page, 'app.bootstrap'),
            (state) => state.selectedSessionId === fixture.deniedSessionId,
        );
        await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'session-segment-panel-caxri.files'),
        );
        await tapMobileCheck(environment.serial, 'session-segment-panel-caxri.files');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'files-entry-empty-folder'),
        );
        await tapMobileCheck(environment.serial, 'files-entry-empty-folder');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'files-empty'),
        );
        await capture(environment, 'files-empty', artifacts);
        await tapMobileCheck(environment.serial, 'files-up');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'files-entry-removed-folder'),
        );
        await rm(removedFolder, { recursive: true });
        allowE2EErrors([
            {
                source: 'server-core',
                event: 'ipc.request_failed',
                method: 'mobile.files.list',
                code: 'NOT_FOUND',
                count: 1,
            },
        ]);
        await tapMobileCheck(environment.serial, 'files-entry-removed-folder');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'files-error'),
        );
        await capture(environment, 'files-error', artifacts);
        await tapMobileCheck(environment.serial, 'files-up');
        await tapMobileCheck(environment.serial, 'session-segment-panel-caxri.project-status');
        const statusNodes = await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                hasCheck(nodes, 'tree-panel-caxri.project-status.overview') &&
                (hasCheck(nodes, 'tree-row') ||
                    hasCheck(nodes, 'tree-panel-empty') ||
                    hasCheck(nodes, 'tree-panel-error')),
        );
        if (hasCheck(statusNodes, 'tree-panel-error'))
            throw new Error('Status failed to load for a Session Desktop is not focused on');
        const statusDesktopState = await pageRequest<BootstrapState>(
            fixture.running.page,
            'app.bootstrap',
        );
        if (statusDesktopState.selectedSessionId === fixture.allowedSessionId)
            throw new Error('Desktop must stay focused on another Session while Status loads');
        await capture(environment, 'status', artifacts);
        await tapMobileCheck(environment.serial, 'session-segment-panel-caxri.fixture');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                hasCheck(nodes, 'tree-panel-caxri.fixture.tree') && hasCheck(nodes, 'tree-row'),
        );
        await capture(environment, 'extension-tree', artifacts);
        // The fixture's root rows render as Lazy children, Provider expanded, its Expanded child, Targeted refresh,
        // then Empty children (extensions/fixture/src/extension.ts); expanding it must show the nested empty row.
        await tapMobileCheckByBounds(environment.serial, 'tree-row', { rowOffset: 4 });
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'tree-nested-empty'),
        );
        await capture(environment, 'extension-tree-nested-empty', artifacts);
        await tapMobileCheck(environment.serial, 'session-segment-changes');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'changes-empty'),
        );
        await capture(environment, 'git-changes', artifacts);
        await finish(environment, artifacts, {
            panels: ['Files', 'Status', 'Fixture tree'],
            treeStates: ['nested empty'],
            filesStates: ['empty', 'error'],
            git: 'Changes segment',
            desktopFocusedOtherSession:
                statusDesktopState.selectedSessionId !== fixture.allowedSessionId,
            statusState: hasCheck(statusNodes, 'tree-row') ? 'rows' : 'empty',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * Refreshes the whole fixture tree from Desktop while the phone shows its default-expanded branch, then collapses that
 * branch. A full refresh retires every handle; the phone re-reads the root and the expanded branch together, and the
 * branch read lands before the slower root read re-registers handles, so the Server answers it with the root level and
 * `reset`. Rendering that root under the branch nested the branch inside itself forever and took the app down.
 */
async function refreshExpandedTree(environment: Environment, artifacts: string[]): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'launch-failure',
        serial: environment.serial,
    });
    try {
        await fixture.pair();
        const sessionId = fixture.allowedSessionId;
        if (!sessionId) throw new Error('Panels Session is unavailable');
        const state = await pageRequest<BootstrapState>(fixture.running.page, 'app.bootstrap');
        const session = state.sessions.find(({ id }) => id === sessionId)!;
        await tapMobileCheck(environment.serial, `session-row-${sessionId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'session-segment-panel-caxri.fixture'),
        );
        await tapMobileCheck(environment.serial, 'session-segment-panel-caxri.fixture');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                hasCheck(nodes, 'tree-panel-caxri.fixture.tree') && hasCheck(nodes, 'tree-row'),
        );
        const appPid = async () =>
            (await adbShell(environment.serial, ['pidof', 'com.caxri.mobile'])).trim();
        const pid = await appPid();
        const refreshes = 5;
        for (let refresh = 0; refresh < refreshes; refresh += 1) {
            // eslint-disable-next-line no-await-in-loop -- each refresh lands on the tree the previous one left.
            await pageRequest(fixture.running.page, 'viewContainers.executeCommand', {
                commandId: 'caxri.fixture.refresh',
                context: {
                    kind: 'session',
                    sessionId,
                    workbenchRootProjectId: session.workbenchRootProjectId,
                },
            });
            // eslint-disable-next-line no-await-in-loop -- the phone re-reads the tree after the refresh hint.
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            // eslint-disable-next-line no-await-in-loop -- survival is checked after every refresh.
            if ((await appPid()) !== pid)
                throw new Error(`The app process did not survive tree refresh ${refresh + 1}`);
        }
        // Before the fix the nested rows grew until Fabric ran out of memory a few seconds after the last refresh.
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        if ((await appPid()) !== pid)
            throw new Error('The app process did not survive the refreshed tree settling');
        await capture(environment, 'refreshed', artifacts);
        // Root rows: Lazy children, then Provider expanded, which the provider expands by default.
        await tapMobileCheckByBounds(environment.serial, 'tree-row', { rowOffset: 1 });
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        if ((await appPid()) !== pid)
            throw new Error('The app process did not survive collapsing the refreshed branch');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'tree-panel-caxri.fixture.tree'),
        );
        await capture(environment, 'collapsed', artifacts);
        await finish(environment, artifacts, {
            processSurvived: true,
            refreshes,
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-PANELS-TABS-SAVED-01`: the Project view tabs come from the list this phone saved, so a Session opened before the
 * live read answers shows them at once instead of pushing them into the strip later. With the network off after a cold
 * start no live read can answer at all, which makes the saved list the only possible source: before the fix the strip
 * kept only its fixed tabs here, and connected it showed them first and added the view tabs a moment later.
 */
async function openSessionWithSavedTabs(
    environment: Environment,
    artifacts: string[],
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'launch-failure',
        serial: environment.serial,
    });
    const viewTabs = ['session-segment-panel-caxri.files', 'session-segment-panel-caxri.fixture'];
    try {
        await fixture.pair();
        const sessionId = fixture.allowedSessionId;
        if (!sessionId) throw new Error('Panels Session is unavailable');
        await tapMobileCheck(environment.serial, `session-row-${sessionId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => viewTabs.every((id) => hasCheck(nodes, id)),
        );
        await capture(environment, 'connected', artifacts);
        // The read cache writes a second after the live read; leave it time before the process is killed.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await setMobileNetworkAvailable(environment.serial, false);
        await coldStartMobileApp(environment.serial);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, `session-row-${sessionId}`),
        );
        await tapMobileCheck(environment.serial, `session-row-${sessionId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'session-detail'),
        );
        const offline = await mobileSemantics(environment.serial);
        const missing = viewTabs.filter((id) => !hasCheck(offline, id));
        await capture(environment, 'offline-cold-start', artifacts);
        if (missing.length > 0)
            throw new Error(`Offline Session is missing saved view tabs: ${missing.join(', ')}`);
        await finish(environment, artifacts, {
            offlineViewTabs: viewTabs.length,
            status: 'passed',
        });
    } finally {
        await setMobileNetworkAvailable(environment.serial, true);
        await fixture.stop();
    }
}

/**
 * `MOB-PROJECT-CHIP-HOLD-01`: with more Projects than the strip can show, the strip is scrolled away from its start and
 * a chip in its middle is held still past the pick-up delay. The strip must stay where it is; only dragging the chip on
 * toward the right edge scrolls it.
 */
async function holdProjectChip(environment: Environment, artifacts: string[]): Promise<void> {
    const rootNames = Array.from({ length: 8 }, (_, index) => `strip-project-${index + 1}`);
    const fixture = await createMobileAcceptanceFixture({
        extraProjectRootNames: rootNames,
        isolatedProjectHome: true,
        mode: 'launch-failure',
        serial: environment.serial,
    });
    try {
        const extraIds: string[] = [];
        /* eslint-disable no-await-in-loop -- Each Project takes the folder picker's next queued root, in order. */
        for (const name of rootNames) {
            const rootPath = await pageRequest<string>(
                fixture.running.page,
                'dialog.selectDirectory',
            );
            // The picker may hand back the real path of the temporary directory, so compare the folder name.
            if (!rootPath.endsWith(`/${name}`))
                throw new Error('The folder picker skipped a Project root');
            const project = await pageRequest<{ id: string }>(
                fixture.running.page,
                'project.create',
                { rootPath },
            );
            extraIds.push(project.id);
        }
        /* eslint-enable no-await-in-loop */
        await fixture.pair(extraIds);
        const isProjectChip = (checkId: string) =>
            checkId.startsWith('project-filter-') && checkId !== 'project-filter-all';
        const start = await waitForMobile(
            () => mobileSemantics(environment.serial),
            (current) =>
                hasCheck(current, 'session-project-filters') &&
                current.filter(({ checkId }) => isProjectChip(checkId)).length >= 2,
        );
        const strip = androidBounds(
            start.find(({ checkId }) => checkId === 'session-project-filters')!.bounds,
        );
        if (!strip) throw new Error('The Project strip has no bounds');
        const y = Math.floor((strip.top + strip.bottom) / 2);
        const unscrolled = await mobileRegionFingerprint(environment.serial, strip);
        await capture(environment, 'before', artifacts);

        // Scroll the strip partway with a slow swipe, as a person looking for a later Project would.
        await adbShell(environment.serial, [
            'input',
            'swipe',
            String(strip.right - 80),
            String(y),
            String(Math.floor((strip.left + strip.right) / 2)),
            String(y),
            '600',
        ]);
        const scrolled = await waitForMobile(
            () => mobileSemantics(environment.serial),
            (current) => current.filter(({ checkId }) => isProjectChip(checkId)).length >= 2,
        );
        if ((await mobileRegionFingerprint(environment.serial, strip)) === unscrolled)
            throw new Error('The swipe did not scroll the Project strip');
        /**
         * A pick-up would also change the strip's pixels; only a scroll carries All to the left or off screen.
         */
        const allLeft = (nodes: typeof start) => {
            const node = nodes.find(({ checkId }) => checkId === 'project-filter-all');
            return (node && androidBounds(node.bounds)?.left) ?? -Infinity;
        };
        if (!(allLeft(scrolled) < allLeft(start)))
            throw new Error('The swipe picked up a chip instead of scrolling the strip');
        // UIAutomator lists only the chips on screen. Hold one wholly on screen with room for a region on its left; a
        // chip is wider than the gap between the two 48dp auto-scroll zones, so it may end inside the right one.
        const heldChip = scrolled
            .filter(({ checkId }) => isProjectChip(checkId))
            .map(({ bounds }) => androidBounds(bounds))
            .find(
                (bounds) =>
                    bounds !== null &&
                    bounds.left > strip.left + 160 &&
                    bounds.right < strip.right - 16,
            );
        if (!heldChip) throw new Error('No Project chip sits in the middle of the strip');
        const x = Math.floor((heldChip.left + heldChip.right) / 2);
        // Only scrolling changes the strip left of the held chip: holding it still or dragging it right never moves the
        // chips before it.
        const restOfStrip = {
            bottom: heldChip.bottom + 4,
            left: strip.left,
            right: heldChip.left - 16,
            top: heldChip.top - 4,
        };
        const resting = await mobileRegionFingerprint(environment.serial, restOfStrip);
        await capture(environment, 'scrolled', artifacts);

        await adbShell(environment.serial, [
            [`input motionevent DOWN ${x} ${y}`, 'sleep 1.5'].join('; '),
        ]);
        const held = await mobileRegionFingerprint(environment.serial, restOfStrip);
        await capture(environment, 'holding', artifacts);
        const isHeldStill = held === resting;

        const steps = 6;
        const toX = strip.right - 4;
        await adbShell(environment.serial, [
            [
                ...Array.from(
                    { length: steps },
                    (_, index) =>
                        `input motionevent MOVE ${Math.round(x + ((toX - x) * (index + 1)) / steps)} ${y}`,
                ),
                'sleep 1',
            ].join('; '),
        ]);
        const dragged = await mobileRegionFingerprint(environment.serial, restOfStrip);
        await capture(environment, 'dragged-to-edge', artifacts);
        await adbShell(environment.serial, ['input', 'motionevent', 'UP', String(toX), String(y)]);
        const isDraggedScrolls = dragged !== held;
        await finish(environment, artifacts, {
            draggedScrolls: isDraggedScrolls,
            heldStill: isHeldStill,
            status: isHeldStill && isDraggedScrolls ? 'passed' : 'failed',
        });
        if (!isHeldStill)
            throw new Error('The strip scrolled while the picked-up chip was held still');
        if (!isDraggedScrolls)
            throw new Error('Dragging the chip to the edge did not scroll the strip');
    } finally {
        await fixture.stop();
    }
}

export async function executeMobileProjectPanelsScenario(
    environment: Environment,
    artifacts: string[],
): Promise<void> {
    switch (environment.caseId) {
        case 'MOB-PROJECT-01': {
            await addNestedProject(environment, artifacts);
            break;
        }
        case 'MOB-PROJECT-CHIP-HOLD-01': {
            await holdProjectChip(environment, artifacts);
            break;
        }
        case 'MOB-PANELS-01': {
            await browsePanels(environment, artifacts);
            break;
        }
        case 'MOB-PANELS-TREE-REFRESH-01': {
            await refreshExpandedTree(environment, artifacts);
            break;
        }
        case 'MOB-PANELS-TABS-SAVED-01': {
            await openSessionWithSavedTabs(environment, artifacts);
            break;
        }
        default:
            throw new Error(`Unsupported mobile Project/Panels case: ${environment.caseId}`);
    }
}

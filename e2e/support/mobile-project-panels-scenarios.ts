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
    captureMobileFramebuffer,
    mobileRegionFingerprint,
    mobileSemantics,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

interface Environment {
    artifactManifestPath: string;
    assetsDirectory: string;
    caseId: string;
    scenarioReceiptPath: string;
    serial: string;
}

const hasCheck = (nodes: Awaited<ReturnType<typeof mobileSemantics>>, id: string): boolean =>
    nodes.some(({ checkId }) => checkId === id);

async function capture(
    environment: Environment,
    label: string,
    artifacts: string[],
): Promise<void> {
    const name = `${environment.caseId}-${label}-android.png`;
    await captureMobileFramebuffer(environment.serial, join(environment.assetsDirectory, name));
    artifacts.push(`assets/${name}`);
}

async function finish(
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
async function addProjectFromPhone(
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

const chipBounds = (nodes: Awaited<ReturnType<typeof mobileSemantics>>, projectId: string) => {
    const node = nodes.find(({ checkId }) => checkId === `project-filter-${projectId}`);
    return (node && androidBounds(node.bounds)) ?? undefined;
};

/**
 * `MOB-PROJECT-REORDER-01`: the phone holds two of the Mac's three Projects. Dragging the second Project chip in front
 * of the first moves it on the phone and in the Mac's Project order, while the Project the phone cannot see keeps its
 * place relative to the others; a plain tap on a chip still filters.
 */
async function reorderProjectFilters(environment: Environment, artifacts: string[]): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        isolatedProjectHome: true,
        mode: 'launch-failure',
        serial: environment.serial,
    });
    const desktopOrder = async () =>
        (await pageRequest<BootstrapState>(fixture.running.page, 'app.bootstrap')).projects
            .filter(({ ownerProjectId }) => ownerProjectId === undefined)
            .map(({ id }) => id);
    try {
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('The allowed Project has no Session');
        const addedId = await addProjectFromPhone(environment, fixture);
        await adbShell(environment.serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        const allowedId = fixture.allowedProjectId;
        const hiddenId = fixture.deniedProjectId;
        const before = await desktopOrder();
        if (before.join(',') !== [allowedId, hiddenId, addedId].join(','))
            throw new Error(`Unexpected starting Project order: ${before.join(',')}`);
        const nodes = await waitForMobile(
            () => mobileSemantics(environment.serial),
            (current) =>
                chipBounds(current, allowedId) !== undefined &&
                chipBounds(current, addedId) !== undefined,
        );
        const allowed = chipBounds(nodes, allowedId)!;
        const added = chipBounds(nodes, addedId)!;
        if (!(allowed.left < added.left)) throw new Error('Chips did not start in Mac order');
        await capture(environment, 'before', artifacts);

        // UIAutomator waits for an idle screen, so the moving strip is compared by its pixels instead.
        const strip = {
            bottom: added.bottom + 8,
            left: allowed.left - 8,
            right: added.right + 8,
            top: added.top - 8,
        };
        const resting = await mobileRegionFingerprint(environment.serial, strip);
        // `draganddrop` holds the first point for the long-press timeout before moving, as a finger picking up a chip.
        // The frame captured mid-move shows the held chip lifted and its neighbor stepping aside.
        const y = String(Math.floor((added.top + added.bottom) / 2));
        const drag = adbShell(environment.serial, [
            'input',
            'draganddrop',
            String(Math.floor((added.left + added.right) / 2)),
            y,
            String(allowed.left + 4),
            y,
            '3000',
        ]);
        await new Promise((resolve) => setTimeout(resolve, 1800));
        const moving = await mobileRegionFingerprint(environment.serial, strip);
        await capture(environment, 'dragging', artifacts);
        await drag;
        if (moving === resting) throw new Error('The held chip did not move while dragged');
        const after = await waitForMobile(desktopOrder, (order) => order[0] === addedId);
        if (after.join(',') !== [addedId, allowedId, hiddenId].join(','))
            throw new Error(`Unexpected Project order after the drag: ${after.join(',')}`);
        const moved = await waitForMobile(
            () => mobileSemantics(environment.serial),
            (current) => {
                const first = chipBounds(current, addedId);
                const second = chipBounds(current, allowedId);
                return first !== undefined && second !== undefined && first.left < second.left;
            },
        );
        if (moved.some(({ checkId }) => checkId === `project-filter-${hiddenId}`))
            throw new Error('The phone showed a Project outside its grant');
        await capture(environment, 'after', artifacts);

        // A plain tap still filters: the moved Project has no Sessions, so the other Project's Session leaves the list.
        await tapMobileCheck(environment.serial, `project-filter-${addedId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (current) =>
                current.some(
                    ({ checkId, selected }) => checkId === `project-filter-${addedId}` && selected,
                ) && !hasCheck(current, `session-row-${fixture.allowedSessionId}`),
        );
        await capture(environment, 'tap-filters', artifacts);
        await finish(environment, artifacts, {
            desktopOrderAfter: 'moved-first-hidden-kept-after',
            phoneOrderAfter: 'moved-first',
            tapStillFilters: true,
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

export async function executeMobileProjectPanelsScenario(
    environment: Environment,
    artifacts: string[],
): Promise<void> {
    switch (environment.caseId) {
        case 'MOB-PROJECT-01': {
            await addNestedProject(environment, artifacts);
            break;
        }
        case 'MOB-PROJECT-REORDER-01': {
            await reorderProjectFilters(environment, artifacts);
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
        default:
            throw new Error(`Unsupported mobile Project/Panels case: ${environment.caseId}`);
    }
}

import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';

import { writeJsonAtomic } from '../../scripts/atomic-json';
import { allowE2EErrors } from './fixtures';
import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import {
    captureMobileFramebuffer,
    mobileSemantics,
    tapMobileCheck,
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

async function addNestedProject(environment: Environment, artifacts: string[]): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        isolatedProjectHome: true,
        mode: 'launch-failure',
        serial: environment.serial,
    });
    try {
        await fixture.pair();
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
        await capture(environment, 'browse-home', artifacts);
        await tapMobileCheck(environment.serial, 'add-project-folder-mobile-new-project');
        const nestedId = 'add-project-add-mobile-new-project/nested';
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, nestedId),
        );
        await capture(environment, 'browse-nested', artifacts);
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
        if (!fixture.allowedSessionId) throw new Error('Panels Session is unavailable');
        await pageRequest(fixture.running.page, 'session.select', {
            sessionId: fixture.allowedSessionId,
        });
        await waitForMobile(
            () => pageRequest<BootstrapState>(fixture.running.page, 'app.bootstrap'),
            (state) => state.selectedSessionId === fixture.allowedSessionId,
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
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                hasCheck(nodes, 'tree-panel-caxri.project-status.overview') &&
                (hasCheck(nodes, 'tree-row') || hasCheck(nodes, 'tree-panel-empty')),
        );
        await capture(environment, 'status', artifacts);
        await tapMobileCheck(environment.serial, 'session-segment-panel-caxri.fixture');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                hasCheck(nodes, 'tree-panel-caxri.fixture.tree') && hasCheck(nodes, 'tree-row'),
        );
        await capture(environment, 'extension-tree', artifacts);
        await tapMobileCheck(environment.serial, 'session-segment-changes');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'changes-empty'),
        );
        await capture(environment, 'git-changes', artifacts);
        await finish(environment, artifacts, {
            panels: ['Files', 'Status', 'Fixture tree'],
            filesStates: ['empty', 'error'],
            git: 'Changes segment',
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
    if (environment.caseId === 'MOB-PROJECT-01') await addNestedProject(environment, artifacts);
    else if (environment.caseId === 'MOB-PANELS-01') await browsePanels(environment, artifacts);
    else throw new Error(`Unsupported mobile Project/Panels case: ${environment.caseId}`);
}

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';

import { writeJsonAtomic } from '../../scripts/atomic-json';
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
        const rootPath = join(fixture.testDirectory, 'mobile-new-project', 'nested');
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
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('Panels Session is unavailable');
        await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'session-segment-panels'),
        );
        await tapMobileCheck(environment.serial, 'session-segment-panels');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'files-panel'),
        );
        await capture(environment, 'files-empty', artifacts);
        await tapMobileCheck(environment.serial, 'panel-tab-caxri.project-status');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'tree-panel-caxri.project-status.overview'),
        );
        await capture(environment, 'status', artifacts);
        await tapMobileCheck(environment.serial, 'panel-tab-caxri.fixture');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'tree-panel-caxri.fixture.tree'),
        );
        await capture(environment, 'extension-tree', artifacts);
        await tapMobileCheck(environment.serial, 'session-segment-changes');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'changes-summary'),
        );
        await capture(environment, 'git-changes', artifacts);
        await finish(environment, artifacts, {
            panels: ['Files', 'Status', 'Fixture tree'],
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

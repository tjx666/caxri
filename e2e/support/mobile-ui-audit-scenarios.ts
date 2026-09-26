import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomic } from '../../scripts/atomic-json';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import {
    captureMobileFramebuffer,
    mobileSemantics,
    setMobileNetworkAvailable,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';

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
async function assertStaysAbsent(serial: string, ids: readonly string[]): Promise<void> {
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
    await tapMobileCheck(environment.serial, 'session-segment-panels');
    const nodes = await waitFor(
        environment.serial,
        (current) => hasCheck(current, 'panels-view') && hasCheck(current, 'panel-tab-caxri.files'),
    );
    if (hasCheck(nodes, 'panel-tab-caxri.git'))
        throw new Error('The Project tab still lists the Git view the Changes tab owns');
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
        offlineTerminalStaleChip: 'absent-while-banner-shown',
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
        changes: 'standard',
        mode: 'conversation',
        serial: environment.serial,
    });
    try {
        await fixture.pair();
        const sessionId = fixture.allowedSessionId;
        if (!sessionId) throw new Error('Synthetic UI audit Session is unavailable');
        await openSession(environment.serial, sessionId);
        switch (environment.caseId) {
            case 'MOB-UI-01':
                await projectTab(environment, artifacts);
                break;
            case 'MOB-UI-02':
                await changesPolish(environment, artifacts);
                break;
            case 'MOB-UI-03':
                await offlineStates(environment, artifacts);
                break;
            default:
                throw new Error(`Unsupported UI audit Acceptance case: ${environment.caseId}`);
        }
    } finally {
        await fixture.stop();
    }
}

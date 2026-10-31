import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomic } from '../../scripts/atomic-json';
import { captureMobileFramebuffer, mobileSemantics, waitForMobile } from './mobile-android';

export interface UiAuditScenarioEnvironment {
    artifactManifestPath: string;
    assetsDirectory: string;
    caseId: string;
    scenarioReceiptPath: string;
    serial: string;
}

export type SemanticNodes = Awaited<ReturnType<typeof mobileSemantics>>;

export const hasCheck = (nodes: SemanticNodes, id: string): boolean =>
    nodes.some(({ checkId }) => checkId === id);

export const waitFor = (serial: string, isReady: (nodes: SemanticNodes) => boolean) =>
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
export async function capture(
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

export async function finish(
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

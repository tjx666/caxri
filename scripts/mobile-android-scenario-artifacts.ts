import type { Buffer } from 'node:buffer';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { MobileAcceptanceArtifact } from './mobile-acceptance-runtime';
import {
    createMobileAcceptanceArtifact,
    writeMobileAcceptanceArtifact,
} from './mobile-acceptance-runtime';
import type { MobileAndroidAcceptanceCaseId } from './mobile-android-cases';
import { shouldCaptureAdapterScreenshot } from './mobile-android-cases';

/**
 * Names the path where a scenario's Desktop fixture writes the case's final frame before its teardown
 * (`captureFinalFrame` in `e2e/support/mobile-scenario-capture.ts`).
 */
export const ANDROID_FINAL_FRAME_ENVIRONMENT = 'CAXRI_MOBILE_ACCEPTANCE_FINAL_FRAME';

const androidFinalFramePath = (reportDirectory: string, caseId: string): string =>
    join(reportDirectory, 'assets', `${caseId}-android.png`);

/**
 * The scenario environment that asks its fixture for the final frame. Only a case whose final frame the runner captures
 * anyway gets it, so a Terminal case's screen stays out of evidence exactly as before.
 */
export const androidFinalFrameEnvironment = (
    reportDirectory: string,
    caseId: MobileAndroidAcceptanceCaseId,
): Record<string, string> =>
    shouldCaptureAdapterScreenshot(caseId, true)
        ? { [ANDROID_FINAL_FRAME_ENVIRONMENT]: androidFinalFramePath(reportDirectory, caseId) }
        : {};

/**
 * Binds the case's final frame `assets/<case>-android.png`. The scenario's fixture took it while Desktop still served
 * the phone; captured here, after the scenario returned and its fixture had torn Desktop down, it would show only the
 * phone's disconnected composer instead of the screen a failing step left behind. `captureNow` covers a scenario that
 * never started a fixture or whose capture failed.
 */
export async function bindAndroidFinalFrame(
    reportDirectory: string,
    caseId: MobileAndroidAcceptanceCaseId,
    captureNow: () => Buffer,
): Promise<MobileAcceptanceArtifact> {
    const path = androidFinalFramePath(reportDirectory, caseId);
    let hasFixtureFrame = false;
    try {
        hasFixtureFrame = (await stat(path)).isFile();
    } catch {
        // No fixture frame: capture it below.
    }
    if (!hasFixtureFrame) await writeMobileAcceptanceArtifact(path, captureNow());
    return createMobileAcceptanceArtifact(path, {
        path: `assets/${caseId}-android.png`,
        source: 'android-framebuffer',
        type: 'screenshot',
    });
}

/**
 * Reads the PNG list a Playwright scenario recorded for one case. A missing manifest means the scenario captured
 * nothing; a manifest naming another case's or a non-PNG artifact is rejected.
 */
async function readAndroidScenarioArtifacts(
    reportDirectory: string,
    caseId: MobileAndroidAcceptanceCaseId,
): Promise<string[]> {
    const path = join(reportDirectory, 'assets', `${caseId}-artifact-manifest.json`);
    try {
        const manifest = JSON.parse(await readFile(path, 'utf8')) as {
            artifacts: string[];
            schemaVersion: number;
        };
        if (
            manifest.schemaVersion !== 1 ||
            !Array.isArray(manifest.artifacts) ||
            manifest.artifacts.some(
                (artifact) =>
                    !artifact.startsWith(`assets/${caseId}-`) || !artifact.endsWith('.png'),
            )
        ) {
            throw new Error('Android scenario artifact manifest is invalid');
        }
        return manifest.artifacts;
    } catch (error: unknown) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
        ) {
            return [];
        }
        throw error;
    }
}

/**
 * Hashes every screenshot the scenario's manifest names into device-bound artifacts, in manifest order. The runner
 * calls this whether or not the scenario threw: a baseline round fails on purpose after capturing the old UI, and those
 * captures must stay citable in its `failed` device receipt.
 */
export async function bindAndroidScenarioArtifacts(
    reportDirectory: string,
    caseId: MobileAndroidAcceptanceCaseId,
): Promise<MobileAcceptanceArtifact[]> {
    const artifacts: MobileAcceptanceArtifact[] = [];
    const artifactPaths = await readAndroidScenarioArtifacts(reportDirectory, caseId);
    for (const artifactPath of artifactPaths) {
        // Sequential hashing preserves frozen artifact order and bounds device evidence memory.
        // eslint-disable-next-line no-await-in-loop
        const artifact = await createMobileAcceptanceArtifact(join(reportDirectory, artifactPath), {
            path: artifactPath,
            source: 'android-framebuffer',
            type: 'screenshot',
        });
        artifacts.push(artifact);
    }
    return artifacts;
}

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { writeJsonAtomic } from '../../scripts/atomic-json';
import { ANDROID_FINAL_FRAME_ENVIRONMENT } from '../../scripts/mobile-android-scenario-artifacts';
import { captureMobileFramebuffer } from './mobile-android';

/**
 * Takes the Android Acceptance runner's final frame while Desktop still serves the phone; the Desktop fixture calls it
 * first thing in `stop()`, which every scenario runs in its `finally`. The runner names the path only for a case whose
 * final frame it may capture (`bindAndroidFinalFrame`). A failed capture leaves no file, so the runner captures its
 * own, and the scenario's original failure stays the one reported.
 */
export async function captureFinalFrame(serial: string): Promise<void> {
    const path = process.env[ANDROID_FINAL_FRAME_ENVIRONMENT];
    if (!path) return;
    try {
        await captureMobileFramebuffer(serial, path);
    } catch {
        await rm(path, { force: true });
    }
}

/**
 * The part of an Android scenario environment a framebuffer capture writes to.
 */
export interface MobileScenarioCaptureTarget {
    artifactManifestPath: string;
    assetsDirectory: string;
    caseId: string;
    serial: string;
}

/**
 * Saves one framebuffer screenshot as `<caseId>-<label>-android.png`, appends it to `artifacts`, and rewrites the
 * artifact manifest right away. The runner binds the manifest into the device receipt whether or not the scenario
 * threw, so a baseline round that fails on the old behavior after this capture still cites the frame showing it.
 */
export async function captureScenarioFrame(
    target: MobileScenarioCaptureTarget,
    label: string,
    artifacts: string[],
): Promise<void> {
    const name = `${target.caseId}-${label}-android.png`;
    await captureMobileFramebuffer(target.serial, join(target.assetsDirectory, name));
    artifacts.push(`assets/${name}`);
    await writeJsonAtomic(target.artifactManifestPath, { artifacts, schemaVersion: 1 });
}

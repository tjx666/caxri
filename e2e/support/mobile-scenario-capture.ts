import { join } from 'node:path';

import { writeJsonAtomic } from '../../scripts/atomic-json';
import { captureMobileFramebuffer } from './mobile-android';

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

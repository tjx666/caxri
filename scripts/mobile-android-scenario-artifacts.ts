import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { MobileAcceptanceArtifact } from './mobile-acceptance-runtime';
import { createMobileAcceptanceArtifact } from './mobile-acceptance-runtime';
import type { MobileAndroidAcceptanceCaseId } from './mobile-android-cases';

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

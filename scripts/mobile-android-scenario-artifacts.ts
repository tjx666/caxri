import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { MobileAndroidAcceptanceCaseId } from './mobile-android-cases';

/**
 * Reads the PNG list a Playwright scenario recorded for one case. A missing manifest means the scenario captured
 * nothing; a manifest naming another case's or a non-PNG artifact is rejected.
 */
export async function readAndroidScenarioArtifacts(
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

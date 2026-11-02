import process from 'node:process';

import { test } from './support/fixtures.ts';
import { executeMobileAndroidCase } from './support/mobile-android-case-registry.ts';

/**
 * Scenario-owned framebuffer evidence is the only capture path covered by the privacy finalizer.
 */
test.use({ screenshot: 'off', trace: 'off' });

const serial = process.env.CAXRI_MOBILE_ACCEPTANCE_SERIAL;
const caseId = process.env.CAXRI_MOBILE_ACCEPTANCE_CASE_ID;
const assetsDirectory = process.env.CAXRI_MOBILE_ACCEPTANCE_ASSETS_DIR;
const artifactManifestPath = process.env.CAXRI_MOBILE_ACCEPTANCE_ARTIFACT_MANIFEST;
const scenarioReceiptPath = process.env.CAXRI_MOBILE_ACCEPTANCE_SCENARIO_RECEIPT;

/**
 * Every case registers its own handler under `support/mobile-android-case-handlers/<group>.ts`; the registry rejects an
 * id no group module handles.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument.
test('executes one report-bound Android product scenario', async ({}) => {
    test.skip(!caseId, 'Run through the guarded Android Acceptance adapter');
    /**
     * Reserve bounded queue time without shortening the product scenario's deadline.
     */
    test.setTimeout(300_000);
    if (!serial || !caseId || !assetsDirectory || !artifactManifestPath || !scenarioReceiptPath) {
        throw new Error('Mobile Acceptance scenario identity is incomplete');
    }
    await executeMobileAndroidCase(
        {
            artifactManifestPath,
            assetsDirectory,
            caseId,
            launchId: process.env.CAXRI_MOBILE_ACCEPTANCE_LAUNCH_ID,
            remoteVideoPath: process.env.CAXRI_MOBILE_ACCEPTANCE_REMOTE_VIDEO_PATH,
            scenarioReceiptPath,
            serial,
            sourceCommit: process.env.CAXRI_MOBILE_ACCEPTANCE_SOURCE_COMMIT,
        },
        [],
    );
});

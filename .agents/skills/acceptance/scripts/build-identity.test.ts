import { describe, expect, it } from 'vitest';

import { assertAcceptanceBuildCommit } from './build-identity';

const bundle = (commit: string) =>
    `process.env.CAXRI_GIT_COMMIT = ${JSON.stringify(commit)};\nconsole.log('ready');\n`;

describe('Acceptance build identity', () => {
    it('accepts the short commit stamped into a build for the frozen report head', () => {
        expect(() =>
            assertAcceptanceBuildCommit({
                builtMainSource: bundle('75ed0f4'),
                reportCommit: '75ed0f4baf7c1c48d374011f61e033aeaf5c4e2e',
            }),
        ).not.toThrow();
    });

    it('rejects a stale build whose stamped commit differs from the report head', () => {
        expect(() =>
            assertAcceptanceBuildCommit({
                builtMainSource: bundle('63a7ccc'),
                reportCommit: '75ed0f4baf7c1c48d374011f61e033aeaf5c4e2e',
            }),
        ).toThrow('Build commit 63a7ccc does not match Acceptance report commit 75ed0f4');
    });

    it.each(['unknown', 'not-a-commit'])('rejects an unusable build stamp: %s', (commit) => {
        expect(() =>
            assertAcceptanceBuildCommit({
                builtMainSource: bundle(commit),
                reportCommit: '75ed0f4baf7c1c48d374011f61e033aeaf5c4e2e',
            }),
        ).toThrow('Could not read a usable commit from the Acceptance build');
    });
});

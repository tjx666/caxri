import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const workflow = await readFile(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
);

describe('Release workflow contract', () => {
    it('routes trusted exact-head packaging to the dedicated self-hosted capability', () => {
        expect(workflow).toContain('runs-on: [self-hosted, macOS, ARM64, caxri-release]');
        expect(workflow).not.toContain('runs-on: macos-15');
        expect(workflow).toContain('uses: ./.github/actions/verify-trust-boundary');
        expect(workflow).toContain(
            "startsWith(github.event.workflow_run.display_title, 'release: v')",
        );
        expect(workflow).toContain('ref: ${{ github.event.workflow_run.head_sha }}');
    });

    it('keeps publication credentials bounded and cleans the local runner', () => {
        expect(workflow).toContain('contents: write');
        expect(workflow).toContain('persist-credentials: false');
        expect(workflow).toContain('CAXRI_E2E_AGENT_MODE: blocked');
        expect(workflow).toContain('CAXRI_RUNNER_AGENT_DISCOVERY: blocked');
        expect(workflow).toContain('uses: ./.github/actions/setup-caxri-job');
        expect(workflow).toContain("setup-toolchain: 'true'");
        expect(workflow).toContain("install-dependencies: 'true'");
        expect(workflow).toContain("install-electron: 'true'");
        expect(workflow).toContain("rebuild-native: 'true'");
        expect(workflow).not.toContain('npm ci');
        expect(workflow.indexOf('name: Validate release commit')).toBeLessThan(
            workflow.indexOf('uses: ./.github/actions/setup-caxri-job'),
        );
        expect(workflow).not.toContain("require('./package.json').version");
        expect(workflow).toContain('bun run scripts/self-hosted-runner.ts cleanup');
        expect(workflow).toContain('name: Clean self-hosted runner boundary\n        if: always()');
        expect(workflow).toContain('GH_TOKEN: ${{ github.token }}');
        expect(workflow).toContain('gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${tag}"');
        expect(workflow).not.toContain('git ls-remote');
    });
});

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const workflow = await readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
);

describe('Release workflow contract', () => {
    it('routes trusted exact-head packaging to the dedicated self-hosted capability', () => {
        expect(workflow).toContain('runs-on: [self-hosted, macOS, ARM64, caxri-release]');
        expect(workflow).not.toContain('runs-on: macos-15');
        expect(workflow).toContain(
            'github.event.workflow_run.head_repository.full_name == github.repository',
        );
        expect(workflow).toContain("github.event.workflow_run.actor.login == 'tjx666'");
        expect(workflow).toContain("github.event.workflow_run.triggering_actor.login == 'tjx666'");
        expect(workflow).toContain(
            "startsWith(github.event.workflow_run.display_title, 'release: v')",
        );
        expect(workflow).toContain('ref: ${{ github.event.workflow_run.head_sha }}');
    });

    it('keeps publication credentials bounded and cleans the local runner', () => {
        expect(workflow).toContain('contents: write');
        expect(workflow).toContain('persist-credentials: false');
        expect(workflow).toContain('CAXRI_E2E_AGENT_MODE: blocked');
        expect(workflow).toContain('bun run scripts/self-hosted-e2e-runner.ts prepare');
        expect(workflow).toContain('bun run scripts/self-hosted-e2e-runner.ts cleanup');
        expect(workflow).toContain("if: always() && steps.checkout.outcome == 'success'");
        expect(workflow).toContain('GH_TOKEN: ${{ github.token }}');
        expect(workflow).toContain('gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${tag}"');
        expect(workflow).not.toContain('git ls-remote');
    });
});

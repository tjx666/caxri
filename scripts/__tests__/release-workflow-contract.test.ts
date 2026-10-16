import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = await readFile(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
);
const releaseSkill = await readFile(
    new URL('../../.agents/skills/release/SKILL.md', import.meta.url),
    'utf8',
);
const releaseGuide = await readFile(new URL('../../RELEASING.md', import.meta.url), 'utf8');
const ciPerformanceGuide = await readFile(
    new URL('../../docs/ci-performance.md', import.meta.url),
    'utf8',
);
const releaseJobSource = workflow.match(/\n {2}release:\n([\s\S]*)$/u)?.[1] ?? '';

interface WorkflowStep {
    name?: string;
    run?: string;
}

function stepScript(name: string): string {
    const parsed: unknown = parse(workflow);
    const steps: unknown = Reflect.get(
        Reflect.get(Reflect.get(parsed as object, 'jobs'), 'release'),
        'steps',
    );
    const step = (steps as WorkflowStep[]).find((entry) => entry.name === name);
    if (!step?.run) throw new Error(`Workflow step '${name}' has no run block`);
    return step.run;
}

describe('Release workflow contract', () => {
    it('keeps full E2E as an explicit receipt outside ordinary PR CI', () => {
        expect(releaseSkill).toContain('Ordinary PR and main-push CI');
        expect(releaseSkill).toContain('hosted-full');
        expect(releaseGuide).toMatch(/not a full E2E\s+receipt/u);
        expect(releaseGuide).toContain('hosted-full');
        expect(ciPerformanceGuide).toContain('hosted-full');
        expect(releaseSkill).not.toContain('self-hosted-final');
        expect(releaseGuide).not.toContain('self-hosted-final');
        expect(ciPerformanceGuide).not.toContain('self-hosted-final');
        expect(releaseSkill).not.toContain('the full E2E suite stay in PR CI');
    });

    it('routes trusted exact-head packaging to a GitHub-hosted Apple Silicon runner', () => {
        expect(workflow).toContain('runs-on: macos-15');
        expect(releaseJobSource).toContain('runs-on: macos-15');
        expect(releaseJobSource).toContain('test "$RUNNER_ENVIRONMENT" = github-hosted');
        expect(workflow).not.toContain('self-hosted');
        expect(workflow).toContain('uses: ./.github/actions/verify-trust-boundary');
        expect(workflow).toContain(
            "startsWith(github.event.workflow_run.display_title, 'release: v')",
        );
        expect(workflow).toContain('ref: ${{ github.event.workflow_run.head_sha }}');
    });

    it('publishes the two exact isolated DMGs and their checksum companions', () => {
        // Exact paths prevent a stale or third-party DMG from becoming a release asset.
        expect(workflow).not.toContain('find release.noindex');
        expect(releaseJobSource.indexOf('name: Clean previous packaging output')).toBeLessThan(
            releaseJobSource.indexOf('name: Package unsigned Apple Silicon DMGs'),
        );
        expect(stepScript('Clean previous packaging output')).toBe('rm -rf release.noindex');
        const packaging = stepScript('Package unsigned Apple Silicon DMGs');
        expect(packaging).toContain('bun run package:release-dmgs');
        expect(packaging).toContain('for flavor in sourcemap nosourcemap');
        const verification = stepScript('Verify release artifact');
        expect(verification).toContain('release.noindex/sourcemap/Caxri-${version}-arm64.dmg');
        expect(verification).toContain(
            'release.noindex/nosourcemap/Caxri-${version}-arm64-nosourcemap.dmg',
        );
        expect(verification).toContain('shasum -a 256 -c');
        expect(workflow).toContain('RELEASE_SOURCEMAP_DMG:');
        expect(workflow).toContain('RELEASE_SOURCEMAP_CHECKSUM:');
        expect(workflow).toContain('RELEASE_NOSOURCEMAP_DMG:');
        expect(workflow).toContain('RELEASE_NOSOURCEMAP_CHECKSUM:');
    });

    it('stages the release-signed Android bundle before packaging and proves it shipped', () => {
        const bundle = stepScript('Build Android update bundle');
        expect(releaseJobSource.indexOf('name: Build Android update bundle')).toBeLessThan(
            releaseJobSource.indexOf('name: Package unsigned Apple Silicon DMGs'),
        );
        expect(bundle).toContain('trap \'rm -f "$keystore"\' EXIT');
        expect(bundle).toContain('bun run --cwd apps/mobile build:update-bundle');
        expect(stepScript('Package unsigned Apple Silicon DMGs')).toContain(
            'cmp out/mobile-update/caxri-mobile.apk',
        );
    });

    it('builds SSH Host natives on hosted Linux runners and packages them without Docker', () => {
        const parsed = parse(workflow) as {
            jobs: Partial<
                Record<
                    string,
                    {
                        'if'?: string;
                        'needs'?: string;
                        'permissions'?: Record<string, string>;
                        'runs-on'?: string;
                        'steps'?: Array<{ env?: Record<string, string>; name?: string }>;
                        'strategy'?: { matrix?: { include?: Array<Record<string, string>> } };
                    }
                >
            >;
        };
        const natives = parsed.jobs['linux-natives'];
        expect(natives?.permissions).toEqual({ contents: 'read' });
        expect(natives?.strategy?.matrix?.include).toEqual([
            { target: 'linux-x64', runner: 'ubuntu-24.04' },
            { target: 'linux-arm64', runner: 'ubuntu-24.04-arm' },
        ]);
        expect(JSON.stringify(natives)).not.toContain('secrets.');
        // A manual run rehearses hosted packaging on main; publication stays release-only.
        expect(natives?.if).toContain("github.event_name == 'workflow_dispatch'");
        expect(parsed.jobs.release?.if).not.toContain('workflow_dispatch');
        expect(parsed.jobs.release?.if).toContain(
            "startsWith(github.event.workflow_run.display_title, 'release: v')",
        );
        expect(parsed.jobs.release?.needs).toBe('linux-natives');
        const packaging = parsed.jobs.release?.steps?.find(
            (step) => step.name === 'Package unsigned Apple Silicon DMGs',
        );
        expect(packaging?.env?.CAXRI_LINUX_NATIVES_DIR).toBe(
            '${{ runner.temp }}/caxri-linux-natives',
        );
        expect(releaseJobSource.indexOf('name: Download Linux natives')).toBeLessThan(
            releaseJobSource.indexOf('name: Package unsigned Apple Silicon DMGs'),
        );
        expect(stepScript('Package unsigned Apple Silicon DMGs')).toContain(
            'cmp "apps/server/dist/remote/${target}/app.tar.gz"',
        );
    });

    it('rehearses the complete unsigned package on hosted macOS without publication credentials', () => {
        const parsed = parse(workflow) as {
            jobs: Record<
                string,
                {
                    'if'?: string;
                    'needs'?: string;
                    'permissions'?: Record<string, string>;
                    'runs-on'?: string;
                    'steps'?: Array<{ name?: string; run?: string; with?: Record<string, string> }>;
                }
            >;
        };
        const rehearsal = parsed.jobs.rehearsal;
        /**
         * Sibling publishing jobs have separate authority, so inspect only the parsed rehearsal job.
         */
        const source = JSON.stringify(rehearsal);

        expect(rehearsal.if).toContain("github.event_name == 'workflow_dispatch'");
        expect(rehearsal.needs).toBe('linux-natives');
        expect(rehearsal['runs-on']).toBe('macos-15');
        expect(rehearsal.permissions).toEqual({ contents: 'read' });
        expect(source).not.toContain('secrets.');
        expect(
            rehearsal.steps?.some((step) => step.with?.['install-android-toolchain'] === 'true'),
        ).toBe(true);
        expect(source).toContain('bun run --cwd apps/mobile build:update-bundle');
        expect(rehearsal.steps?.some((step) => step.run === 'bun run package:release-dmgs')).toBe(
            true,
        );
        expect(source).toContain('release.noindex/sourcemap/mac-arm64/Caxri.app');
        expect(source).toContain('e2e/startup.performance.e2e.ts e2e/agent-login-path.e2e.ts');
        expect(source).not.toContain('gh release create');
    });

    it('keeps publication credentials bounded on the hosted runner', () => {
        expect(workflow).toContain('contents: write');
        expect(workflow).toContain('persist-credentials: false');
        expect(workflow).toContain('CAXRI_E2E_AGENT_MODE: blocked');
        expect(workflow).toContain('CAXRI_RUNNER_AGENT_DISCOVERY: blocked');
        expect(workflow).toContain('uses: ./.github/actions/setup-caxri-job');
        expect(workflow).toContain("setup-toolchain: 'true'");
        expect(workflow).toContain("install-dependencies: 'true'");
        expect(workflow).toContain("install-electron: 'true'");
        expect(releaseJobSource).toContain("install-android-toolchain: 'true'");
        expect(workflow).not.toContain('rebuild-native:');
        expect(workflow).not.toContain('npm ci');
        expect(releaseJobSource.indexOf('name: Validate release commit')).toBeLessThan(
            releaseJobSource.indexOf('uses: ./.github/actions/setup-caxri-job'),
        );
        expect(workflow).not.toContain("require('./package.json').version");
        expect(workflow).not.toContain('scripts/self-hosted-runner.ts');
        expect(workflow).toContain('GH_TOKEN: ${{ github.token }}');
        expect(workflow).toContain('gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${tag}"');
        expect(workflow).not.toContain('git ls-remote');
    });
});

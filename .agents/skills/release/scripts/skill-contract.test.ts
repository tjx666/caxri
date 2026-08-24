import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const releaseSkillDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDirectory = join(releaseSkillDirectory, '..');
const repoRoot = join(skillsDirectory, '..', '..');
const releaseSkill = readFileSync(join(releaseSkillDirectory, 'SKILL.md'), 'utf8');
const e2eSkill = readFileSync(join(skillsDirectory, 'e2e-testing', 'SKILL.md'), 'utf8');
const runnerGuide = readFileSync(join(repoRoot, 'docs', 'self-hosted-runner.md'), 'utf8');
const releaseGuide = readFileSync(join(repoRoot, 'RELEASING.md'), 'utf8');

describe('infrastructure authority routing', () => {
    it('keeps release and E2E skills subordinate to the authoritative operational contracts', () => {
        expect(releaseSkill).toContain('docs/ci-performance.md');
        expect(releaseSkill).toContain('docs/self-hosted-runner.md');
        expect(releaseSkill).not.toContain(
            'A normal commit must run the self-hosted macOS CI checks without E2E',
        );
        expect(releaseGuide).toContain('docs/ci-performance.md');
        expect(releaseGuide).not.toContain('A normal commit runs the\nself-hosted CI checks only.');
        expect(e2eSkill).not.toContain('three consecutive green samples');
    });

    it('keeps a replacement runner non-routable until its controlled admission succeeds', () => {
        const replacementGuide = runnerGuide.slice(
            runnerGuide.indexOf('### Permanent loss and replacement'),
            runnerGuide.indexOf('To remove a healthy runner intentionally'),
        );
        const temporaryLabel = replacementGuide.indexOf('temporary\n   non-routing label');
        const admissionWindow = replacementGuide.indexOf('controlled admission window');
        const cancelQueued = replacementGuide.indexOf('cancel every\n   queued CI and Release run');
        const standardLabels = replacementGuide.indexOf('standard labels');
        const validationMatrix = replacementGuide.indexOf('complete frozen-head validation matrix');
        const restoreTraffic = replacementGuide.indexOf('restore normal repository traffic');

        expect(temporaryLabel).toBeGreaterThanOrEqual(0);
        expect(temporaryLabel).toBeLessThan(admissionWindow);
        expect(admissionWindow).toBeLessThan(cancelQueued);
        expect(cancelQueued).toBeLessThan(standardLabels);
        expect(standardLabels).toBeLessThan(validationMatrix);
        expect(validationMatrix).toBeLessThan(restoreTraffic);
        expect(replacementGuide).toContain(
            'A failed matrix returns the runner to its stopped, non-routing state.',
        );
        expect(runnerGuide).toContain(
            'each job adds the route, timing, cache, manifest, and test\n   count fields that apply to its role',
        );
        expect(runnerGuide).not.toContain(
            'Every source job still runs a fresh frozen-lockfile install',
        );
    });
});

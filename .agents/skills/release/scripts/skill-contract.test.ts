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

describe('infrastructure authority routing', () => {
    it('keeps release and E2E skills subordinate to the authoritative operational contracts', () => {
        expect(releaseSkill).toContain('docs/ci-performance.md');
        expect(releaseSkill).toContain('docs/self-hosted-runner.md');
        expect(releaseSkill).not.toContain(
            'A normal commit must run the self-hosted macOS CI checks without E2E',
        );
        expect(e2eSkill).not.toContain('three consecutive green samples');
    });

    it('keeps a replacement runner non-routable until its controlled admission succeeds', () => {
        expect(runnerGuide).toContain('controlled admission window');
        expect(runnerGuide).toMatch(/cancel every\s+queued CI and Release run/u);
        expect(runnerGuide).not.toContain(
            'Every source job still runs a fresh frozen-lockfile install',
        );
    });
});

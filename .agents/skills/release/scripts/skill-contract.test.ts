import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const releaseSkillDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDirectory = join(releaseSkillDirectory, '..');
const repoRoot = join(skillsDirectory, '..', '..');
const releaseSkill = readFileSync(join(releaseSkillDirectory, 'SKILL.md'), 'utf8');
const e2eSkill = readFileSync(join(skillsDirectory, 'e2e-testing', 'SKILL.md'), 'utf8');
const releaseGuide = readFileSync(join(repoRoot, 'RELEASING.md'), 'utf8');

describe('infrastructure authority routing', () => {
    it('keeps release and E2E skills subordinate to the authoritative operational contracts', () => {
        expect(releaseSkill).toContain('docs/ci-performance.md');
        expect(releaseSkill).toContain('GitHub-hosted runners');
        expect(releaseSkill).toMatch(/fresh,\s+explicit maintainer authorization/u);
        expect(releaseSkill).not.toContain('self-hosted-final');
        expect(releaseSkill).not.toContain(
            'A normal commit must run the self-hosted macOS CI checks without E2E',
        );
        expect(releaseGuide).toContain('docs/ci-performance.md');
        expect(releaseGuide).not.toContain('A normal commit runs the\nself-hosted CI checks only.');
        expect(e2eSkill).not.toContain('three consecutive green samples');
    });
});

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const skillDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDirectory = join(skillDirectory, '..');
const repoRoot = join(skillsDirectory, '..', '..');
const unitSkill = readFileSync(join(skillsDirectory, 'unit-testing', 'SKILL.md'), 'utf8');
const e2eSkill = readFileSync(join(skillDirectory, 'SKILL.md'), 'utf8');

function contractFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (
            entry.isDirectory() &&
            new Set([
                '.git',
                '.records',
                'competitors',
                'dist',
                'node_modules',
                'release',
                'release.noindex',
            ]).has(entry.name)
        ) {
            return [];
        }
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return contractFiles(path);
        return /\.(?:md|ya?ml)$/.test(entry.name) ? [path] : [];
    });
}

describe('testing skill routing', () => {
    it('exposes separate and mutually exclusive unit and Electron workflows', () => {
        expect(unitSkill).toContain('name: unit-testing');
        expect(unitSkill).toContain('does not own Playwright');
        expect(e2eSkill).toContain('name: e2e-testing');
        expect(e2eSkill).toContain('Do not use as the default Vitest workflow');
        expect(e2eSkill).toContain('--workers=1 --repeat-each=2');
        expect(e2eSkill).toContain('Two repetitions are the entire local budget');
        expect(e2eSkill).toContain('never keeps re-dispatching CI');
        expect(e2eSkill).toContain("only the user's own");
        expect(e2eSkill).toContain('long temporary-path conditions');
        expect(e2eSkill).toContain('observable product invariant');
        expect(e2eSkill).toContain('self-hosted `m2-24` runner');
        expect(e2eSkill).not.toContain('runner_probe=true');
        expect(e2eSkill).toContain('namespaced two-worker pool');
        expect(e2eSkill).toContain('never as a reason to iterate through full runs');
    });

    it('removes the legacy combined skill and routes repository contracts explicitly', () => {
        expect(existsSync(join(skillsDirectory, 'test'))).toBe(false);
        expect(existsSync(join(skillsDirectory, 'unit-test'))).toBe(false);
        const legacyPath = ['.agents', 'skills', 'test', 'SKILL.md'].join('/');
        const legacyInvocation = ['$', 'test'].join('');
        for (const path of contractFiles(repoRoot)) {
            const source = readFileSync(path, 'utf8');
            expect(source, path).not.toContain(legacyPath);
            expect(source, path).not.toContain('.agents/skills/unit-test/');
            expect(source, path).not.toMatch(/\$unit-test(?!ing)/);
            expect(source, path).not.toContain('the `test` skill');
            expect(source, path).not.toContain(legacyInvocation);
        }
    });
});

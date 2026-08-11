import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const goDirectory = join(scriptsDirectory, '..');
const fileIssueSkill = readFileSync(join(goDirectory, '..', 'file-issue', 'SKILL.md'), 'utf8');
const goSkill = readFileSync(join(goDirectory, 'SKILL.md'), 'utf8');
const intakeReference = readFileSync(join(goDirectory, 'references', 'intake.md'), 'utf8');
const acceptanceLoopReference = readFileSync(
    join(goDirectory, 'references', 'acceptance-loop.md'),
    'utf8',
);

describe('Go Acceptance planning contract', () => {
    it('files new issues as Next unless work is already underway', () => {
        expect(fileIssueSkill).toContain('--field Status --value "Next"');
        expect(fileIssueSkill).toContain(
            'Use `In Progress` instead of `Next` only when implementation or verification is already underway',
        );
        expect(fileIssueSkill).not.toContain('--field Status --value "Backlog"');
        expect(fileIssueSkill).not.toContain('--field Status --value "Todo"');
    });

    it('keeps UX design and Acceptance planning explicit in every issue', () => {
        expect(fileIssueSkill).toContain('`UX 设计` and `Acceptance 方案` in every issue');
        expect(fileIssueSkill).toContain('**UX 设计**');
        expect(fileIssueSkill).toContain('**Acceptance 方案**');
        expect(fileIssueSkill).toContain('`验收标准` defines what must be true');
        expect(intakeReference).toContain(
            'when either its `UX 设计` or `Acceptance 方案` is missing',
        );
    });

    it('requires a fresh tester subagent to author the final plan', () => {
        expect(goSkill).toContain('fresh context-isolated tester');
        expect(goSkill).toContain('Do not give it a builder-authored plan');
        expect(acceptanceLoopReference).toContain('`acceptance_plan_tester`');
        expect(acceptanceLoopReference).toContain('a report-compatible `plan[]`');
        expect(acceptanceLoopReference).toContain('issue-to-check coverage map');
        expect(acceptanceLoopReference).toContain(
            'Do not silently let the builder author the plan',
        );
    });

    it('keeps UI evidence primary without fabricating visual proof', () => {
        expect(fileIssueSkill).toContain('Prefer screenshots for settled UI');
        expect(fileIssueSkill).toContain(
            'only when the claim cannot be shown faithfully in the UI',
        );
        expect(acceptanceLoopReference).toContain(
            'Prefer real UI screenshots or video whenever the result is visible',
        );
        expect(acceptanceLoopReference).toContain(
            'A visual check must prove the behavior or state',
        );
    });
});

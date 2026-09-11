import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const goDirectory = join(scriptsDirectory, '..', '..');
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

    it('keeps every filed issue on the owner Project and honours a `Backlog` hold', () => {
        expect(fileIssueSkill).toContain('gh project item-add 2 --owner tjx666');
        expect(fileIssueSkill).toContain(
            '**`Backlog` means the owner does not want this done yet.**',
        );
        // The `go` queue is populated by hand, so a held issue reaches intake unless the skill itself declines it.
        expect(goSkill).toContain(
            'An existing issue whose Caxri project Status is `Backlog` classifies as defer',
        );
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

    it('uses one type label plus focused scope labels', () => {
        expect(fileIssueSkill).toContain('### Type — exactly one');
        expect(fileIssueSkill).toContain('### Surface — which app, zero or one');
        expect(fileIssueSkill).toContain('### Area — what it changes, one to three');
        for (const label of [
            'skill',
            'unit-testing',
            'e2e-testing',
            'terminal',
            'editor',
            'files-explorer',
            'git',
            'agent',
            'acceptance',
            'ci',
        ]) {
            expect(fileIssueSkill).toContain(`| \`${label}\``);
        }
        expect(fileIssueSkill).toContain(
            'Do not apply `unit-testing` or `e2e-testing` merely because a product change requires regression',
        );
        expect(fileIssueSkill).toContain('Apply exactly one priority label — `P0`, `P1`, or `P2`');
        expect(fileIssueSkill).toContain(
            'Finally apply exactly one effort label — `XS`, `S`, `M`, `L`, or `XL`',
        );
        expect(fileIssueSkill).toContain('verify the complete label set after creation');
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

    it('routes Go Acceptance across desktop and explicitly selected mobile surfaces', () => {
        expect(goSkill).toContain(
            'Its product surfaces are isolated macOS Electron desktop and explicitly',
        );
        expect(goSkill).toContain('selected Android/iOS mobile targets');
        expect(goSkill).toContain('no Caxri product-surface claim');
        expect(goSkill).not.toContain('Its only product surface is isolated macOS Electron');
        expect(intakeReference).toContain('every selected Acceptance path');
        expect(intakeReference).toContain('product surface and location (`desktop` or `mobile`)');
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

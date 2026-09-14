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

/**
 * The body of one `###` label-axis section, cut at the next heading of any level so a section that ends the chapter
 * does not swallow the prose after it.
 */
function axisSection(heading: string): string {
    const start = fileIssueSkill.indexOf(`### ${heading}`);
    expect(start, `\`### ${heading}\` is missing from file-issue/SKILL.md`).toBeGreaterThan(-1);
    const body = fileIssueSkill.slice(start + 4);
    const end = body.search(/^#{2,3} /m);
    return end === -1 ? body : body.slice(0, end);
}

/**
 * Every label an axis declares, read from the leading code span of each of its bullets or table rows.
 *
 * A per-label `toContain` of one table cell proves only that the string exists somewhere in the file: it never says
 * which axis owns it, and it cannot notice a label that was added or removed. That is how the hand-written list here
 * kept naming the pre-#812 labels long after four Surface labels shipped, leaving that whole dimension contractually
 * empty (issue #820). Comparing a parsed set against an explicit expected set fails in both directions, so adding a
 * label to the skill without teaching this test about it is red too.
 */
function axisLabels(heading: string): string[] {
    return axisSection(heading)
        .matchAll(/^(?:- |\| )`([^`]+)`/gm)
        .map(([, label]) => label)
        .toArray()
        .toSorted((left, right) => left.localeCompare(right));
}

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

    it('declares exactly the labels each classification axis supports', () => {
        expect(axisLabels('Type — exactly one')).toEqual([
            'bug',
            'documentation',
            'enhancement',
            'question',
        ]);
        // One per `apps/` deliverable. These four shipped in #812 and were absent from this contract until #820.
        expect(axisLabels('Surface — which app, zero or one')).toEqual([
            'cli',
            'desktop',
            'mobile',
            'server',
        ]);
        expect(axisLabels('Area — what it changes, one to three')).toEqual([
            'a11y',
            'acceptance',
            'agent',
            'agent-dispatch',
            'agent-hook',
            'agent-provider',
            'ci',
            'db',
            'deps',
            'diagnostics',
            'e2e-testing',
            'editor',
            'extension-api',
            'files-explorer',
            'git',
            'performance',
            'protocol',
            'session',
            'settings',
            'skill',
            'terminal',
            'theme',
            'tree-view',
            'unit-testing',
        ]);
        // `P3 Low` is retired, so the axis is closed at three values rather than merely containing them.
        expect(axisLabels('Priority (assess, never default)')).toEqual(['P0', 'P1', 'P2']);
        expect(axisLabels('Size (agent-native complexity)')).toEqual(['L', 'M', 'S', 'XL', 'XS']);
    });

    it('uses one type label plus focused scope labels', () => {
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

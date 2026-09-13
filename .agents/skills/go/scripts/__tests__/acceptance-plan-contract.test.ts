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
 * Returns the body of a `###` section, ending at the next heading of the same or higher level. Used so a label axis is
 * read from its own table instead of matched anywhere in the document.
 */
function sectionBody(markdown: string, heading: string): string {
    const start = markdown.indexOf(heading);
    expect(start, `missing heading: ${heading}`).toBeGreaterThanOrEqual(0);
    const tail = markdown.slice(start + heading.length);
    const next = tail.search(/^#{1,3} /m);
    return next === -1 ? tail : tail.slice(0, next);
}

/**
 * Labels declared as `- \`name` — description` bullets.
 */
function bulletLabels(body: string): string[] {
    return body
        .matchAll(/^- `([^`]+)` —/gm)
        .map((match) => match[1])
        .toArray();
}

/**
 * Labels declared in the first column of a markdown table, skipping the separator row.
 */
function tableLabels(body: string): string[] {
    return body
        .matchAll(/^\| `([^`]+)`\s*\|/gm)
        .map((match) => match[1])
        .toArray();
}

/**
 * Labels listed inline in the em-dash clause that immediately follows `prefix`.
 */
function inlineLabels(markdown: string, prefix: string): string[] {
    const start = markdown.indexOf(prefix);
    expect(start, `missing sentence: ${prefix}`).toBeGreaterThanOrEqual(0);
    const tail = markdown.slice(start + prefix.length);
    const clauseEnd = tail.indexOf('—');
    expect(clauseEnd, `unterminated label clause: ${prefix}`).toBeGreaterThan(0);
    return tail
        .slice(0, clauseEnd)
        .matchAll(/`([^`]+)`/g)
        .map((match) => match[1])
        .toArray();
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

    // Each axis is parsed out of its own section so emptying a table fails the contract, and so
    // adding a label to `file-issue` fails here until the supported set is updated deliberately.
    it.each([
        {
            axis: 'Type',
            expected: ['bug', 'documentation', 'enhancement', 'question'],
            read: () => bulletLabels(sectionBody(fileIssueSkill, '### Type — exactly one')),
        },
        {
            axis: 'Surface',
            expected: ['cli', 'desktop', 'mobile', 'server'],
            read: () =>
                tableLabels(sectionBody(fileIssueSkill, '### Surface — which app, zero or one')),
        },
        {
            axis: 'Area',
            expected: [
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
            ],
            read: () =>
                tableLabels(
                    sectionBody(fileIssueSkill, '### Area — what it changes, one to three'),
                ),
        },
        {
            axis: 'Priority',
            expected: ['P0', 'P1', 'P2'],
            read: () => inlineLabels(fileIssueSkill, 'Apply exactly one priority label —'),
        },
        {
            axis: 'effort',
            expected: ['L', 'M', 'S', 'XL', 'XS'],
            read: () => inlineLabels(fileIssueSkill, 'Finally apply exactly one effort label —'),
        },
    ])('pins every $axis label value', ({ expected, read }) => {
        const byName = (left: string, right: string): number => left.localeCompare(right);
        expect(read().toSorted(byName)).toEqual(expected.toSorted(byName));
    });

    it('keeps the label axes and their application rules explicit', () => {
        expect(fileIssueSkill).toContain(
            'Labels are read as five independent axes: type, surface, area, priority, effort.',
        );
        expect(fileIssueSkill).toContain(
            'Do not apply `unit-testing` or `e2e-testing` merely because a product change requires regression',
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

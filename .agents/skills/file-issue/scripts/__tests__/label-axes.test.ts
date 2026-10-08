import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const skill = readFileSync(fileURLToPath(new URL('../../SKILL.md', import.meta.url)), 'utf8');

/**
 * The body of one `###` label-axis section, cut at the next heading of any level so a section that ends the chapter
 * does not swallow the prose after it.
 */
function axisSection(heading: string): string {
    const start = skill.indexOf(`### ${heading}`);
    expect(start, `\`### ${heading}\` is missing from file-issue/SKILL.md`).toBeGreaterThan(-1);
    const body = skill.slice(start + 4);
    const end = body.search(/^#{2,3} /m);
    return end === -1 ? body : body.slice(0, end);
}

/**
 * Every label an axis declares, read from the leading code span of each of its bullets or table rows.
 *
 * A per-label `toContain` of one table cell proves only that the string exists somewhere in the file: it never says
 * which axis owns it, and it cannot notice a label that was added or removed. That is how the hand-written list in the
 * `go` Acceptance contract test kept naming the pre-#812 labels long after four Surface labels shipped, leaving that
 * whole dimension contractually empty (issue #820). Comparing a parsed set against an explicit expected set fails in
 * both directions, so adding a label to the skill without teaching this test about it is red too.
 *
 * This lives beside the skill it describes rather than under `go`, so an agent editing the label tables sees it fail by
 * running this skill's own tests.
 */
function axisLabels(heading: string): string[] {
    return axisSection(heading)
        .matchAll(/^(?:- |\| )`([^`]+)`/gm)
        .map(([, label]) => label)
        .toArray()
        .toSorted((left, right) => left.localeCompare(right));
}

describe('file-issue label axes', () => {
    it('declares exactly the labels each classification axis supports', () => {
        expect(axisLabels('Type: exactly one')).toEqual([
            'bug',
            'documentation',
            'enhancement',
            'question',
        ]);
        // One per `apps/` deliverable. These four shipped in #812 and were absent from any contract until #820.
        expect(axisLabels('Surface: which app, zero or one')).toEqual([
            'cli',
            'desktop',
            'mobile',
            'server',
        ]);
        expect(axisLabels('Area: what it changes, one to three')).toEqual([
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
});

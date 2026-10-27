import { describe, expect, it } from 'vitest';

import fileIssueSkill from '../../.agents/skills/file-issue/SKILL.md?raw';
import confidentialitySkill from '../../.agents/skills/oss-confidentiality/SKILL.md?raw';
import pullRequestSkill from '../../.agents/skills/pull-request/SKILL.md?raw';

const normalizedConfidentialitySkill = confidentialitySkill.replaceAll(/\s+/gu, ' ');

describe('public media review contract', () => {
    it('makes the acting Agent responsible for original and final image inspection', () => {
        expect(normalizedConfidentialitySkill).toContain(
            'The acting Agent owns the visual privacy review.',
        );
        expect(normalizedConfidentialitySkill).toContain(
            'Never ask the maintainer to open, inspect, or approve screenshots',
        );
        expect(normalizedConfidentialitySkill).toContain(
            'Inspect a local original before uploading it;',
        );
        expect(normalizedConfidentialitySkill).toContain(
            'Inspect the exact final image again after any crop, opaque redaction, annotation, or regeneration',
        );
    });

    it('fails closed without echoing private image content', () => {
        expect(normalizedConfidentialitySkill).toContain(
            'Fail closed when an attachment cannot be fetched, decoded, viewed at useful resolution, or judged safe.',
        );
        expect(normalizedConfidentialitySkill).toContain(
            'report only safe categories and outcomes without repeating the private content.',
        );
    });

    it.each([
        ['issue', fileIssueSkill],
        ['pull request', pullRequestSkill],
    ])('blocks each %s mutation until referenced images are safe or removed', (_name, skill) => {
        const normalized = skill.replaceAll(/\s+/gu, ' ');
        expect(normalized).toContain('original-and-final visual review');
        expect(normalized).toContain('each image is confirmed safe or removed');
        expect(normalized).toContain('never hand routine screenshot review to the maintainer');
    });
});

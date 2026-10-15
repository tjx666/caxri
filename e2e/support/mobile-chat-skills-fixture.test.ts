import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    MOBILE_CHAT_SKILL_QUERY,
    mobileChatSkills,
    seedMobileChatSkills,
} from './mobile-chat-skills-fixture';

describe('synthetic mobile Chat skills', () => {
    it('writes one SKILL.md with name and description per skill', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-mobile-skills-test-'));
        try {
            await seedMobileChatSkills(root);
            const skillsRoot = join(root, '.claude', 'skills');
            expect((await readdir(skillsRoot)).toSorted((a, b) => a.localeCompare(b))).toEqual(
                mobileChatSkills.map(({ name }) => name).toSorted((a, b) => a.localeCompare(b)),
            );
            const source = await readFile(join(skillsRoot, 'tour-guide', 'SKILL.md'), 'utf8');
            expect(source).toContain('name: tour-guide\n');
            expect(source).toContain('description: Walks a newcomer');
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    it('leaves exactly one skill outside the narrowed query', () => {
        const query = MOBILE_CHAT_SKILL_QUERY.slice(1);
        const outside = mobileChatSkills.filter(
            ({ name, description }) =>
                !name.startsWith(query) && !`${name} ${description}`.includes(query),
        );
        expect(outside.map(({ name }) => name)).toEqual(['release-notes']);
    });
});

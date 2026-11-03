import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { authorityOptions, registerTemporaryDirectories } from './authority.fixture';

const temporaryDirectory = registerTemporaryDirectories();

describe('path browser free-browsing links', () => {
    it('follows free-browsing links to their current file or folder target', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const linksRoot = await temporaryDirectory('caxri-path-links-');
        const targetsRoot = await temporaryDirectory('caxri-path-targets-');
        const skill = join(targetsRoot, 'skill');
        await mkdir(skill);
        await writeFile(join(skill, 'SKILL.md'), '# Skill\n');
        await Promise.all([
            symlink(skill, join(linksRoot, 'skill-link')),
            symlink(join(skill, 'SKILL.md'), join(linksRoot, 'file-link.md')),
            symlink(join(targetsRoot, 'missing'), join(linksRoot, 'broken-link')),
            mkdir(join(linksRoot, 'plain')),
        ]);
        const { authority, openFile } = authorityOptions(ownerRoot, workbenchRoot);
        const initial = await authority.start({ sessionId: 'session-1' });
        const listed = await authority.browse({
            browserId: initial.browserId,
            mode: 'free',
            input: `${linksRoot}/`,
        });
        expect(
            listed.entries.map(({ kind, linkKind, name }) => ({ kind, linkKind, name })),
        ).toEqual([
            { kind: 'directory', linkKind: undefined, name: 'plain' },
            { kind: 'symlink', linkKind: 'directory', name: 'skill-link' },
            { kind: 'symlink', linkKind: 'broken', name: 'broken-link' },
            { kind: 'symlink', linkKind: 'file', name: 'file-link.md' },
        ]);
        const byName = new Map(listed.entries.map((entry) => [entry.name, entry]));

        await expect(
            authority.open({
                browserId: initial.browserId,
                entryId: byName.get('file-link.md')!.id,
            }),
        ).resolves.toMatchObject({
            kind: 'external',
            document: { name: 'SKILL.md', content: '# Skill\n' },
        });
        expect(openFile).not.toHaveBeenCalled();

        const reopened = await authority.start({ sessionId: 'session-1' });
        const relisted = await authority.browse({
            browserId: reopened.browserId,
            mode: 'free',
            input: `${linksRoot}/`,
        });
        const relistedByName = new Map(relisted.entries.map((entry) => [entry.name, entry]));
        await expect(
            authority.navigate({
                browserId: reopened.browserId,
                target: { kind: 'entry', entryId: relistedByName.get('broken-link')!.id },
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        const entered = await authority.navigate({
            browserId: reopened.browserId,
            target: { kind: 'entry', entryId: relistedByName.get('skill-link')!.id },
        });
        expect(entered).toMatchObject({ mode: 'free' });
        expect('entries' in entered && entered.entries.map((entry) => entry.name)).toEqual([
            'SKILL.md',
        ]);
    });
});

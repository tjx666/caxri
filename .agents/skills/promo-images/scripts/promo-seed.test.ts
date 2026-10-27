import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { execFileAsync } from '../../../../scripts/exec';
import { parsePromoScene } from './promo-scene';
import { PROMO_SETTINGS, seedPromoProject, writePromoSettings } from './promo-seed';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { force: true, recursive: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

async function git(root: string, arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', arguments_, { cwd: root });
    return stdout.trim();
}

const project = parsePromoScene(
    {
        name: 'demo',
        layout: 'hero-desktop-mobile',
        canvas: { width: 1200, height: 675 },
        copy: { headline: 'Headline' },
        theme: 'dracula',
        desktop: { width: 1120, height: 700, session: 'one' },
        mobile: { hostName: 'Studio Mac', screen: 'sessions' },
        agents: { claude: 'claude.json' },
        projects: [
            {
                key: 'shop',
                name: 'shop',
                branch: 'feat/coupons',
                commits: [
                    { message: 'Start', files: { 'src/a.ts': 'one\n', 'src/old.ts': 'old\n' } },
                    { message: 'Grow', files: { 'src/a.ts': ['one', 'two'] } },
                ],
                changes: { 'src/b.ts': 'new\n', 'src/old.ts': null },
            },
        ],
        sessions: [
            {
                key: 'one',
                project: 'shop',
                agent: 'claude',
                title: 'One',
                prompt: 'Go.',
                expect: 'completed',
            },
        ],
    },
    { claude: { turns: [{ prompt: 'Go.', steps: [{ kind: 'text', text: 'Done.' }] }] } },
).scene.projects[0];

describe('seedPromoProject', () => {
    it('commits as the invented author at fixed times, then leaves the changes uncommitted', async () => {
        const directory = await temporaryDirectory('caxri-promo-seed-');
        const root = await seedPromoProject(directory, project, 1);

        expect(root).toBe(join(directory, 'shop'));
        expect(await git(root, ['branch', '--show-current'])).toBe('feat/coupons');
        expect(await git(root, ['log', '--format=%an <%ae> %cn %aI %s'])).toBe(
            [
                'Demo Developer <demo@example.com> Demo Developer 2026-03-03T12:00:00Z Grow',
                'Demo Developer <demo@example.com> Demo Developer 2026-03-03T09:00:00Z Start',
            ].join('\n'),
        );
        expect(await git(root, ['status', '--porcelain'])).toBe('D src/old.ts\n?? src/b.ts');
        expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('one\ntwo\n');
    });
});

describe('writePromoSettings', () => {
    it('writes the capture settings where the launcher keeps them', async () => {
        const directory = await temporaryDirectory('caxri-promo-settings-');
        await writePromoSettings(directory);
        const written = JSON.parse(
            await readFile(join(directory, 'config', 'settings.jsonc'), 'utf8'),
        ) as unknown;
        expect(written).toEqual(PROMO_SETTINGS);
    });
});

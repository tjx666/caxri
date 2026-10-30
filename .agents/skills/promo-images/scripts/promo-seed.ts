import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '../../../../scripts/exec';
import type { PromoSceneProject } from './promo-scene';

/**
 * A fixed, invented identity and clock for every seeded commit, so History and blame never show the person running the
 * capture and two runs produce the same repositories.
 */
const AUTHOR = { name: 'Demo Developer', email: 'demo@example.com' };
const FIRST_COMMIT_AT = Date.parse('2026-03-02T09:00:00Z');
const COMMIT_SPACING_MS = 3 * 60 * 60 * 1000;
/**
 * Each Project's history starts a day after the previous one's.
 */
const PROJECT_SPACING_MS = 24 * 60 * 60 * 1000;

/**
 * Settings the capture profile starts with. Agents open as Chats, nothing auto-saves into the seeded changes, the
 * sidebar is opaque so the wallpaper never shows through, and no avatar request leaves the machine.
 */
export const PROMO_SETTINGS = {
    'files.autoSave': 'off',
    'git.fetchGitHubAvatars': false,
    'primarySidebar.translucent': false,
    'session.openAgentsInChat': true,
    'statusBar.usage.limitWindows': 'both',
} as const;

/**
 * Git with the user's global and system configuration ignored, so hooks, signing and templates from the machine running
 * the capture cannot reach the seeded repositories.
 */
async function git(cwd: string, arguments_: string[], date?: Date): Promise<void> {
    const stamp = date?.toISOString();
    await execFileAsync('git', arguments_, {
        cwd,
        env: {
            PATH: process.env.PATH,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_AUTHOR_NAME: AUTHOR.name,
            GIT_AUTHOR_EMAIL: AUTHOR.email,
            GIT_COMMITTER_NAME: AUTHOR.name,
            GIT_COMMITTER_EMAIL: AUTHOR.email,
            ...(stamp && { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }),
        },
    });
}

async function writeFiles(root: string, files: Record<string, string | null>): Promise<void> {
    await Promise.all(
        Object.entries(files).map(async ([path, text]) => {
            const target = join(root, path);
            if (text === null) {
                await rm(target, { force: true });
                return;
            }
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, text);
        }),
    );
}

/**
 * Creates one Project's repository under `parent`: its commits on `main`, then its branch, then the uncommitted
 * changes. Resolves with the Project root.
 */
export async function seedPromoProject(
    parent: string,
    project: PromoSceneProject,
    projectIndex: number,
): Promise<string> {
    const root = join(parent, project.name);
    await mkdir(root, { recursive: true });
    await git(root, ['init', '--quiet', '--initial-branch=main']);
    for (const [index, commit] of project.commits.entries()) {
        const date = new Date(
            FIRST_COMMIT_AT + projectIndex * PROJECT_SPACING_MS + index * COMMIT_SPACING_MS,
        );
        // eslint-disable-next-line no-await-in-loop -- commits are ordered
        await writeFiles(root, commit.files);
        // eslint-disable-next-line no-await-in-loop -- commits are ordered
        await git(root, ['add', '--all']);
        // eslint-disable-next-line no-await-in-loop -- commits are ordered
        await git(root, ['commit', '--quiet', '--no-verify', '-m', commit.message], date);
    }
    if (project.branch !== 'main') await git(root, ['switch', '--quiet', '-c', project.branch]);
    await writeFiles(root, project.changes);
    return root;
}

/**
 * Writes the capture profile's settings before launch; the E2E launcher keeps an existing settings file.
 */
export async function writePromoSettings(userDataDirectory: string): Promise<void> {
    const path = join(userDataDirectory, 'config', 'settings.jsonc');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(PROMO_SETTINGS, null, 2)}\n`);
}

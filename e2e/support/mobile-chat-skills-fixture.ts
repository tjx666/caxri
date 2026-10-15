import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The invented Claude Code skills the Chat menu cases discover in the disposable Acceptance Project. Two share the `to`
 * prefix so typing `/to` narrows the menu to them; the third matches neither by name nor by description, so it proves
 * the narrowing.
 */
export const mobileChatSkills = [
    { name: 'tour-guide', description: 'Walks a newcomer through the sample layout.' },
    { name: 'topic-summary', description: 'Summarizes one sample topic in a short paragraph.' },
    { name: 'release-notes', description: 'Drafts the release notes from merged changes.' },
] as const;

/**
 * The bare draft that narrows the menu to the skills sharing the `to` prefix.
 */
export const MOBILE_CHAT_SKILL_QUERY = '/to';

/**
 * Writes each skill as `.claude/skills/<name>/SKILL.md` under the Project root, where Claude Code's project skill
 * discovery reads them.
 */
export async function seedMobileChatSkills(root: string): Promise<void> {
    await Promise.all(
        mobileChatSkills.map(async ({ name, description }) => {
            const directory = join(root, '.claude', 'skills', name);
            await mkdir(directory, { recursive: true });
            await writeFile(
                join(directory, 'SKILL.md'),
                `---\nname: ${name}\ndescription: ${description}\n---\n\nAn invented skill for the phone's Chat menu.\n`,
                'utf8',
            );
        }),
    );
}

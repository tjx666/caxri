import process from 'node:process';

import type { FakeCodexIo } from './fake-codex-io.ts';

type Json = Record<string, unknown>;

/**
 * The skills the fake Codex app-server's `skills/list` reports (`SkillsListResponse`): a Project skill, a user skill, a
 * plugin skill (its `pluginId` set), and a disabled plugin skill. `FAKE_CODEX_SKILLS=fail` makes the method fail, as an
 * older Codex without it does.
 */
export function didHandleSkillsListRequest(
    io: FakeCodexIo,
    id: number | undefined,
    method: string | undefined,
    parameters: Json,
): boolean {
    if (method !== 'skills/list') return false;
    if (process.env.FAKE_CODEX_SKILLS !== 'list') {
        io.send({ id, error: { code: -32_601, message: 'Method not found' } });
        return true;
    }
    const cwd = Array.isArray(parameters.cwds) ? String(parameters.cwds[0]) : '/';
    const skill = (
        name: string,
        description: string,
        scope: string,
        isEnabled: boolean,
        pluginId: string | null,
    ) => ({
        name,
        description,
        path: `${cwd}/.fake-skills/${name}/SKILL.md`,
        scope,
        enabled: isEnabled,
        pluginId,
    });
    io.send({
        id,
        result: {
            data: [
                {
                    cwd,
                    skills: [
                        skill('repo-helper', 'Helps inside this Project', 'repo', true, null),
                        skill(
                            'imagegen',
                            'Generate images with the image tool',
                            'system',
                            true,
                            null,
                        ),
                        skill(
                            'github:triage-issue',
                            'Triage a GitHub issue from the GitHub plugin',
                            'user',
                            true,
                            'github@openai-curated',
                        ),
                        skill(
                            'linear:plan',
                            'Plan work in Linear (plugin turned off)',
                            'user',
                            false,
                            'linear@openai-curated',
                        ),
                    ],
                    errors: [],
                },
            ],
        },
    });
    return true;
}

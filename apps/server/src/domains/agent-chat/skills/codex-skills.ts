import type { ReportedAgentSkill } from '../../agents';
import type { JsonRpcConnection } from '../json-rpc-connection';

/**
 * A skills read only decorates the composer menu; one that hangs leaves the menu on the filesystem scan.
 */
const SKILLS_LIST_TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;

const record = (value: unknown): Json | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Json)
        : undefined;

/**
 * The skills a Codex `skills/list` answer describes (`SkillsListResponse`: one entry per requested cwd, each with
 * `SkillMetadata` rows). Rows without a name or a `SKILL.md` path are dropped. Codex marks a skill it has turned off
 * with `enabled: false`; the scope `repo` is a Project skill, while `user`, `system`, `admin`, and plugin skills are
 * not.
 */
function codexReportedSkills(result: unknown): ReportedAgentSkill[] | undefined {
    const data = record(result)?.data;
    if (!Array.isArray(data)) return undefined;
    return data.flatMap((entry) => {
        const rows = record(entry)?.skills;
        return Array.isArray(rows) ? rows.flatMap((row) => reportedSkill(record(row))) : [];
    });
}

function reportedSkill(skill: Json | undefined): ReportedAgentSkill[] {
    if (!skill) return [];
    const { name, description, path, scope, enabled } = skill;
    if (typeof name !== 'string' || typeof path !== 'string' || !path.endsWith('SKILL.md'))
        return [];
    return [
        {
            name,
            ...(typeof description === 'string' && { description }),
            enabled: enabled !== false,
            isProject: scope === 'repo',
            path,
        },
    ];
}

/**
 * Asks the running app-server, if any, for the Chat's working directory with `forceReload`, so a plugin enabled or
 * disabled in Codex since the last read shows up the next time the menu opens.
 */
export async function readCodexSkills(
    connection: JsonRpcConnection | undefined,
    cwd: string,
): Promise<ReportedAgentSkill[] | undefined> {
    if (!connection?.isOpen) return undefined;
    const result = await connection.request(
        'skills/list',
        { cwds: [cwd], forceReload: true },
        SKILLS_LIST_TIMEOUT_MS,
    );
    return codexReportedSkills(result);
}

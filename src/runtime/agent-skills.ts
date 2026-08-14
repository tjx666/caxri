import { inspectBundledSkillHealth } from '@caxri/cli';

import type { AgentSkillHealth } from '../shared/types';
import type { AgentEnvironment } from './agents';
import type { CaxriDatabase } from './db';

/**
 * Reads the CLI's exact compatibility projection inside the Runtime, which owns Provider config
 * filesystem access. A missing selected Project suppresses local inspection instead of guessing a
 * working directory; absolute Provider paths and marker contents never enter the returned object.
 */
export function agentSkillHealthReader(
    database: CaxriDatabase,
    environment: AgentEnvironment,
    fallbackCwd: string,
): () => Promise<AgentSkillHealth> {
    return async () => {
        const context = {
            cwd: fallbackCwd,
            environment: environment.variables,
            home: environment.homeDirectory,
        };
        const global = await inspectBundledSkillHealth(context, { scopes: ['global'] });
        const projectId = database.getAppState<string | null>('lastSelectedProjectId') ?? undefined;
        const project = projectId ? database.getProject(projectId) : undefined;
        if (!project) return global;
        try {
            const local = await inspectBundledSkillHealth(
                { ...context, cwd: project.rootPath },
                { scopes: ['local'] },
            );
            return {
                ...global,
                installations: [...local.installations, ...global.installations],
                selectedProjectId: project.id,
            };
        } catch {
            return { ...global, selectedProjectId: project.id };
        }
    };
}

import { z } from 'zod';

import { agentProviderIds } from '../agent/agents.js';
import { appSettingsSchema } from '../configuration/settings-schema.js';
import type { ProjectRecord } from '../domain/domain.js';
import {
    humanProjectSchema,
    projectRecordSchema,
    scopedProjectSchema,
    sessionRecordSchema,
} from '../domain/domain.js';
import { terminalRecordSchema } from '../domain/terminal-record.js';
import type { Principal } from '../transport/principal.js';
import { protocolVersionSchema } from '../transport/version.js';

export const projectListResultSchema = z.discriminatedUnion('view', [
    z.object({ view: z.literal('desktop'), projects: z.array(projectRecordSchema).max(1_024) }),
    z.object({ view: z.literal('human-cli'), projects: z.array(humanProjectSchema).max(1_024) }),
    z.object({ view: z.literal('agent'), projects: z.array(scopedProjectSchema).max(128) }),
    z.object({
        view: z.literal('delegation-client'),
        projects: z.array(scopedProjectSchema).max(128),
    }),
    z.object({ view: z.literal('extension'), projects: z.array(scopedProjectSchema).max(128) }),
    z.object({
        view: z.literal('paired-device'),
        projects: z.array(scopedProjectSchema).max(128),
    }),
]);

export type ProjectListResult = z.infer<typeof projectListResultSchema>;

const sessionSummarySchema = sessionRecordSchema.pick({
    id: true,
    projectId: true,
    title: true,
    archivedAt: true,
    lastVisitedAt: true,
    agentActivityState: true,
    primaryAgentTerminalId: true,
    attentionGeneration: true,
    hasUnread: true,
});
const terminalSummarySchema = terminalRecordSchema.pick({
    id: true,
    sessionId: true,
    kind: true,
    lastProcessState: true,
    failureReason: true,
});

/**
 * Minimal schemas are exported even before a command exposes the corresponding domain.
 */
export const principalProjectionSchemas = {
    project: scopedProjectSchema,
    session: sessionSummarySchema,
    terminal: terminalSummarySchema,
    settings: appSettingsSchema.pick({
        'session.defaultAgent': true,
        'terminal.fontSize': true,
        'terminal.scrollback': true,
        'terminal.copyOnSelect': true,
        'terminal.gpuAcceleration': true,
        'terminal.osc52ClipboardWrite': true,
        'files.maxFileBytes': true,
    }),
    diagnostics: z.object({
        appVersion: z.string().min(1).max(100),
        protocolVersion: protocolVersionSchema,
        runtimeStatus: z.enum(['starting', 'ready', 'restarting', 'failed']),
        projectCount: z.number().int().nonnegative(),
        sessionCount: z.number().int().nonnegative(),
        terminalCount: z.number().int().nonnegative(),
    }),
    agent: z.object({
        provider: z.enum(agentProviderIds),
        status: z.enum(['unknown', 'working', 'waiting', 'completed', 'failed']),
        available: z.boolean(),
    }),
} as const;

function projectScope(principal: Principal): ReadonlySet<string> | undefined {
    switch (principal.kind) {
        case 'agent':
        case 'delegation-client':
        case 'extension':
        case 'paired-device': {
            return new Set(principal.projectIds);
        }
        default: {
            return undefined;
        }
    }
}

/**
 * Removes path and unrelated-Project data before a project list leaves the application handler.
 */
export function projectListForPrincipal(value: unknown, principal: Principal): ProjectListResult {
    const parsed = projectListResultSchema.parse(value);
    const records = parsed.projects as ProjectRecord[];
    if (principal.kind === 'desktop') return { view: 'desktop', projects: records };
    if (principal.kind === 'human-cli') {
        return {
            view: 'human-cli',
            projects: records.map(({ id, title, ownerProjectId, rootPath }) => ({
                id,
                title,
                rootPath,
                // Omitted rather than nulled for a top-level Project, matching `project.query`'s human view.
                ...(ownerProjectId !== undefined && { ownerProjectId }),
            })),
        };
    }
    const scope = projectScope(principal)!;
    const projects = [] as Array<{ id: string; title: string }>;
    for (const { id, title } of records) {
        if (scope.has(id)) projects.push({ id, title });
    }
    return { view: principal.kind, projects };
}

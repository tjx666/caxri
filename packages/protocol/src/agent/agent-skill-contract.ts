import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import { agentProviderIds, agentProviderSchema } from './agents.js';

const versionSchema = z
    .string()
    .max(100)
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
const contentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const agentSkillScopes = ['local', 'global'] as const;

export const agentSkillScopeSchema = z.enum(agentSkillScopes);
export const agentSkillStatusSchema = z.enum(['compatible', 'conflict', 'missing', 'stale']);
export const agentSkillReasonSchema = z.enum([
    'foreign-entry',
    'invalid-installed-version',
    'invalid-marker',
    'matches-bundle',
    'modified-or-foreign-files',
    'newer-version',
    'not-installed',
    'older-version',
    'same-version-contract-mismatch',
    'unknown-schema',
    'unreadable-installation',
    'unsafe-parent',
]);

export const bundledAgentSkillMetadataSchema = z.object({
    bundledVersion: versionSchema,
    compatibility: z.object({
        cliVersion: versionSchema,
        protocolVersion: z.number().int().positive().max(1_000_000),
    }),
    contentHash: contentHashSchema,
    files: z.array(z.string().min(1).max(240)).min(1).max(16),
    name: z.literal('caxri-cli'),
    schemaVersion: z.number().int().positive().max(1_000_000),
});

export const installedAgentSkillHealthSchema = z.object({
    action: z.string().min(1).max(1_024),
    bundledVersion: versionSchema,
    compatible: z.boolean(),
    contentHash: contentHashSchema.optional(),
    installedSchemaVersion: z.number().int().positive().max(1_000_000).optional(),
    installedVersion: versionSchema.optional(),
    name: z.literal('caxri-cli'),
    protocolVersion: z.number().int().positive().max(1_000_000),
    provider: agentProviderSchema,
    reason: agentSkillReasonSchema,
    repairCommand: z.string().min(1).max(512).optional(),
    scope: agentSkillScopeSchema,
    status: agentSkillStatusSchema,
});

/**
 * Path-free compatibility health shared by the offline CLI and Desktop Settings.
 */
export const agentSkillHealthSchema = z.object({
    bundled: bundledAgentSkillMetadataSchema,
    installations: z
        .array(installedAgentSkillHealthSchema)
        .max(agentProviderIds.length * agentSkillScopes.length),
    selectedProjectId: identifierSchema.optional(),
});

export type AgentSkillHealth = z.infer<typeof agentSkillHealthSchema>;
export type AgentSkillInstallationHealth = z.infer<typeof installedAgentSkillHealthSchema>;
export type AgentSkillScope = z.infer<typeof agentSkillScopeSchema>;

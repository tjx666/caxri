import { describe, expect, it } from 'vitest';

import {
    agentSkillHealthSchema,
    bundledAgentSkillMetadataSchema,
} from '../agent-skill-contract.js';

const baseBundled = {
    bundledVersion: '0.0.6',
    compatibility: { cliVersion: '0.0.6', protocolVersion: 2 },
    contentHash: `sha256:${'a'.repeat(64)}`,
    files: ['SKILL.md'],
    name: 'caxri-cli' as const,
    schemaVersion: 1,
};

describe('bundledAgentSkillMetadataSchema version and content hash validation', () => {
    it('accepts semantic versions with pre-release and build metadata', () => {
        expect(
            bundledAgentSkillMetadataSchema.safeParse({
                ...baseBundled,
                bundledVersion: '1.2.3-beta.1+build.7',
            }).success,
        ).toBe(true);
    });

    it('rejects a version string that is not a semantic version', () => {
        expect(
            bundledAgentSkillMetadataSchema.safeParse({ ...baseBundled, bundledVersion: 'v1' })
                .success,
        ).toBe(false);
    });

    it('rejects a content hash that is not a lowercase sha256 digest', () => {
        expect(
            bundledAgentSkillMetadataSchema.safeParse({
                ...baseBundled,
                contentHash: `sha256:${'A'.repeat(64)}`,
            }).success,
        ).toBe(false);
        expect(
            bundledAgentSkillMetadataSchema.safeParse({ ...baseBundled, contentHash: 'not-a-hash' })
                .success,
        ).toBe(false);
    });

    it('rejects an unrecognized bundle name', () => {
        expect(
            bundledAgentSkillMetadataSchema.safeParse({ ...baseBundled, name: 'other-cli' })
                .success,
        ).toBe(false);
    });
});

describe('agentSkillHealthSchema', () => {
    it('bounds installations to at most four entries', () => {
        const installation = {
            action: 'No action is required.',
            bundledVersion: '0.0.6',
            compatible: true,
            name: 'caxri-cli' as const,
            protocolVersion: 2,
            provider: 'claude' as const,
            reason: 'matches-bundle' as const,
            scope: 'local' as const,
            status: 'compatible' as const,
        };
        expect(
            agentSkillHealthSchema.safeParse({
                bundled: baseBundled,
                installations: Array.from({ length: 5 }, () => installation),
            }).success,
        ).toBe(false);
        expect(
            agentSkillHealthSchema.safeParse({
                bundled: baseBundled,
                installations: Array.from({ length: 4 }, () => installation),
            }).success,
        ).toBe(true);
    });
});

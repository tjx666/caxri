import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { readClaudeRateLimitTier } from '../rate-limit-tier';

async function home(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'caxri-claude-tier-'));
    onTestFinished(() => rm(root, { force: true, recursive: true }));
    return root;
}

describe('readClaudeRateLimitTier', () => {
    it('reads the organization tier, preferring a user tier when one is set', async () => {
        const homeDirectory = await home();
        const path = join(homeDirectory, '.claude.json');
        await writeFile(
            path,
            JSON.stringify({
                projects: {},
                oauthAccount: {
                    organizationRateLimitTier: 'default_claude_max_5x',
                    userRateLimitTier: null,
                },
            }),
        );
        expect(await readClaudeRateLimitTier({ homeDirectory, variables: {} })).toBe(
            'default_claude_max_5x',
        );
        await writeFile(
            path,
            JSON.stringify({
                oauthAccount: {
                    organizationRateLimitTier: 'default_claude_max_5x',
                    userRateLimitTier: 'default_claude_max_20x',
                },
            }),
        );
        expect(await readClaudeRateLimitTier({ homeDirectory, variables: {} })).toBe(
            'default_claude_max_20x',
        );
    });

    it('follows CLAUDE_CONFIG_DIR', async () => {
        const homeDirectory = await home();
        const configDirectory = join(homeDirectory, 'profile');
        await mkdir(configDirectory);
        await writeFile(
            join(configDirectory, '.claude.json'),
            JSON.stringify({ oauthAccount: { organizationRateLimitTier: 'default_claude_ai' } }),
        );
        expect(
            await readClaudeRateLimitTier({
                homeDirectory,
                variables: { CLAUDE_CONFIG_DIR: configDirectory },
            }),
        ).toBe('default_claude_ai');
    });

    it('has no tier for a missing, malformed, or account-less config', async () => {
        const homeDirectory = await home();
        const environment = { homeDirectory, variables: {} };
        expect(await readClaudeRateLimitTier(environment)).toBeUndefined();
        await writeFile(join(homeDirectory, '.claude.json'), '{ not json');
        expect(await readClaudeRateLimitTier(environment)).toBeUndefined();
        await writeFile(join(homeDirectory, '.claude.json'), JSON.stringify({ projects: {} }));
        expect(await readClaudeRateLimitTier(environment)).toBeUndefined();
    });
});

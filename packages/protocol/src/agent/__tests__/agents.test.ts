import { describe, expect, it } from 'vitest';

import { agentProviderCatalog, agentProviderIds, defaultAgentProviderSettings } from '../agents.js';

describe('agentProviderCatalog.resumeArguments', () => {
    it('builds Claude Code resume argv with the --resume flag', () => {
        expect(agentProviderCatalog.claude.resumeArguments('session-123')).toEqual([
            '--resume',
            'session-123',
        ]);
    });

    it('builds Codex resume argv with the resume subcommand', () => {
        expect(agentProviderCatalog.codex.resumeArguments('session-123')).toEqual([
            'resume',
            'session-123',
        ]);
    });

    it('keeps image input undefined for providers without a documented safe paste path', () => {
        expect(agentProviderCatalog.claude.imageInput).toBeUndefined();
        expect(agentProviderCatalog.codex.imageInput).toEqual({
            kind: 'systemClipboardPaste',
            terminalInput: '\u{16}',
        });
    });
});

describe('defaultAgentProviderSettings', () => {
    it('derives one entry per catalogued provider with its own executable name', () => {
        const alphabetical = (a: string, b: string) => a.localeCompare(b);
        expect(Object.keys(defaultAgentProviderSettings).toSorted(alphabetical)).toEqual(
            [...agentProviderIds].toSorted(alphabetical),
        );
        for (const provider of agentProviderIds) {
            expect(defaultAgentProviderSettings[provider].launch.executable).toBe(
                agentProviderCatalog[provider].executableName,
            );
            expect(defaultAgentProviderSettings[provider].launch.args).toEqual([]);
            expect(defaultAgentProviderSettings[provider].hooks.enabled).toBe(false);
            expect(defaultAgentProviderSettings[provider].messaging.enabled).toBe(true);
            expect(defaultAgentProviderSettings[provider].recovery).toEqual({
                enabled: false,
                patterns: [],
                settleDelayMs: 1_000,
                continueDelayMs: 1_000,
            });
        }
    });
});

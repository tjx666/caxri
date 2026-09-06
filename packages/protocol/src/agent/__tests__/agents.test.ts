import { describe, expect, it } from 'vitest';

import { agentProviderCatalog, agentProviderIds, defaultAgentProviderSettings } from '../agents.js';

describe('agentProviderCatalog capabilities', () => {
    it('keeps image input undefined for providers without a documented safe paste path', () => {
        expect(agentProviderCatalog.claude.imageInput).toBeUndefined();
        expect(agentProviderCatalog.codex.imageInput).toEqual({
            kind: 'systemClipboardPaste',
            terminalInput: '\u{16}',
        });
    });

    it('declares exactly one automatic Session naming owner per provider', () => {
        expect(agentProviderCatalog.claude.automaticSessionNaming).toBe('caxri');
        expect(agentProviderCatalog.codex.automaticSessionNaming).toBe('native');
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
            expect(defaultAgentProviderSettings[provider].launch.args).toEqual(
                agentProviderCatalog[provider].defaultLaunchArgs,
            );
            expect(defaultAgentProviderSettings[provider].hooks.enabled).toBe(true);
            expect(defaultAgentProviderSettings[provider].messaging.enabled).toBe(true);
            expect(defaultAgentProviderSettings[provider].naming.enabled).toBe(true);
            expect(defaultAgentProviderSettings[provider].recovery).toEqual({
                enabled: false,
                patterns: [],
                settleDelayMs: 1_000,
                continueDelayMs: 1_000,
            });
        }
    });

    it('starts each provider with its documented YOLO launch arguments', () => {
        expect(defaultAgentProviderSettings.claude.launch.args).toEqual([
            '--dangerously-skip-permissions',
        ]);
        expect(defaultAgentProviderSettings.codex.launch.args).toEqual([
            '--dangerously-bypass-approvals-and-sandbox',
        ]);
    });
});

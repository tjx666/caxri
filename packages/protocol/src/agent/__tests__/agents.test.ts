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
});

describe('agentProviderCatalog autonomy arguments', () => {
    it('names tokens the shipped launch arguments actually contain', () => {
        for (const provider of agentProviderIds) {
            const { autonomyArgs, defaultLaunchArgs } = agentProviderCatalog[provider];
            expect(autonomyArgs.length).toBeGreaterThan(0);
            for (const token of autonomyArgs) {
                expect(defaultLaunchArgs).toContain(token);
            }
        }
    });

    it('keeps Grok Build confinement out of the approval bypass', () => {
        expect(agentProviderCatalog.grok.autonomyArgs).toEqual(['--yolo']);
        expect(agentProviderCatalog.grok.autonomyArgs).not.toContain('--sandbox');
        expect(agentProviderCatalog.grok.autonomyArgs).not.toContain('workspace');
    });

    it('scopes each bypass to the provider that owns it', () => {
        expect(agentProviderCatalog.claude.autonomyArgs).toEqual([
            '--dangerously-skip-permissions',
        ]);
        expect(agentProviderCatalog.codex.autonomyArgs).toEqual([
            '--dangerously-bypass-approvals-and-sandbox',
        ]);
    });
});

describe('defaultAgentProviderSettings', () => {
    it('keeps unsupported Grok capabilities off', () => {
        expect(defaultAgentProviderSettings.grok.messaging.enabled).toBe(false);
        expect(agentProviderCatalog.grok.capabilities.nativeRename).toBe(false);
        expect(agentProviderCatalog.grok.capabilities.actions).toBe(false);
        expect(agentProviderCatalog.grok.capabilities.automaticSuspension).toBe(false);
    });
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
            expect(defaultAgentProviderSettings[provider].messaging.enabled).toBe(
                agentProviderCatalog[provider].capabilities.messaging,
            );
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
        expect(defaultAgentProviderSettings.grok.launch.args).toEqual(['--yolo']);
    });
});

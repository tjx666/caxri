import { isGlobMatch } from '@caxri/utils';
import { describe, expect, it } from 'vitest';

import { defaultAgentProviderSettings } from '../../agent/agents.js';
import {
    agentSessionInstructions,
    DEFAULT_AGENT_SESSION_INSTRUCTIONS,
    MAX_AGENT_SESSION_INSTRUCTIONS_LENGTH,
} from '../agent-session-instructions.js';
import {
    appSettingsFileSchema,
    appSettingsSchema,
    DEFAULT_FILES_EXCLUDE,
    defaultAppSettings,
} from '../settings-schema.js';
import { settingsSpec } from '../settings-spec.js';

describe('settings spec and schema agreement', () => {
    it('separates Chinese punctuation by default while preserving identifiers and custom choices', () => {
        const separators = appSettingsFileSchema.parse({})['terminal.wordSeparators'];
        for (const character of '，。；：！？、（）【】「」『』《》') {
            expect(separators).toContain(character);
        }
        expect(separators).not.toContain('_');
        expect(
            appSettingsFileSchema.parse({ 'terminal.wordSeparators': ' ,' })[
                'terminal.wordSeparators'
            ],
        ).toBe(' ,');
    });

    it("defaults Agent session instructions to Caxri's preset and keeps a user's text verbatim", () => {
        // `null` stands for the preset, so a profile keeps following a newer Caxri's text.
        expect(appSettingsFileSchema.parse({})['agents.sessionInstructions']).toBeNull();
        expect(agentSessionInstructions(null)).toBe(DEFAULT_AGENT_SESSION_INSTRUCTIONS);
        expect(agentSessionInstructions(' \n ')).toBeUndefined();
        for (const value of ['Line one.\n\nLine two.\n', '']) {
            expect(
                appSettingsFileSchema.parse({ 'agents.sessionInstructions': value })[
                    'agents.sessionInstructions'
                ],
            ).toBe(value);
        }
        expect(
            appSettingsSchema.safeParse({
                'agents.sessionInstructions': 'x'.repeat(MAX_AGENT_SESSION_INSTRUCTIONS_LENGTH + 1),
            }).success,
        ).toBe(false);
    });

    it('allows replacing Git diff exclusions without changing file-tree defaults', () => {
        expect(appSettingsFileSchema.parse({})['git.diffExclude']).toEqual({
            '**/*.test.*': true,
            '**/*.spec.*': true,
            '**/__tests__/**': true,
            '**/locales/**': true,
        });
        /**
         * The default is only worth shipping if it reaches the paths it was written for: a localized repository keeps
         * translations both at its root and inside a workspace package, and the source that drove the translation must
         * stay visible.
         */
        const shipped = appSettingsFileSchema.parse({})['git.diffExclude'];
        expect(isGlobMatch('locales/zh-CN/modelRuntime.json', shipped)).toBe(true);
        expect(isGlobMatch('packages/locales/src/default/modelRuntime.ts', shipped)).toBe(true);
        expect(isGlobMatch('packages/model-runtime/src/core/index.ts', shipped)).toBe(false);
        const parsed = appSettingsFileSchema.parse({ 'git.diffExclude': {} });
        expect(parsed['git.diffExclude']).toEqual({});
        expect(parsed['files.exclude']).toEqual(DEFAULT_FILES_EXCLUDE);
        expect(
            appSettingsSchema.safeParse({ 'git.diffExclude': { '**/tests/**': 'yes' } }).success,
        ).toBe(false);
    });

    it('covers exactly the spec keys', () => {
        const byCodePoint = (left: string, right: string): number => left.localeCompare(right);
        expect(Object.keys(appSettingsSchema.shape).toSorted(byCodePoint)).toEqual(
            settingsSpec.map((spec) => spec.key).toSorted(byCodePoint),
        );
        expect(Object.keys(appSettingsFileSchema.shape).toSorted(byCodePoint)).toEqual(
            Object.keys(appSettingsSchema.shape).toSorted(byCodePoint),
        );
    });

    it('fills every default from an empty file', () => {
        for (const spec of settingsSpec) {
            if (spec.kind === 'complex') continue;
            expect(defaultAppSettings[spec.key], spec.key).toEqual(spec.default);
        }
        expect(defaultAppSettings['files.exclude']).toEqual(DEFAULT_FILES_EXCLUDE);
        expect(defaultAppSettings['security.trustedDomains']).toEqual([]);
        expect(defaultAppSettings['terminal.referenceLinks']).toEqual([]);
        expect(defaultAppSettings['agents.providers']).toEqual(defaultAgentProviderSettings);
        // The lenient file parser lands on the same canonical defaults.
        expect(appSettingsFileSchema.parse({})).toEqual(defaultAppSettings);
    });

    it('ships the requested defaults while preserving explicit saved choices', () => {
        expect(defaultAppSettings['environmentMonitor.publicIpChanges']).toBe(true);
        expect(defaultAppSettings['environmentMonitor.proxyProtection']).toBe(false);
        expect(defaultAppSettings['environmentMonitor.locationChanges']).toBe(false);
        expect(defaultAppSettings['environmentMonitor.timeZoneMismatch']).toBe(false);
        expect(defaultAppSettings['environmentMonitor.checkUnavailable']).toBe(false);
        expect(defaultAppSettings['primarySidebar.autoCollapseProjects']).toBe('30m');
        expect(defaultAppSettings['terminal.scrollback']).toBe(8_000);
        expect(defaultAppSettings['terminal.gpuAcceleration']).toBe('on');
        expect(defaultAppSettings['terminal.osc52ClipboardWrite']).toBe(true);
        expect(defaultAppSettings['editor.fontFamily']).toBe(
            "'Fira Code', 'JetBrains Mono', 'Caxri JetBrains Mono', monospace",
        );
        expect(defaultAppSettings['editor.unfoldOnClickAfterEndOfLine']).toBe(true);
        expect(defaultAppSettings['agents.providers'].claude.launch.args).toEqual([
            '--dangerously-skip-permissions',
        ]);
        expect(defaultAppSettings['agents.providers'].codex.launch.args).toEqual([
            '--dangerously-bypass-approvals-and-sandbox',
        ]);

        const saved = appSettingsFileSchema.parse({
            'primarySidebar.autoCollapseProjects': 'off',
            'terminal.scrollback': 500,
            'terminal.gpuAcceleration': 'off',
            'terminal.osc52ClipboardWrite': false,
            'editor.fontFamily': null,
            'editor.unfoldOnClickAfterEndOfLine': false,
            'agents.providers': {
                claude: {
                    launch: { executable: 'claude', args: ['--profile', 'manual'] },
                },
            },
        });
        expect(saved['primarySidebar.autoCollapseProjects']).toBe('off');
        expect(saved['terminal.scrollback']).toBe(500);
        expect(saved['terminal.gpuAcceleration']).toBe('off');
        expect(saved['terminal.osc52ClipboardWrite']).toBe(false);
        expect(saved['editor.fontFamily']).toBeNull();
        expect(saved['editor.unfoldOnClickAfterEndOfLine']).toBe(false);
        expect(saved['agents.providers'].claude.launch.args).toEqual(['--profile', 'manual']);
        expect(saved['agents.providers'].codex.launch.args).toEqual(
            defaultAgentProviderSettings.codex.launch.args,
        );
    });

    it('enforces integer bounds from the spec', () => {
        for (const spec of settingsSpec) {
            if (spec.kind !== 'integer') continue;
            const isAccepted = (value: number) =>
                appSettingsSchema.safeParse({ [spec.key]: value }).success;
            expect(isAccepted(spec.min), spec.key).toBe(true);
            expect(isAccepted(spec.max), spec.key).toBe(true);
            expect(isAccepted(spec.min - 1), spec.key).toBe(false);
            expect(isAccepted(spec.max + 1), spec.key).toBe(false);
        }
    });

    it('accepts every declared enum option and rejects unknown values', () => {
        for (const spec of settingsSpec) {
            if (spec.kind !== 'enum') continue;
            for (const option of spec.options) {
                expect(
                    appSettingsSchema.safeParse({ [spec.key]: option.value }).success,
                    `${spec.key}=${option.value}`,
                ).toBe(true);
            }
            expect(appSettingsSchema.safeParse({ [spec.key]: 'not-a-real-option' }).success).toBe(
                false,
            );
            if ('nullLabel' in spec)
                expect(appSettingsSchema.safeParse({ [spec.key]: null }).success).toBe(true);
        }
    });

    it('keeps unique keys, non-empty titles, and known categories in the spec', () => {
        const keys = settingsSpec.map((spec) => spec.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const spec of settingsSpec) {
            expect(spec.title.length, spec.key).toBeGreaterThan(0);
        }
    });
});

describe('wire schema versus file schema', () => {
    it('keeps the wire schema strict: a partial provider record is a contract violation', () => {
        const onlyClaude = { claude: defaultAgentProviderSettings.claude };
        expect(appSettingsSchema.safeParse({ 'agents.providers': onlyClaude }).success).toBe(false);
        expect(
            appSettingsSchema.safeParse({ 'agents.providers': defaultAgentProviderSettings })
                .success,
        ).toBe(true);
    });

    it('fills omitted providers from defaults in the file parser', () => {
        const parsed = appSettingsFileSchema.parse({
            'agents.providers': {
                codex: {
                    ...defaultAgentProviderSettings.codex,
                    launch: { executable: 'my-codex', args: ['--fast'] },
                },
            },
        });
        expect(parsed['agents.providers'].codex.launch.executable).toBe('my-codex');
        expect(parsed['agents.providers'].claude).toEqual(defaultAgentProviderSettings.claude);
    });

    it('fills recovery defaults for an existing provider entry and bounds custom rules', () => {
        const existingProvider = {
            hooks: { enabled: false },
            launch: { executable: 'codex', args: [] },
            messaging: { enabled: true },
        };
        const parsed = appSettingsFileSchema.parse({
            'agents.providers': { codex: existingProvider },
        });
        expect(parsed['agents.providers'].codex.recovery).toEqual(
            defaultAgentProviderSettings.codex.recovery,
        );
        expect(
            appSettingsFileSchema.safeParse({
                'agents.providers': {
                    codex: {
                        ...existingProvider,
                        recovery: {
                            enabled: true,
                            patterns: ['API timeout', 'api TIMEOUT'],
                            settleDelayMs: 250,
                            continueDelayMs: 250,
                        },
                    },
                },
            }).success,
        ).toBe(false);
    });

    it('loads a settings file that still carries the removed automatic-naming key', () => {
        const parsed = appSettingsFileSchema.parse({
            'agents.providers': {
                codex: {
                    hooks: { enabled: false },
                    launch: { executable: 'codex', args: [] },
                    messaging: { enabled: true },
                    naming: { enabled: false },
                },
            },
        });
        expect(parsed['agents.providers'].codex).not.toHaveProperty('naming');
        expect(parsed['agents.providers'].codex.launch.executable).toBe('codex');
    });

    it('fills Agent Actions for an existing provider object and validates manual invocations', () => {
        const parsed = appSettingsFileSchema.parse({
            'agents.providers': {
                codex: {
                    hooks: { enabled: false },
                    launch: { executable: 'codex', args: [] },
                    messaging: { enabled: true },
                },
            },
        });
        expect(parsed['agents.providers'].codex.actions).toEqual({
            items: {},
            recent: { version: 1, invocations: [] },
        });

        const recentOnly = appSettingsFileSchema.parse({
            'agents.providers': {
                codex: { actions: { recent: { version: 1, invocations: ['/status'] } } },
            },
        });
        expect(recentOnly['agents.providers'].codex).toMatchObject({
            actions: { items: {}, recent: { version: 1, invocations: ['/status'] } },
            launch: {
                executable: 'codex',
                args: defaultAgentProviderSettings.codex.launch.args,
            },
        });

        const customized = appSettingsFileSchema.parse({
            'agents.providers': {
                codex: {
                    ...defaultAgentProviderSettings.codex,
                    actions: {
                        items: {
                            '/goal': { enabled: true, description: 'Manage a long-running goal' },
                            '$commit': { enabled: false },
                        },
                    },
                },
            },
        });
        expect(customized['agents.providers'].codex.actions.items).toMatchObject({
            '/goal': { enabled: true, description: 'Manage a long-running goal' },
            '$commit': { enabled: false },
        });
        expect(
            appSettingsFileSchema.safeParse({
                'agents.providers': {
                    codex: {
                        ...defaultAgentProviderSettings.codex,
                        actions: { items: { '/two words': { enabled: true } } },
                    },
                },
            }).success,
        ).toBe(false);

        const damagedRecent = appSettingsFileSchema.parse({
            'agents.providers': {
                codex: {
                    ...defaultAgentProviderSettings.codex,
                    actions: {
                        items: {},
                        recent: { version: 99, invocations: ['/status'] },
                    },
                },
            },
        });
        expect(damagedRecent['agents.providers'].codex.actions.recent).toEqual({
            version: 1,
            invocations: [],
        });
    });

    it('merges files.exclude on top of the shipped exclusions in the file parser only', () => {
        const parsed = appSettingsFileSchema.parse({
            'files.exclude': { '**/node_modules': true, '**/.git': false },
        });
        expect(parsed['files.exclude']).toEqual({
            ...DEFAULT_FILES_EXCLUDE,
            '**/node_modules': true,
            '**/.git': false,
        });
        const wire = appSettingsSchema.parse({ 'files.exclude': { '**/node_modules': true } });
        expect(wire['files.exclude']).toEqual({ '**/node_modules': true });
    });

    it('normalizes and deduplicates trusted-domain rules in the file parser', () => {
        const parsed = appSettingsFileSchema.parse({
            'security.trustedDomains': [
                'https://Example.com',
                'https://example.com',
                'https://other.dev',
            ],
        });
        expect(parsed['security.trustedDomains']).toEqual([
            'https://example.com',
            'https://other.dev',
        ]);
        expect(
            appSettingsFileSchema.safeParse({ 'security.trustedDomains': ['not a domain'] })
                .success,
        ).toBe(false);
    });

    it('normalizes and deduplicates trusted-folder rules in the file parser', () => {
        const parsed = appSettingsFileSchema.parse({
            'security.trustedFolders': [
                '/Users/me//.example/',
                '/Users/me/.example',
                '/Users/me/other',
            ],
        });
        expect(parsed['security.trustedFolders']).toEqual([
            '/Users/me/.example',
            '/Users/me/other',
        ]);
        const result = appSettingsFileSchema.safeParse({
            'security.trustedFolders': ['relative/path'],
        });
        expect(result.success).toBe(false);
        if (!result.success)
            expect(result.error.issues[0]?.path).toEqual(['security.trustedFolders', 0]);
    });

    it('bounds declarative Terminal reference links without granting executable actions', () => {
        const parsed = appSettingsFileSchema.parse({
            'terminal.referenceLinks': [
                {
                    prefix: 'TASK-',
                    title: 'Linear issue',
                    url: 'https://linear.app/example/issue/<num>',
                },
            ],
        });
        expect(parsed['terminal.referenceLinks']).toEqual([
            {
                alphanumeric: false,
                ignoreCase: false,
                prefix: 'TASK-',
                title: 'Linear issue',
                url: 'https://linear.app/example/issue/<num>',
            },
        ]);

        for (const invalid of [
            { prefix: 'TASK-', url: 'https://linear.app/example/issue/no-placeholder' },
            { prefix: 'TASK-', url: 'javascript:alert(<num>)' },
            { prefix: 'TASK-', url: 'https://user:secret@example.com/<num>' },
            { prefix: 'TASK-', url: 'https://example.com/<num>/<num>' },
            { prefix: '', url: 'https://example.com/<num>' },
        ])
            expect(
                appSettingsFileSchema.safeParse({ 'terminal.referenceLinks': [invalid] }).success,
            ).toBe(false);

        expect(
            appSettingsFileSchema.safeParse({
                'terminal.referenceLinks': [
                    { prefix: 'TASK-', url: 'https://one.example/<num>', ignoreCase: true },
                    { prefix: 'task-', url: 'https://two.example/<num>' },
                ],
            }).success,
        ).toBe(false);
        expect(
            appSettingsFileSchema.safeParse({
                'terminal.referenceLinks': [
                    { prefix: 'FOO-', url: 'https://one.example/<num>' },
                    { prefix: 'FOO-1', url: 'https://two.example/<num>' },
                ],
            }).success,
        ).toBe(false);
        expect(
            appSettingsFileSchema.safeParse({
                'terminal.referenceLinks': [
                    {
                        prefix: 'TASK-',
                        url: 'https://example.com/<num>',
                        command: 'open-anything',
                    },
                ],
            }).success,
        ).toBe(false);
    });
});

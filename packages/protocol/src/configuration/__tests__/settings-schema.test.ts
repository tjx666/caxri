import { describe, expect, it } from 'vitest';

import { defaultAgentProviderSettings } from '../../agent/agents.js';
import {
    appSettingsFileSchema,
    appSettingsSchema,
    DEFAULT_FILES_EXCLUDE,
    defaultAppSettings,
} from '../settings-schema.js';
import { settingsSpec } from '../settings-spec.js';

describe('settings spec and schema agreement', () => {
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
        expect(defaultAppSettings['agents.providers']).toEqual(defaultAgentProviderSettings);
        // The lenient file parser lands on the same canonical defaults.
        expect(appSettingsFileSchema.parse({})).toEqual(defaultAppSettings);
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
        expect(parsed['agents.providers'].codex.actions).toEqual({ items: {} });

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
});

import { expect, it } from 'vitest';
import { ZodError } from 'zod';

import { agentDelegationSettingsSchema } from '../../agent-delegation-settings.js';
import {
    convertDianjiangConfig,
    diffDelegationSettings,
    mergeDelegationSettings,
} from '../agent-delegation-import.js';
import {
    delegationImportIssues,
    formatDelegationImportIssues,
    sanitizeDelegationIssuePath,
} from '../agent-delegation-import-issues.js';

const config = {
    maxDepth: 2,
    agents: [
        {
            name: 'review',
            harness: 'claude',
            model: 'opus',
            effort: 'xhigh',
            useWhen: 'Review a change',
            instructions: 'Synthetic private instructions',
        },
    ],
    callers: {
        claude: {
            agents: { review: { harness: 'codex', useWhen: 'Independent review' } },
            prepend: 'Synthetic caller instructions',
            append: 'Synthetic closing instructions',
        },
    },
};

it('preserves private instructions and whole caller binding replacements', () => {
    const result = convertDianjiangConfig(config);
    expect(result.presets[0]).toMatchObject({
        name: 'review',
        provider: 'claude',
        model: 'opus',
        effort: 'xhigh',
        instructions: 'Synthetic private instructions',
    });
    expect(result.callers.claude?.presets?.review).toEqual({
        provider: 'codex',
        useWhen: 'Independent review',
    });
    expect(result.callers.claude?.prepend).toBe(config.callers.claude.prepend);
    expect(
        convertDianjiangConfig({ ...config, callers: { grok: { exclude: ['review'] } } }).callers
            .grok?.exclude,
    ).toEqual(['review']);
});

it.each([
    { agents: [{ ...config.agents[0], name: 'Invalid Name' }] },
    { agents: [{ ...config.agents[0], harness: 'grok', effort: 'xhigh' }] },
    { agents: [{ ...config.agents[0], useWhen: 'x'.repeat(2049) }] },
    { agents: [{ ...config.agents[0], instructions: 'x'.repeat(8193) }] },
    {
        agents: Array.from({ length: 33 }, (_, index) => ({
            ...config.agents[0],
            name: `preset-${index}`,
        })),
    },
    { callers: { claude: { exclude: ['unknown'] } } },
    { callers: { claude: { exclude: ['review'], agents: { review: { harness: 'codex' } } } } },
    { maxDepth: 9 },
    { unknown: true },
])('rejects incompatible source semantics: %j', (changes) => {
    expect(() => convertDianjiangConfig({ ...config, ...changes })).toThrow();
});

const SENTINEL = 'private-sentinel';

function issuesFor(input: unknown): string {
    try {
        convertDianjiangConfig(input);
    } catch (error) {
        if (error instanceof ZodError) {
            const issues = delegationImportIssues(error, 'source');
            return JSON.stringify(issues) + formatDelegationImportIssues(issues);
        }
        throw error;
    }
    throw new Error('expected a rejection');
}

it.each([
    { agents: [{ ...config.agents[0], [SENTINEL]: 1 }] },
    { [`${SENTINEL}-top`]: 1 },
    { callers: { [SENTINEL]: { prepend: 'x' } } },
    { callers: { claude: { agents: { 'Private Sentinel': { harness: 'claude' } } } } },
    { callers: { claude: { agents: { [SENTINEL]: { harness: 'nope', model: 7 } } } } },
    { agents: [{ ...config.agents[0], model: 5, instructions: SENTINEL.repeat(2000) }] },
])('never echoes input text in an issue: %j', (changes) => {
    expect(issuesFor({ ...config, ...changes })).not.toMatch(/sentinel|Sentinel|Synthetic/u);
});

it('masks unknown path segments by schema context', () => {
    expect(
        sanitizeDelegationIssuePath(
            ['callers', SENTINEL, 'presets', 'review'],
            new Set(['review']),
        ),
    ).toBe('callers.*.presets.review');
    expect(
        sanitizeDelegationIssuePath(
            ['callers', 'claude', 'agents', SENTINEL, 'harness'],
            new Set(['review']),
        ),
    ).toBe('callers.claude.agents.*.harness');
    expect(sanitizeDelegationIssuePath(['agents', 2, 'whatever'])).toBe('agents.2.*');
});

const current = agentDelegationSettingsSchema.parse({
    maxDepth: 3,
    readChildChat: false,
    approval: false,
    presets: [
        { name: 'keep-me', provider: 'claude', useWhen: 'Keep', model: 'opus', effort: 'low' },
        { name: 'only-here', provider: 'codex', useWhen: 'Current only' },
    ],
    callers: { grok: { prepend: 'current' } },
});
const imported = convertDianjiangConfig({
    maxDepth: 5,
    agents: [
        { name: 'keep-me', harness: 'claude', useWhen: 'Keep' },
        { name: 'review', harness: 'grok', useWhen: 'Review' },
    ],
    callers: { claude: { prepend: 'file' } },
});

it('does not reset readChildChat or approval when converting', () => {
    expect(imported).not.toHaveProperty('readChildChat');
    expect(imported).not.toHaveProperty('approval');
});

it('merges by name, keeps whole tuples, current-only entries, maxDepth and switches', () => {
    const merged = mergeDelegationSettings(current, imported, 'merge');
    expect(merged.ok && merged.value).toMatchObject({
        maxDepth: 3,
        readChildChat: false,
        approval: false,
        callers: { grok: { prepend: 'current' }, claude: { prepend: 'file' } },
    });
    if (!merged.ok) throw new Error('unreachable');
    expect(merged.value.presets.map((preset) => preset.name)).toEqual([
        'keep-me',
        'only-here',
        'review',
    ]);
    // The tuple is replaced whole: the file leaves model and effort out, so the old values are gone.
    expect(merged.value.presets[0]).not.toHaveProperty('model');
    expect(diffDelegationSettings(current, merged.value)).toEqual({
        presets: {
            added: ['review'],
            changed: [{ name: 'keep-me', fields: ['model', 'effort'] }],
            removed: [],
            unchanged: ['only-here'],
        },
        callers: { added: ['claude'], removed: [], changed: [] },
        settings: [],
    });
});

it('replace adopts the file presets, callers and maxDepth', () => {
    const replaced = mergeDelegationSettings(current, imported, 'replace');
    if (!replaced.ok) throw new Error('unreachable');
    expect(replaced.value).toMatchObject({ maxDepth: 5, readChildChat: false });
    expect(diffDelegationSettings(current, replaced.value)).toMatchObject({
        presets: { removed: ['only-here'] },
        callers: { removed: ['grok'], added: ['claude'] },
        settings: ['maxDepth'],
    });
});

it('reports a merge that exceeds the preset cap at the result stage', () => {
    const full = agentDelegationSettingsSchema.parse({
        presets: Array.from({ length: 32 }, (_, index) => ({
            name: `p-${index}`,
            provider: 'claude',
            useWhen: 'Use',
        })),
    });
    const merge = mergeDelegationSettings(full, imported, 'merge');
    expect(merge).toEqual({
        ok: false,
        issues: [expect.objectContaining({ stage: 'result', reason: 'too_many' })],
    });
});

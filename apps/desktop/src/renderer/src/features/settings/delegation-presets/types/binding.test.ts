import type { AppSettings } from '@caxri/protocol';
import { agentDelegationSettingsSchema } from '@caxri/protocol';
import { expect, it } from 'vitest';

import {
    changeBindingEffort,
    changeBindingModel,
    changeBindingProvider,
    setTypeBinding,
    supportedEfforts,
} from './binding';

type Delegation = AppSettings['agents.delegation'];

const base: Delegation = agentDelegationSettingsSchema.parse({
    maxDepth: 4,
    presets: [{ name: 'quick', provider: 'codex', useWhen: 'always' }],
    types: { review: { provider: 'claude', effort: 'max' } },
    callers: { claude: { prepend: 'hello', exclude: [] } },
    approval: false,
});

it('lists only the efforts the Agent accepts', () => {
    expect(supportedEfforts('grok', undefined)).toEqual(['low', 'medium', 'high']);
    expect(supportedEfforts('claude', undefined)).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
    ]);
    expect(supportedEfforts('codex', 'gpt-5.5')).toEqual(['low', 'medium', 'high', 'xhigh']);
});

it('clears the model and an unsupported effort when the Agent changes', () => {
    const next = changeBindingProvider(
        { provider: 'claude', model: 'opus', effort: 'max' },
        'grok',
    );
    expect(next).toEqual({ provider: 'grok' });
    expect(changeBindingProvider({ provider: 'claude', effort: 'high' }, 'codex')).toEqual({
        provider: 'codex',
        effort: 'high',
    });
});

it('treats blank model text as the default model and drops an effort the model rejects', () => {
    expect(changeBindingModel({ provider: 'codex', model: 'x' }, '  ')).toEqual({
        provider: 'codex',
    });
    expect(changeBindingModel({ provider: 'codex', effort: 'max' }, ' gpt-5.5 ')).toEqual({
        provider: 'codex',
        model: 'gpt-5.5',
    });
});

it('changes and clears the effort', () => {
    expect(changeBindingEffort({ provider: 'claude' }, 'high')).toEqual({
        provider: 'claude',
        effort: 'high',
    });
    expect(changeBindingEffort({ provider: 'claude', effort: 'high' }, undefined)).toEqual({
        provider: 'claude',
    });
    expect(changeBindingEffort({ provider: 'grok' }, 'max')).toEqual({ provider: 'grok' });
});

it('writes a base binding and keeps every other field', () => {
    const next = setTypeBinding(base, 'x-search', {}, { provider: 'grok' });
    expect(next.types).toEqual({ 'review': base.types.review, 'x-search': { provider: 'grok' } });
    expect(next.presets).toBe(base.presets);
    expect(next.callers).toBe(base.callers);
    expect(next.approval).toBe(false);
    expect(agentDelegationSettingsSchema.safeParse(next).success).toBe(true);
});

it('removes a base binding', () => {
    expect(setTypeBinding(base, 'review', {}, undefined).types).toEqual({});
});

it('writes a caller override without touching the caller’s other fields', () => {
    const next = setTypeBinding(base, 'review', { caller: 'claude' }, { provider: 'codex' });
    expect(next.callers.claude).toEqual({
        prepend: 'hello',
        exclude: [],
        types: { review: { provider: 'codex' } },
    });
    expect(next.types).toBe(base.types);
});

it('drops a caller left empty when its last override is removed', () => {
    const withOverride = setTypeBinding(
        { ...base, callers: {} },
        'review',
        { caller: 'codex' },
        { provider: 'claude' },
    );
    expect(withOverride.callers.codex).toEqual({ types: { review: { provider: 'claude' } } });
    expect(setTypeBinding(withOverride, 'review', { caller: 'codex' }, undefined).callers).toEqual(
        {},
    );
    expect(setTypeBinding(base, 'review', { caller: 'claude' }, undefined).callers.claude).toEqual({
        prepend: 'hello',
        exclude: [],
    });
});

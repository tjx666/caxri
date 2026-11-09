import type { AgentChatDefaults, AgentChatModel } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    chatDefaultEffortOptions,
    chatDefaultModelChange,
    chatDefaultModelOptions,
    chatDefaultModelValue,
    chatDefaultOverrideText,
} from './chat-defaults-options';

const models: AgentChatModel[] = [
    {
        id: 'default',
        displayName: 'Default (recommended)',
        efforts: ['low', 'medium', 'high', 'max'],
    },
    {
        id: 'opus',
        resolvedId: 'claude-opus',
        displayName: 'Opus',
        efforts: ['low', 'high', 'xhigh', 'max'],
    },
    { id: 'haiku', displayName: 'Haiku', efforts: [] },
];

const claude: AgentChatDefaults = {
    provider: 'claude',
    overrides: [],
    models,
    builtInModel: 'default',
    file: '~/.claude/settings.json',
};

describe('chatDefaultModelValue and chatDefaultModelOptions', () => {
    it('reads a saved full model as the alias it resolves from, and the default alias as no choice', () => {
        expect(chatDefaultModelValue({ ...claude, model: 'claude-opus' })).toBe('opus');
        expect(chatDefaultModelValue({ ...claude, model: 'default' })).toBeUndefined();
        expect(chatDefaultModelValue(claude)).toBeUndefined();
    });

    it('offers the listed models without the default alias, and keeps an unlisted saved model', () => {
        expect(chatDefaultModelOptions(claude)).toEqual([
            { value: 'opus', label: 'Opus' },
            { value: 'haiku', label: 'Haiku' },
        ]);
        expect(chatDefaultModelOptions({ ...claude, model: 'sonnet-legacy' }).at(-1)).toEqual({
            value: 'sonnet-legacy',
            label: 'sonnet-legacy',
        });
    });
});

describe('chatDefaultEffortOptions', () => {
    it('offers the chosen model’s efforts, or the built-in model’s, without Claude Code’s unsaved max', () => {
        expect(chatDefaultEffortOptions({ ...claude, model: 'opus' })).toEqual([
            'low',
            'high',
            'xhigh',
        ]);
        expect(chatDefaultEffortOptions(claude)).toEqual(['low', 'medium', 'high']);
        expect(chatDefaultEffortOptions({ ...claude, provider: 'codex', model: 'opus' })).toContain(
            'max',
        );
    });

    it('keeps a saved effort the model does not list, and asks for free text with nothing listed', () => {
        expect(chatDefaultEffortOptions({ ...claude, model: 'opus', effort: 'medium' })).toEqual([
            'low',
            'high',
            'xhigh',
            'medium',
        ]);
        expect(chatDefaultEffortOptions({ ...claude, models: [] })).toBeUndefined();
    });
});

describe('chatDefaultModelChange', () => {
    it('clears an effort the new model does not accept and keeps one it does', () => {
        expect(chatDefaultModelChange({ ...claude, effort: 'medium' }, 'opus')).toEqual({
            model: 'opus',
            effort: null,
        });
        expect(chatDefaultModelChange({ ...claude, effort: 'high' }, 'opus')).toEqual({
            model: 'opus',
        });
        expect(chatDefaultModelChange({ ...claude, effort: 'xhigh' }, null)).toEqual({
            model: null,
            effort: null,
        });
        expect(chatDefaultModelChange({ ...claude, effort: 'high' }, 'unlisted')).toEqual({
            model: 'unlisted',
        });
    });
});

describe('chatDefaultOverrideText', () => {
    it('names the layer that decides a key and its value', () => {
        const overrides = [
            { key: 'effort', source: 'environment', value: 'xhigh' },
            { key: 'ultracode', source: 'launchArgs', value: 'true' },
        ] as const;
        expect(chatDefaultOverrideText(translate, overrides, 'model')).toBeUndefined();
        expect(chatDefaultOverrideText(translate, overrides, 'effort')).toBe(
            'An environment variable sets Extra high, so new Chats use that instead.',
        );
        expect(chatDefaultOverrideText(translate, overrides, 'ultracode')).toBe(
            'Initial arguments set Ultracode on, so new Chats use that instead.',
        );
    });
});

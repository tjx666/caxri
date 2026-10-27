import type { StringSettingSpec } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { multilineStringValue } from '../string-control-values';

const base: StringSettingSpec = {
    kind: 'string',
    key: 'agents.sessionInstructions',
    title: 'Session instructions',
    category: 'agents',
    nullable: true,
    multiline: true,
    maxLength: 4_000,
    default: null,
};

describe('multilineStringValue', () => {
    const withPreset = { ...base, preset: 'Use the Caxri CLI.' };

    it('stores the preset as null so the field keeps following it', () => {
        expect(multilineStringValue(withPreset, 'Use the Caxri CLI.')).toBeNull();
    });

    it('keeps edited and emptied text verbatim for a preset-backed field', () => {
        expect(multilineStringValue(withPreset, 'Line one.\n\nLine two.\n')).toBe(
            'Line one.\n\nLine two.\n',
        );
        expect(multilineStringValue(withPreset, '')).toBe('');
    });

    it('stores an empty nullable field without a preset as null', () => {
        expect(multilineStringValue(base, '')).toBeNull();
        expect(multilineStringValue({ ...base, nullable: false }, '')).toBe('');
    });
});

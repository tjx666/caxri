import type { StringSettingSpec } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { multilineStringValue } from '../string-control-values';

const base: StringSettingSpec = {
    kind: 'string',
    key: 'agents.sessionInstructions.custom',
    title: 'Custom Session instructions',
    category: 'agents',
    nullable: true,
    multiline: true,
    maxLength: 4_000,
    default: null,
};

describe('multilineStringValue', () => {
    it('keeps typed text verbatim, line breaks included', () => {
        expect(multilineStringValue(base, 'Line one.\n\nLine two.\n')).toBe(
            'Line one.\n\nLine two.\n',
        );
    });

    it('stores an empty nullable field as null', () => {
        expect(multilineStringValue(base, '')).toBeNull();
        expect(multilineStringValue({ ...base, nullable: false }, '')).toBe('');
    });
});

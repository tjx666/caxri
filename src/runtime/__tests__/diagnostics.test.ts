import { describe, expect, it } from 'vitest';

import { normalizeHome, redactSecrets } from '../diagnostics';
import { redactLogValue } from '../logger';

describe('diagnostics redaction', () => {
    it('redacts secret-like keys and values', () => {
        const redacted = redactSecrets({
            apiKey: 'sensitive',
            nested: { password: 'hidden' },
            header: 'Bearer abc.def.ghi',
        });
        expect(redacted).toEqual({
            apiKey: '[REDACTED]',
            nested: { password: '[REDACTED]' },
            header: '[REDACTED]',
        });
    });

    it('normalizes home directory paths', () => {
        expect(normalizeHome(`${process.env.HOME}/code/project`)).toBe('$HOME/code/project');
    });

    it('redacts secrets embedded in log error strings before they reach diagnostics', () => {
        expect(
            redactLogValue(`${process.env.HOME}/project token=private-value Bearer abc.def.ghi`),
        ).toBe('$HOME/project token=[REDACTED] [REDACTED]');
    });
});

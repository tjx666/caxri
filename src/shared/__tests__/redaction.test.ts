import { describe, expect, it } from 'vitest';

import { redactSecretText } from '../redaction';

describe('secret redaction', () => {
    it('redacts quoted JSON secret fields without breaking their structure', () => {
        const source = JSON.stringify({
            token: 'v_token_7x',
            api_key: 'v_key_7x',
            password: 'v_pass_7x',
            authorization: 'v_auth_7x',
            message: 'keep me',
        });
        const redacted = redactSecretText(source);

        expect(JSON.parse(redacted)).toEqual({
            token: '[REDACTED]',
            api_key: '[REDACTED]',
            password: '[REDACTED]',
            authorization: '[REDACTED]',
            message: 'keep me',
        });
        expect(redacted).not.toContain('v_token_7x');
        expect(redacted).not.toContain('v_key_7x');
        expect(redacted).not.toContain('v_pass_7x');
        expect(redacted).not.toContain('v_auth_7x');
    });

    it('keeps unquoted assignment redaction behavior', () => {
        expect(redactSecretText('token=private-value')).toBe('token=[REDACTED]');
    });
});

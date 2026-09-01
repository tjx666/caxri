import { describe, expect, it } from 'vitest';

import { credentialKindsInText, evidenceManifestSha256 } from '../mobile-acceptance-privacy';

describe('mobile Acceptance evidence privacy', () => {
    it('rejects credential-bearing text without reporting the credential value', () => {
        expect(credentialKindsInText('open caxri://pair?secret=do-not-copy')).toEqual([
            'pairing-uri',
            'pairing-secret',
        ]);
        expect(credentialKindsInText('Authorization: Bearer abcdefghijklmnop')).toEqual([
            'bearer-token',
        ]);
        expect(credentialKindsInText('-----BEGIN PRIVATE KEY-----')).toEqual(['private-key']);
    });

    it('accepts allowlisted product observations', () => {
        expect(
            credentialKindsInText(
                'Paired devices: 1; project grants: 1; capture stopped before pairing creation.',
            ),
        ).toEqual([]);
    });

    it('binds the same artifact set independently of discovery order', () => {
        const entries = [
            { bytes: 2, path: 'assets/b.png', sha256: 'b'.repeat(64) },
            { bytes: 1, path: 'assets/a.txt', sha256: 'a'.repeat(64) },
        ];
        expect(evidenceManifestSha256(entries)).toBe(evidenceManifestSha256(entries.toReversed()));
        expect(evidenceManifestSha256(entries)).toMatch(/^[0-9a-f]{64}$/u);
    });
});

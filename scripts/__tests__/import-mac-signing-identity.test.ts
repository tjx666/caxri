import { describe, expect, it } from 'vitest';

import { parseCodeSigningIdentities, selectSigningIdentity } from '../import-mac-signing-identity';

const RELEASE_SHA1 = 'E5C99598D52C791CBF4269329B952A71A6987F49';

/**
 * `security find-identity -p codesigning` lists a matching identity under both sections and marks a self-signed one
 * untrusted.
 */
const LISTING = `
Policy: Code Signing
  Matching identities
  1) ${RELEASE_SHA1} "Caxri Release Signing" (CSSMERR_TP_NOT_TRUSTED)
     1 identities found

  Valid identities only
     0 valid identities found
`;

describe('import-mac-signing-identity', () => {
    it('reads untrusted self-signed identities from the find-identity listing', () => {
        expect(parseCodeSigningIdentities(LISTING)).toEqual([
            { name: 'Caxri Release Signing', sha1: RELEASE_SHA1 },
        ]);
        expect(parseCodeSigningIdentities('     0 identities found\n')).toEqual([]);
    });

    it('accepts only the single pinned release certificate', () => {
        const identities = parseCodeSigningIdentities(LISTING);
        expect(selectSigningIdentity(identities, RELEASE_SHA1.toLowerCase())).toEqual({
            name: 'Caxri Release Signing',
            sha1: RELEASE_SHA1,
        });
        // The rehearsal's throwaway certificate has no pin.
        expect(selectSigningIdentity(identities)).toMatchObject({ sha1: RELEASE_SHA1 });
        expect(() =>
            selectSigningIdentity(identities, '1111111111111111111111111111111111111111'),
        ).toThrow('is not the pinned certificate');
        expect(() => selectSigningIdentity([])).toThrow(
            'Expected one code signing identity, found 0.',
        );
    });
});

import { describe, expect, it } from 'vitest';

import { shareExtensionInfoPlist } from '../build-share-extension';

describe('shareExtensionInfoPlist', () => {
    it('stamps the app version into every version placeholder', () => {
        expect(
            shareExtensionInfoPlist(
                '<string>$(VERSION)</string><string>$(VERSION)</string>',
                '0.0.141',
            ),
        ).toBe('<string>0.0.141</string><string>0.0.141</string>');
    });

    it('refuses a version the system cannot compare', () => {
        expect(() => shareExtensionInfoPlist('$(VERSION)', 'dev')).toThrow(
            /Unexpected app version/,
        );
    });
});

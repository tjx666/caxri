import { describe, expect, it } from 'vitest';

import { caxriReleaseUrl, mobileReleaseApkUrl } from '../mobile-update-contract';

describe('Caxri release URLs', () => {
    it("opens the installed version's release, or the latest one when the version is unknown", () => {
        expect(caxriReleaseUrl('0.0.146')).toBe(
            'https://github.com/tjx666/caxri/releases/tag/v0.0.146',
        );
        expect(caxriReleaseUrl(undefined)).toBe('https://github.com/tjx666/caxri/releases/latest');
    });

    it('downloads the APK from the same repository', () => {
        expect(mobileReleaseApkUrl('0.0.146')).toBe(
            'https://github.com/tjx666/caxri/releases/download/v0.0.146/Caxri-Mobile-0.0.146-android-arm64.apk',
        );
    });
});

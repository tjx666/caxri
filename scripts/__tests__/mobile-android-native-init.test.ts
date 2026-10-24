import { describe, expect, it } from 'vitest';

import {
    androidNativeInitLogcatArguments,
    findAndroidNativeInitFailures,
    parseAndroidPackageUid,
} from '../mobile-android-native-init';

describe('Android native init guard', () => {
    it('reports each ML Kit registrar that failed to instantiate once', () => {
        const logcat = [
            'W ComponentDiscovery: Invalid component registrar.',
            'W ComponentDiscovery: k92: Could not instantiate com.google.mlkit.vision.barcode.internal.BarcodeRegistrar',
            'W ComponentDiscovery: Could not instantiate com.google.mlkit.common.internal.CommonComponentRegistrar',
            'W ComponentDiscovery: k92: Could not instantiate com.google.mlkit.vision.barcode.internal.BarcodeRegistrar',
        ].join('\n');
        expect(findAndroidNativeInitFailures(logcat)).toEqual([
            'com.google.mlkit.vision.barcode.internal.BarcodeRegistrar',
            'com.google.mlkit.common.internal.CommonComponentRegistrar',
        ]);
    });

    it('passes a clean log', () => {
        expect(findAndroidNativeInitFailures('--------- beginning of main\n')).toEqual([]);
    });

    it('reads the package uid and scopes logcat to it', () => {
        expect(parseAndroidPackageUid('package:com.caxri.mobile uid:10213\n')).toBe(10_213);
        expect(() => parseAndroidPackageUid('')).toThrow('Android package uid is unavailable');
        expect(androidNativeInitLogcatArguments(10_213)).toEqual([
            'logcat',
            '-d',
            '--uid=10213',
            '-s',
            'ComponentDiscovery:W',
        ]);
    });
});

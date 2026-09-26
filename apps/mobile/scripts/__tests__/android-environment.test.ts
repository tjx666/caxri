import { describe, expect, it } from 'vitest';

import {
    discoverGradleManagedJavaHomes,
    parseAndroidBuildRequest,
    parseJavaMajorVersion,
    parseReactNativeBuildToolsVersion,
    parseReactNativeCompileSdkVersion,
    parseReactNativeNdkVersion,
    resolveAndroidBuildPaths,
    resolveAndroidEnvironment,
} from '../android-environment';

const isJava17 = () => true;

describe('resolveAndroidBuildPaths', () => {
    it('anchors Expo to the mobile workspace regardless of the caller working directory', () => {
        expect(resolveAndroidBuildPaths('/repo/apps/mobile/scripts')).toEqual({
            expoPath: '/repo/apps/mobile/node_modules/.bin/expo',
            mobileRoot: '/repo/apps/mobile',
            reactNativeVersionCatalogPath:
                '/repo/apps/mobile/node_modules/react-native/gradle/libs.versions.toml',
        });
    });
});

describe('parseAndroidBuildRequest', () => {
    it('uses Gradle for a release build without selecting or opening a device', () => {
        expect(parseAndroidBuildRequest(['--', '--build-only', '--variant', 'release'])).toEqual({
            buildOnly: true,
            expoArguments: ['--variant', 'release'],
            gradleArguments: [],
            gradleTask: 'app:assembleRelease',
        });
    });

    it('passes only bounded release optimization flags to Gradle', () => {
        expect(
            parseAndroidBuildRequest([
                '--build-only',
                '--variant',
                'release',
                '--abi',
                'arm64-v8a',
                '--optimize',
            ]),
        ).toEqual({
            buildOnly: true,
            expoArguments: ['--variant', 'release'],
            gradleArguments: [
                '-PreactNativeArchitectures=arm64-v8a',
                '-Pandroid.enableMinifyInReleaseBuilds=true',
                '-Pandroid.enableShrinkResourcesInReleaseBuilds=true',
            ],
            gradleTask: 'app:assembleRelease',
        });
        expect(() => parseAndroidBuildRequest(['--build-only', '--abi', 'arm32'])).toThrow();
        expect(() => parseAndroidBuildRequest(['--abi', 'arm64-v8a'])).toThrow();
        expect(
            parseAndroidBuildRequest(['--build-only', '--variant', 'release', '--minify'])
                .gradleArguments,
        ).toEqual(['-Pandroid.enableMinifyInReleaseBuilds=true']);
    });

    it('rejects Expo-only options in build-only mode', () => {
        expect(() =>
            parseAndroidBuildRequest(['--build-only', '--variant', 'release', '--device', 'Pixel']),
        ).toThrow('Android build-only accepts only --variant, --abi, --minify, and --optimize');
    });
});

describe('resolveAndroidEnvironment', () => {
    it('prefers valid explicit roots without printing or modifying them', () => {
        const existing = new Set([
            '/jdk/bin/java',
            '/sdk/platform-tools/adb',
            '/sdk/build-tools/35.0.0/source.properties',
            '/sdk/build-tools/36.0.0/source.properties',
            '/sdk/cmake/3.22.1/bin/cmake',
            '/sdk/cmake/3.22.1/bin/ninja',
            '/sdk/ndk/27.1.12297006/source.properties',
            '/sdk/platforms/android-36/android.jar',
        ]);
        expect(
            resolveAndroidEnvironment({
                environment: { ANDROID_SDK_ROOT: '/sdk', JAVA_HOME: '/jdk' },
                isPathPresent: (path) => existing.has(path),
                isCompatibleJavaHome: isJava17,
                requiredBuildToolsVersions: ['35.0.0', '36.0.0'],
                requiredCmakeVersions: ['3.22.1'],
                requiredNdkVersion: '27.1.12297006',
                requiredPlatformVersions: ['36'],
            }),
        ).toEqual({ javaHome: '/jdk', sdkRoot: '/sdk' });
    });

    it('falls back to the standard macOS Android SDK location', () => {
        const existing = new Set([
            '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java',
            '/Users/example/Library/Android/sdk/platform-tools/adb',
            '/Users/example/Library/Android/sdk/build-tools/35.0.0/source.properties',
            '/Users/example/Library/Android/sdk/build-tools/36.0.0/source.properties',
            '/Users/example/Library/Android/sdk/cmake/3.22.1/bin/cmake',
            '/Users/example/Library/Android/sdk/cmake/3.22.1/bin/ninja',
            '/Users/example/Library/Android/sdk/ndk/27.1.12297006/source.properties',
            '/Users/example/Library/Android/sdk/platforms/android-36/android.jar',
        ]);
        expect(
            resolveAndroidEnvironment({
                environment: {},
                homeDirectory: '/Users/example',
                isPathPresent: (path) => existing.has(path),
                isCompatibleJavaHome: isJava17,
                requiredBuildToolsVersions: ['35.0.0', '36.0.0'],
                requiredCmakeVersions: ['3.22.1'],
                requiredNdkVersion: '27.1.12297006',
                requiredPlatformVersions: ['36'],
            }),
        ).toEqual({
            javaHome: '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
            sdkRoot: '/Users/example/Library/Android/sdk',
        });
    });

    it('fails before Gradle can download a missing React Native NDK', () => {
        const existing = new Set(['/jdk/bin/java', '/sdk/platform-tools/adb']);
        expect(() =>
            resolveAndroidEnvironment({
                environment: { ANDROID_SDK_ROOT: '/sdk', JAVA_HOME: '/jdk' },
                isPathPresent: (path) => existing.has(path),
                isCompatibleJavaHome: isJava17,
                requiredBuildToolsVersions: [],
                requiredCmakeVersions: [],
                requiredNdkVersion: '27.1.12297006',
                requiredPlatformVersions: [],
            }),
        ).toThrow('Android build requires NDK (Side by side) 27.1.12297006');
    });

    it('fails before Gradle when the Android Gradle Plugin default Build Tools are missing', () => {
        const existing = new Set([
            '/jdk/bin/java',
            '/sdk/platform-tools/adb',
            '/sdk/build-tools/36.0.0/source.properties',
            '/sdk/ndk/27.1.12297006/source.properties',
        ]);
        expect(() =>
            resolveAndroidEnvironment({
                environment: { ANDROID_SDK_ROOT: '/sdk', JAVA_HOME: '/jdk' },
                isPathPresent: (path) => existing.has(path),
                isCompatibleJavaHome: isJava17,
                requiredBuildToolsVersions: ['35.0.0', '36.0.0'],
                requiredCmakeVersions: [],
                requiredNdkVersion: '27.1.12297006',
                requiredPlatformVersions: [],
            }),
        ).toThrow('Android build requires SDK Build Tools 35.0.0');
    });

    it('fails before Gradle can download a missing SDK platform', () => {
        const existing = new Set([
            '/jdk/bin/java',
            '/sdk/platform-tools/adb',
            '/sdk/ndk/27.1.12297006/source.properties',
        ]);
        expect(() =>
            resolveAndroidEnvironment({
                environment: { ANDROID_SDK_ROOT: '/sdk', JAVA_HOME: '/jdk' },
                isPathPresent: (path) => existing.has(path),
                isCompatibleJavaHome: isJava17,
                requiredBuildToolsVersions: [],
                requiredCmakeVersions: [],
                requiredNdkVersion: '27.1.12297006',
                requiredPlatformVersions: ['36'],
            }),
        ).toThrow('Android build requires SDK Platform 36');
    });

    it('fails before Gradle can download a missing CMake toolchain', () => {
        const existing = new Set([
            '/jdk/bin/java',
            '/sdk/platform-tools/adb',
            '/sdk/ndk/27.1.12297006/source.properties',
        ]);
        expect(() =>
            resolveAndroidEnvironment({
                environment: { ANDROID_SDK_ROOT: '/sdk', JAVA_HOME: '/jdk' },
                isPathPresent: (path) => existing.has(path),
                isCompatibleJavaHome: isJava17,
                requiredBuildToolsVersions: [],
                requiredCmakeVersions: ['3.22.1'],
                requiredNdkVersion: '27.1.12297006',
                requiredPlatformVersions: [],
            }),
        ).toThrow('Android build requires CMake 3.22.1');
    });

    it('rejects an incompatible Android Studio JBR and uses an installed JDK 17', () => {
        const existing = new Set([
            '/gradle/jdk-17/Contents/Home/bin/java',
            '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java',
            '/sdk/platform-tools/adb',
            '/sdk/ndk/27.1.12297006/source.properties',
        ]);
        expect(
            resolveAndroidEnvironment({
                environment: { ANDROID_SDK_ROOT: '/sdk' },
                isCompatibleJavaHome: (path) => path === '/gradle/jdk-17/Contents/Home',
                isPathPresent: (path) => existing.has(path),
                javaHomeCandidates: ['/gradle/jdk-17/Contents/Home'],
                requiredBuildToolsVersions: [],
                requiredCmakeVersions: [],
                requiredNdkVersion: '27.1.12297006',
                requiredPlatformVersions: [],
            }),
        ).toEqual({ javaHome: '/gradle/jdk-17/Contents/Home', sdkRoot: '/sdk' });
    });

    it('reads the required NDK from React Native instead of duplicating the version', () => {
        expect(parseReactNativeNdkVersion('[versions]\nndkVersion = "27.1.12297006"\n')).toBe(
            '27.1.12297006',
        );
    });

    it('reads the app module Build Tools version from React Native', () => {
        expect(parseReactNativeBuildToolsVersion('[versions]\nbuildTools = "36.0.0"\n')).toBe(
            '36.0.0',
        );
    });

    it('reads the compile SDK version from React Native', () => {
        expect(parseReactNativeCompileSdkVersion('[versions]\ncompileSdk = "36"\n')).toBe('36');
    });

    it('reads the Java major version without depending on vendor text', () => {
        expect(parseJavaMajorVersion('openjdk version "17.0.20.1" 2026-07-21')).toBe(17);
        expect(parseJavaMajorVersion('OpenJDK Runtime Environment')).toBeUndefined();
    });

    it('discovers only existing Gradle-managed macOS Java homes', () => {
        const directories = new Map<string, string[]>([
            ['/Users/example/.gradle/jdks', ['distribution-17', 'metadata']],
            ['/Users/example/.gradle/jdks/distribution-17', ['jdk-17.0.20.1+1']],
            ['/Users/example/.gradle/jdks/metadata', []],
        ]);
        expect(
            discoverGradleManagedJavaHomes(
                '/Users/example',
                (path) => directories.get(path) ?? [],
                (path) => path.endsWith('/Contents/Home/bin/java'),
            ),
        ).toEqual(['/Users/example/.gradle/jdks/distribution-17/jdk-17.0.20.1+1/Contents/Home']);
    });
});

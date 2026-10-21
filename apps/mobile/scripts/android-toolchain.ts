import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AndroidBuildPaths, AndroidEnvironmentPaths } from './android-environment';
import {
    discoverGradleManagedJavaHomes,
    parseJavaMajorVersion,
    parseReactNativeBuildToolsVersion,
    parseReactNativeCompileSdkVersion,
    parseReactNativeNdkVersion,
    resolveAndroidBuildPaths,
    resolveAndroidEnvironment,
} from './android-environment';

export interface AndroidToolchain extends AndroidBuildPaths, AndroidEnvironmentPaths {
    /**
     * The React Native app module's Build Tools, which also carry `aapt2` and `apksigner`.
     */
    appBuildToolsPath: string;
}

/**
 * Resolves the complete, already installed Android toolchain or throws before any Gradle work starts.
 */
export const resolveAndroidToolchain = (): AndroidToolchain => {
    const { expoPath, mobileRoot, reactNativeVersionCatalogPath } = resolveAndroidBuildPaths(
        import.meta.dirname,
    );
    const reactNativeVersionCatalog = readFileSync(reactNativeVersionCatalogPath, 'utf8');
    const requiredNdkVersion = parseReactNativeNdkVersion(reactNativeVersionCatalog);
    const requiredPlatformVersion = parseReactNativeCompileSdkVersion(reactNativeVersionCatalog);
    /**
     * Expo's Android library modules declare no Build Tools version and use AGP 9.2's 36.0.0 default, while the React
     * Native app module pins the version from its catalog. Both must be installed. See
     * https://developer.android.com/build/releases/agp-9-2-0-release-notes
     */
    const requiredBuildToolsVersions = [
        '36.0.0',
        parseReactNativeBuildToolsVersion(reactNativeVersionCatalog),
    ];
    /**
     * React Native's generated app uses AGP's SDK-managed CMake 3.22.1 for its external native build. Checking it here
     * prevents Gradle from prompting for or downloading a toolchain during a build.
     *
     * @see https://developer.android.com/studio/projects/gradle-external-native-builds
     */
    const requiredCmakeVersions = ['3.22.1'];

    /**
     * AGP 9.2 requires and defaults to JDK 17. Newer Android Studio previews can bundle a newer JBR whose native-access
     * warning is treated as a Prefab failure, so compatibility is checked before Gradle starts.
     *
     * @see https://developer.android.com/build/releases/agp-9-2-0-release-notes#compatibility
     */
    const isJdk17 = (javaHome: string): boolean => {
        const result = spawnSync(join(javaHome, 'bin', 'java'), ['-version'], {
            encoding: 'utf8',
            shell: false,
        });
        if (result.error || result.status !== 0) return false;
        return parseJavaMajorVersion(`${result.stdout}${result.stderr}`) === 17;
    };

    const { javaHome, sdkRoot } = resolveAndroidEnvironment({
        environment: process.env,
        isCompatibleJavaHome: isJdk17,
        isPathPresent: existsSync,
        javaHomeCandidates: discoverGradleManagedJavaHomes(homedir()),
        requiredBuildToolsVersions: [...new Set(requiredBuildToolsVersions)],
        requiredCmakeVersions,
        requiredNdkVersion,
        requiredPlatformVersions: [requiredPlatformVersion],
    });
    return {
        appBuildToolsPath: join(
            sdkRoot,
            'build-tools',
            parseReactNativeBuildToolsVersion(reactNativeVersionCatalog),
        ),
        expoPath,
        javaHome,
        mobileRoot,
        reactNativeVersionCatalogPath,
        sdkRoot,
    };
};

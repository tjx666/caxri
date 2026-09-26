#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import {
    discoverGradleManagedJavaHomes,
    parseAndroidBuildRequest,
    parseJavaMajorVersion,
    parseReactNativeBuildToolsVersion,
    parseReactNativeCompileSdkVersion,
    parseReactNativeNdkVersion,
    resolveAndroidBuildPaths,
    resolveAndroidEnvironment,
} from './android-environment';

const { expoPath, mobileRoot, reactNativeVersionCatalogPath } = resolveAndroidBuildPaths(
    import.meta.dirname,
);
const reactNativeVersionCatalog = readFileSync(reactNativeVersionCatalogPath, 'utf8');
const requiredNdkVersion = parseReactNativeNdkVersion(reactNativeVersionCatalog);
const requiredPlatformVersion = parseReactNativeCompileSdkVersion(reactNativeVersionCatalog);
/**
 * Expo's Android library modules use AGP 8.12's 35.0.0 default, while the React Native app module explicitly uses
 * 36.0.0. Both must be installed. See
 * https://developer.android.com/build/releases/past-releases/agp-8-12-0-release-notes
 */
const requiredBuildToolsVersions = [
    '35.0.0',
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
 * AGP 8.12 requires and defaults to JDK 17. Newer Android Studio previews can bundle a newer JBR whose native-access
 * warning is treated as a Prefab failure, so compatibility is checked before Gradle starts.
 *
 * @see https://developer.android.com/build/releases/past-releases/agp-8-12-0-release-notes#compatibility
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
const request = parseAndroidBuildRequest(process.argv.slice(2));
const result = spawnSync(
    request.buildOnly ? join(mobileRoot, 'android', 'gradlew') : expoPath,
    request.buildOnly
        ? [request.gradleTask, ...request.gradleArguments]
        : ['run:android', ...request.expoArguments],
    {
        cwd: request.buildOnly ? join(mobileRoot, 'android') : mobileRoot,
        env: {
            ...process.env,
            ANDROID_HOME: sdkRoot,
            ANDROID_SDK_ROOT: sdkRoot,
            EXPO_NO_GIT_STATUS: '1',
            JAVA_HOME: javaHome,
            PATH: `${join(javaHome, 'bin')}:${join(sdkRoot, 'platform-tools')}:${process.env.PATH ?? ''}`,
        },
        shell: false,
        stdio: 'inherit',
    },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

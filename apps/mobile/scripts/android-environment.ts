import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AndroidEnvironmentPaths {
    javaHome: string;
    sdkRoot: string;
}

interface AndroidEnvironmentInput {
    environment: Readonly<Record<string, string | undefined>>;
    homeDirectory?: string;
    isCompatibleJavaHome: (path: string) => boolean;
    isPathPresent: (path: string) => boolean;
    javaHomeCandidates?: readonly string[];
    requiredBuildToolsVersions: readonly string[];
    requiredCmakeVersions: readonly string[];
    requiredNdkVersion: string;
    requiredPlatformVersions: readonly string[];
}

type ReadDirectoryNames = (path: string) => string[];

const readDirectoryNames: ReadDirectoryNames = (path) =>
    readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

export interface AndroidBuildPaths {
    expoPath: string;
    mobileRoot: string;
    reactNativeVersionCatalogPath: string;
}

export interface AndroidBuildRequest {
    buildOnly: boolean;
    expoArguments: string[];
    gradleArguments: string[];
    gradleTask: string;
}

const firstValidRoot = (
    roots: Array<string | undefined>,
    requiredPath: string[],
    isPathPresent: (path: string) => boolean,
): string | undefined =>
    roots.find((root): root is string =>
        Boolean(root && isPathPresent(join(root, ...requiredPath))),
    );

export const parseJavaMajorVersion = (source: string): number | undefined => {
    const major = /\bversion\s+"(?:1\.)?(\d+)/iu.exec(source)?.[1];
    return major ? Number(major) : undefined;
};

/**
 * Finds Java homes that Gradle already installed without asking Gradle or another package manager to download one.
 */
export const discoverGradleManagedJavaHomes = (
    homeDirectory: string,
    readNames: ReadDirectoryNames = readDirectoryNames,
    isPathPresent: (path: string) => boolean = existsSync,
): string[] => {
    const distributionsRoot = join(homeDirectory, '.gradle', 'jdks');
    let distributions: string[];
    try {
        distributions = readNames(distributionsRoot);
    } catch {
        return [];
    }

    const javaHomes: string[] = [];
    for (const distribution of distributions) {
        const distributionRoot = join(distributionsRoot, distribution);
        let installations: string[];
        try {
            installations = readNames(distributionRoot);
        } catch {
            continue;
        }
        for (const installation of installations) {
            const javaHome = join(distributionRoot, installation, 'Contents', 'Home');
            if (isPathPresent(join(javaHome, 'bin', 'java'))) javaHomes.push(javaHome);
        }
    }
    return javaHomes.toSorted((left, right) => left.localeCompare(right));
};

export const parseReactNativeNdkVersion = (source: string): string => {
    const version = /^ndkVersion\s*=\s*"([0-9.]+)"\s*$/mu.exec(source)?.[1];
    if (!version) throw new Error('React Native does not declare a valid Android NDK version');
    return version;
};

export const parseReactNativeBuildToolsVersion = (source: string): string => {
    const version = /^buildTools\s*=\s*"([0-9.]+)"\s*$/mu.exec(source)?.[1];
    if (!version)
        throw new Error('React Native does not declare a valid Android Build Tools version');
    return version;
};

export const parseReactNativeCompileSdkVersion = (source: string): string => {
    const version = /^compileSdk\s*=\s*"(\d+)"\s*$/mu.exec(source)?.[1];
    if (!version) throw new Error('React Native does not declare a valid Android compile SDK');
    return version;
};

/**
 * Anchors every Expo path to the mobile workspace instead of the caller's current directory. Without this boundary,
 * invoking the repository-level script can generate an unrelated native project at the repository root.
 */
export const resolveAndroidBuildPaths = (scriptDirectory: string): AndroidBuildPaths => {
    const mobileRoot = join(scriptDirectory, '..');
    return {
        expoPath: join(mobileRoot, 'node_modules', '.bin', 'expo'),
        mobileRoot,
        reactNativeVersionCatalogPath: join(
            mobileRoot,
            'node_modules',
            'react-native',
            'gradle',
            'libs.versions.toml',
        ),
    };
};

/**
 * Keeps release acceptance independent from Expo's device selection. Expo currently installs and opens the app even
 * when `run:android` receives `--no-install`, so guarded acceptance uses Gradle for the build-only stage.
 */
export const parseAndroidBuildRequest = (arguments_: readonly string[]): AndroidBuildRequest => {
    const normalized = arguments_.filter((argument) => argument !== '--');
    const buildOnly = normalized.includes('--build-only');
    const abiIndex = normalized.indexOf('--abi');
    const abi = abiIndex === -1 ? undefined : normalized[abiIndex + 1];
    if (abiIndex !== -1 && !['arm64-v8a', 'x86_64'].includes(abi ?? ''))
        throw new Error('Android build ABI must be arm64-v8a or x86_64');
    const optimize = normalized.includes('--optimize');
    const minify = optimize || normalized.includes('--minify');
    if (!buildOnly && (abiIndex !== -1 || minify))
        throw new Error('Android ABI and optimization options require build-only');
    const buildArguments = normalized.filter(
        (argument, index) =>
            argument !== '--abi' &&
            (abiIndex === -1 || index !== abiIndex + 1) &&
            argument !== '--optimize' &&
            argument !== '--minify' &&
            argument !== '--build-only',
    );
    const expoArguments = buildOnly
        ? buildArguments
        : normalized.filter((argument) => argument !== '--build-only');
    const variantIndex = expoArguments.indexOf('--variant');
    const variant = variantIndex === -1 ? 'debug' : expoArguments[variantIndex + 1];
    if (!variant || !/^[a-z][a-z0-9]*$/iu.test(variant))
        throw new Error('Android build variant must be one alphanumeric identifier');
    if (buildOnly) {
        if (variant !== 'release' && (abi || minify))
            throw new Error('Android ABI and optimization options require release build-only');
        const supportedArguments = variantIndex === -1 ? [] : ['--variant', variant];
        if (
            expoArguments.length !== supportedArguments.length ||
            expoArguments.some((argument, index) => argument !== supportedArguments[index])
        )
            throw new Error(
                'Android build-only accepts only --variant, --abi, --minify, and --optimize',
            );
    }
    return {
        buildOnly,
        expoArguments,
        gradleArguments: [
            ...(abi ? [`-PreactNativeArchitectures=${abi}`] : []),
            ...(minify ? ['-Pandroid.enableMinifyInReleaseBuilds=true'] : []),
            ...(optimize ? ['-Pandroid.enableShrinkResourcesInReleaseBuilds=true'] : []),
        ],
        gradleTask: `app:assemble${variant[0].toUpperCase()}${variant.slice(1)}`,
    };
};

/**
 * Uses toolchain roots the operator already installed. Caxri does not download or mutate Android Studio, a JDK, or an
 * SDK as a side effect of running the build.
 */
export const resolveAndroidEnvironment = ({
    environment,
    homeDirectory = homedir(),
    isCompatibleJavaHome,
    isPathPresent,
    javaHomeCandidates = [],
    requiredBuildToolsVersions,
    requiredCmakeVersions,
    requiredNdkVersion,
    requiredPlatformVersions,
}: AndroidEnvironmentInput): AndroidEnvironmentPaths => {
    const javaHome = [
        environment.JAVA_HOME,
        ...javaHomeCandidates,
        '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    ].find((root): root is string =>
        Boolean(root && isPathPresent(join(root, 'bin', 'java')) && isCompatibleJavaHome(root)),
    );
    if (!javaHome)
        throw new Error('Android build requires JDK 17 in JAVA_HOME or an existing Gradle JDK');

    const sdkRoot = firstValidRoot(
        [
            environment.ANDROID_SDK_ROOT,
            environment.ANDROID_HOME,
            join(homeDirectory, 'Library', 'Android', 'sdk'),
        ],
        ['platform-tools', 'adb'],
        isPathPresent,
    );
    if (!sdkRoot) throw new Error('Android build requires an Android SDK with platform-tools');
    const missingBuildTools = requiredBuildToolsVersions.filter(
        (version) => !isPathPresent(join(sdkRoot, 'build-tools', version, 'source.properties')),
    );
    if (missingBuildTools.length > 0)
        throw new Error(`Android build requires SDK Build Tools ${missingBuildTools.join(', ')}`);
    const missingPlatforms = requiredPlatformVersions.filter(
        (version) =>
            !isPathPresent(join(sdkRoot, 'platforms', `android-${version}`, 'android.jar')),
    );
    if (missingPlatforms.length > 0)
        throw new Error(`Android build requires SDK Platform ${missingPlatforms.join(', ')}`);
    if (!isPathPresent(join(sdkRoot, 'ndk', requiredNdkVersion, 'source.properties')))
        throw new Error(`Android build requires NDK (Side by side) ${requiredNdkVersion}`);
    const missingCmake = requiredCmakeVersions.filter(
        (version) =>
            !isPathPresent(join(sdkRoot, 'cmake', version, 'bin', 'cmake')) ||
            !isPathPresent(join(sdkRoot, 'cmake', version, 'bin', 'ninja')),
    );
    if (missingCmake.length > 0)
        throw new Error(`Android build requires CMake ${missingCmake.join(', ')}`);
    return { javaHome, sdkRoot };
};

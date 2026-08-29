import { join } from 'node:path';

export interface NodePtyNativeLayoutOptions {
    arch: string;
    packageRoot: string;
    platform: NodeJS.Platform;
}

export type NativeModuleProbe = (path: string) => boolean;

/**
 * Mirrors node-pty 1.1.0's native load order so local preparation and packaged staging select the same layout.
 * https://github.com/microsoft/node-pty/blob/1.1.0/src/utils.ts
 */
function nodePtyNativeCandidateDirectories(options: NodePtyNativeLayoutOptions): string[] {
    return [
        join(options.packageRoot, 'build', 'Release'),
        join(options.packageRoot, 'build', 'Debug'),
        join(options.packageRoot, 'prebuilds', `${options.platform}-${options.arch}`),
    ];
}

export function selectNodePtyNativeDirectory(
    options: NodePtyNativeLayoutOptions,
    isNativeModuleLoadable: NativeModuleProbe,
): string | undefined {
    return nodePtyNativeCandidateDirectories(options).find((directory) =>
        isNativeModuleLoadable(join(directory, 'pty.node')),
    );
}

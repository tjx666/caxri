import type { RemoteTarget } from './layers';
import type { SshHostProbe } from './scripts';
import { compareVersions } from './scripts';
import { SshHostSetupError } from './setup';

/**
 * Apply when the build carries no layer for the probed target, so the failure still names the real floor. They match
 * `LINUX_GLIBC_BASELINE` and `MACOS_BASELINE` in the Server build (`apps/server/scripts/`).
 */
const DEFAULT_GLIBC_BASELINE = '2.28';
const DEFAULT_MACOS_BASELINE = '13.5';
const REQUIRED_TOOLS = ['tar', 'gzip', 'base64'] as const;
const SUPPORTED_SYSTEMS = 'Linux x64 and arm64, or macOS on Apple silicon';

/**
 * The layer target a probed SSH Host runs, or `undefined` when Caxri has no Server for its system. Intel Macs are not a
 * target yet: the build carries no darwin-x64 natives.
 */
export function remoteTargetOf(probe: SshHostProbe): RemoteTarget | undefined {
    if (probe.os === 'Linux' && probe.architecture === 'x64') return 'linux-x64';
    if (probe.os === 'Linux' && probe.architecture === 'arm64') return 'linux-arm64';
    if (probe.os === 'Darwin' && probe.architecture === 'arm64') return 'darwin-arm64';
    return undefined;
}

/**
 * Rejects an SSH Host the remote Server cannot run on, with the closed failure reason the UI explains to the user.
 * `baseline` is the target layer's `systemBaseline`: a glibc version on Linux, a macOS version on Darwin.
 */
export function validateSshHostProbe(probe: SshHostProbe, baseline?: string): void {
    const target = remoteTargetOf(probe);
    if (!target)
        throw new SshHostSetupError(
            'unsupportedPlatform',
            `Caxri supports ${SUPPORTED_SYSTEMS} as SSH Hosts; this one is ${probe.os} ${probe.architecture}`,
        );
    if (target === 'darwin-arm64') validateMacos(probe, baseline ?? DEFAULT_MACOS_BASELINE);
    else validateGlibc(probe, baseline ?? DEFAULT_GLIBC_BASELINE);
    const missing: string[] = REQUIRED_TOOLS.filter((tool) => !probe.tools[tool]);
    if (!probe.tools.sha256sum && !probe.tools.shasum) missing.push('sha256sum');
    if (missing.length > 0)
        throw new SshHostSetupError(
            'missingTool',
            `The SSH Host is missing required commands: ${missing.join(', ')}`,
        );
}

function validateGlibc(probe: SshHostProbe, baseline: string): void {
    if (probe.glibc === '')
        throw new SshHostSetupError(
            'unsupportedGlibc',
            `The SSH Host has no glibc (musl-based systems are not supported); glibc ${baseline} or newer is required`,
        );
    if (compareVersions(probe.glibc, baseline) < 0)
        throw new SshHostSetupError(
            'unsupportedGlibc',
            `The SSH Host has glibc ${probe.glibc}; glibc ${baseline} or newer is required`,
        );
}

function validateMacos(probe: SshHostProbe, baseline: string): void {
    // An unreadable version fails closed: guessing "new enough" would surface later as a Node crash at launch.
    if (!/^\d+(?:\.\d+)*$/u.test(probe.macos) || compareVersions(probe.macos, baseline) < 0)
        throw new SshHostSetupError(
            'unsupportedPlatform',
            `The SSH Host runs macOS ${probe.macos || 'of an unknown version'}; macOS ${baseline} or newer is required`,
        );
}

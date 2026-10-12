import type { RemoteProbe } from './remote-scripts';
import { compareVersions } from './remote-scripts';
import { RemoteSetupError } from './remote-setup';

/**
 * Applies when the build's layer descriptor carries no `glibcBaseline` (for example, the probed architecture has no
 * layer in this build).
 */
const DEFAULT_GLIBC_BASELINE = '2.28';
const REQUIRED_TOOLS = ['tar', 'gzip', 'base64'] as const;

/**
 * Rejects an SSH Host the remote Server cannot run on, with the closed failure reason the UI explains to the user.
 */
export function validateRemoteProbe(
    probe: RemoteProbe,
    baseline: string = DEFAULT_GLIBC_BASELINE,
): void {
    if (probe.os !== 'Linux' || (probe.architecture !== 'x64' && probe.architecture !== 'arm64'))
        throw new RemoteSetupError(
            'unsupportedPlatform',
            `Caxri supports Linux x64 and arm64 SSH Hosts; this one is ${probe.os} ${probe.architecture}`,
        );
    if (probe.glibc === '')
        throw new RemoteSetupError(
            'unsupportedGlibc',
            `The SSH Host has no glibc (musl-based systems are not supported); glibc ${baseline} or newer is required`,
        );
    if (compareVersions(probe.glibc, baseline) < 0)
        throw new RemoteSetupError(
            'unsupportedGlibc',
            `The SSH Host has glibc ${probe.glibc}; glibc ${baseline} or newer is required`,
        );
    const missing: string[] = REQUIRED_TOOLS.filter((tool) => !probe.tools[tool]);
    if (!probe.tools.sha256sum && !probe.tools.shasum) missing.push('sha256sum');
    if (missing.length > 0)
        throw new RemoteSetupError(
            'missingTool',
            `The SSH Host is missing required commands: ${missing.join(', ')}`,
        );
}

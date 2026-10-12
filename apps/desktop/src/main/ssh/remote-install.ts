import { errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { RemoteLayer } from './remote-layers';
import { ensureLocalRuntime, gzipProgressStream, progressStream } from './remote-layers';
import type { RemoteProbe } from './remote-scripts';
import {
    fetchRuntimeScript,
    gcScript,
    installAppScript,
    uploadRuntimeScript,
} from './remote-scripts';
import type { RemoteTransport } from './remote-setup';
import { bestEffort, lastLine, RemoteSetupError, runRemoteScript } from './remote-setup';

const GC_TIMEOUT_MS = 60_000;
const RUNTIME_FETCH_TIMEOUT_MS = 10 * 60_000;
const UPLOAD_TIMEOUT_MS = 30 * 60_000;
const PROGRESS_INTERVAL_MS = 200;

interface RemoteInstallProgress {
    completedBytes: number;
    totalBytes: number;
}

export interface RemoteInstallOptions {
    connection: RemoteTransport;
    layer: RemoteLayer;
    logger: Pick<StructuredLogger, 'write'>;
    /**
     * Throttled to one call per `PROGRESS_INTERVAL_MS`, plus the first and final values.
     */
    onProgress: (progress: RemoteInstallProgress) => void;
    probe: RemoteProbe;
    runtimeCacheDirectory: string;
}

interface ProgressSink {
    addBytes(bytes: number): void;
    addTotal(bytes: number): void;
}

/**
 * Puts the runtime into the remote cache: the SSH Host downloads the pinned archive itself when it has `curl` or `wget`
 * and internet access; otherwise Desktop streams its own verified copy.
 */
async function installRuntime(
    options: RemoteInstallOptions,
    progress: ProgressSink,
): Promise<'cached' | 'local-upload' | 'remote-download'> {
    const { connection, probe } = options;
    const { runtime } = options.layer.descriptor;
    if (probe.runtimes.has(runtime.sha256)) return 'cached';
    if (probe.tools.curl === true || probe.tools.wget === true) {
        const fetched = await runRemoteScript(
            connection,
            fetchRuntimeScript({
                member: runtime.source.member,
                runtimeSha256: runtime.sha256,
                sha256: runtime.source.sha256,
                url: runtime.source.url,
            }),
            { timeoutMs: RUNTIME_FETCH_TIMEOUT_MS },
        );
        const status = fetched.result?.get('status');
        if (status === 'installed' || status === 'present') return 'remote-download';
    }
    let runtimePath: string;
    try {
        runtimePath = await ensureLocalRuntime({
            cacheDirectory: options.runtimeCacheDirectory,
            runtime,
        });
    } catch (error) {
        throw new RemoteSetupError(
            'installFailed',
            `Could not prepare the Node runtime: ${errorMessage(error, 'unknown error')}`,
        );
    }
    progress.addTotal(runtime.bytes);
    const uploaded = await runRemoteScript(
        connection,
        uploadRuntimeScript({ runtimeSha256: runtime.sha256 }),
        {
            stdin: gzipProgressStream(runtimePath, (bytes) => progress.addBytes(bytes)),
            timeoutMs: UPLOAD_TIMEOUT_MS,
        },
    );
    const status = uploaded.result?.get('status');
    if (status !== 'installed' && status !== 'present')
        throw new RemoteSetupError(
            'installFailed',
            `Uploading the Node runtime failed (${status ?? (lastLine(uploaded.stderr) || 'no result')})`,
        );
    return 'local-upload';
}

/**
 * Installs the application layer (and its Node runtime when the remote cache lacks it) on the SSH Host, then
 * garbage-collects older builds. Returns the probe updated with the newly installed build and runtime.
 */
export async function installRemoteBuild(options: RemoteInstallOptions): Promise<RemoteProbe> {
    const { connection, layer, probe } = options;
    const startedAt = Date.now();
    const { descriptor } = layer;
    let totalBytes = descriptor.app.bytes;
    let completedBytes = 0;
    let lastEmitAt = 0;
    const report = (isFinal = false): void => {
        const now = Date.now();
        if (!isFinal && now - lastEmitAt < PROGRESS_INTERVAL_MS) return;
        lastEmitAt = now;
        options.onProgress({ completedBytes, totalBytes });
    };
    const progress: ProgressSink = {
        addBytes: (bytes: number): void => {
            completedBytes = Math.min(totalBytes, completedBytes + bytes);
            report();
        },
        addTotal: (bytes: number): void => {
            totalBytes += bytes;
            report(true);
        },
    };
    report(true);
    const runtimeSource = await installRuntime(options, progress);
    // Sequential on purpose: the app install script refuses to run until the runtime it points at exists remotely.
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const installed = await runRemoteScript(
        connection,
        installAppScript({
            appSha256: descriptor.app.sha256,
            buildId: descriptor.buildId,
            runtimePath: descriptor.runtime.path,
            runtimeSha256: descriptor.runtime.sha256,
        }),
        {
            stdin: progressStream(layer.appPath, (bytes) => progress.addBytes(bytes)),
            timeoutMs: UPLOAD_TIMEOUT_MS,
        },
    );
    const status = installed.result?.get('status');
    if (status !== 'installed' && status !== 'present')
        throw new RemoteSetupError(
            'installFailed',
            `Installing the remote Server failed (${status ?? (lastLine(installed.stderr) || 'no result')})`,
        );
    completedBytes = totalBytes;
    report(true);
    const updated: RemoteProbe = {
        ...probe,
        builds: new Set([...probe.builds, descriptor.buildId]),
        runtimes: new Set([...probe.runtimes, descriptor.runtime.sha256]),
    };
    options.logger.write('info', logEventCatalog.remoteSsh.installed, {
        fields: { bytes: totalBytes, durationMs: Date.now() - startedAt, runtimeSource },
    });
    // A failed cleanup leaves old builds behind but never blocks the attach.
    await bestEffort(() =>
        runRemoteScript(
            connection,
            gcScript({
                buildId: descriptor.buildId,
                runtimeSha256: descriptor.runtime.sha256,
            }),
            { timeoutMs: GC_TIMEOUT_MS },
        ),
    );
    return updated;
}

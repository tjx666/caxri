/**
 * Chromium command-line workarounds for GPU-backend crashes, applied before `app.whenReady()`.
 */
interface CommandLineLike {
    appendSwitch(name: string): void;
}

/**
 * Electron 43 (Chromium 150) enables the Skia Graphite rasterization backend by default on Apple platforms, and on
 * macOS 26 it is known to corrupt or crash the GPU process when a window returns from occlusion (switching back to the
 * app shows a white sad-face renderer crash before the automatic reload). Falling back to the Ganesh backend on macOS
 * avoids the crash without affecting hardware acceleration, WebGL, or video decode. Re-evaluate on Electron upgrades.
 *
 * @see https://github.com/electron/electron/issues/49904
 * @see https://github.com/electron/electron/pull/49608
 */
export function applyGpuStabilityWorkarounds(
    commandLine: CommandLineLike,
    platform: NodeJS.Platform,
): void {
    if (platform !== 'darwin') return;
    commandLine.appendSwitch('disable-skia-graphite');
}

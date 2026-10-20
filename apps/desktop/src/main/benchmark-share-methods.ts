import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { MainRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { BrowserWindow } from 'electron';
import { clipboard, ClipboardItem, dialog, nativeImage } from 'electron';

import { benchmarkShareImageDialogOptions } from './native-file-dialogs';
import { requestWindowOr } from './request-window';

type BenchmarkShareRequest = Extract<MainRequest, { method: `benchmark.shareImage.${string}` }>;

export function isBenchmarkShare(request: MainRequest): request is BenchmarkShareRequest {
    return request.method.startsWith('benchmark.shareImage.');
}

function shareImageBytes(pngBase64: string): Buffer {
    const bytes = Buffer.from(pngBase64, 'base64');
    if (nativeImage.createFromBuffer(bytes).isEmpty())
        throw new CaxriError('VALIDATION', 'Share image is not a valid PNG');
    return bytes;
}

/**
 * Main's half of the Benchmark share card: the Renderer rasterizes, Main owns the clipboard and the native save dialog.
 * Both validate that the bytes decode as an image before touching either, so a corrupt payload never reaches the
 * clipboard or the disk.
 */
export async function handleBenchmarkShare(
    request: BenchmarkShareRequest,
    window: BrowserWindow | undefined,
): Promise<unknown> {
    const bytes = shareImageBytes(request.params.pngBase64);
    if (request.method === 'benchmark.shareImage.copy') {
        // Electron 44 removed writeImage in favor of the W3C-style asynchronous clipboard API.
        const imageBlob = new Blob([Uint8Array.from(bytes)], { type: 'image/png' });
        await clipboard.write([new ClipboardItem({ 'image/png': imageBlob })]);
        return null;
    }
    const result = await dialog.showSaveDialog(
        requestWindowOr(window),
        benchmarkShareImageDialogOptions(basename(request.params.fileName)),
    );
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, bytes);
    return { path: result.filePath };
}

import type { ElectronApplication } from '@playwright/test';

import { execFileAsync } from '../../src/shared/node/exec.ts';

interface ClipboardSnapshot {
    bookmark: { title: string; url: string };
    empty: boolean;
    fallback?: { data: string; format: string };
    html: string;
    image?: string;
    rtf: string;
    text: string;
}

/**
 * Reads the real macOS clipboard outside Electron so an E2E can verify restoration after its app process exits.
 */
export async function readSystemClipboardText(): Promise<string> {
    const { stdout } = await execFileAsync('/usr/bin/pbpaste', []);
    return stdout.toString();
}

/**
 * Captures the portable clipboard representations Electron can restore together in one write. A raw first-format
 * fallback preserves clipboards that expose no text, markup, bookmark, or image representation.
 */
export async function snapshotClipboard(app: ElectronApplication): Promise<ClipboardSnapshot> {
    return app.evaluate(({ clipboard }) => {
        const formats = clipboard.availableFormats();
        const image = clipboard.readImage();
        const text = clipboard.readText();
        const html = clipboard.readHTML();
        const rtf = clipboard.readRTF();
        const bookmark = clipboard.readBookmark();
        const hasPortableData =
            Boolean(text || html || rtf || bookmark.url || bookmark.title) || !image.isEmpty();
        const fallbackFormat = hasPortableData ? undefined : formats[0];

        return {
            bookmark,
            empty: formats.length === 0,
            ...(fallbackFormat && {
                fallback: {
                    data: clipboard.readBuffer(fallbackFormat).toString('base64'),
                    format: fallbackFormat,
                },
            }),
            html,
            ...(!image.isEmpty() && { image: image.toPNG().toString('base64') }),
            rtf,
            text,
        };
    });
}

/**
 * Arms a synchronous Main-process fallback for quit paths that bypass Playwright's wrapped `app.close()`. The
 * `before-quit` boundary is the last point where Electron still owns a live native clipboard; the test runner cannot
 * recover rich clipboard representations after the Electron process has already exited.
 */
export async function armClipboardRestoreOnQuit(
    app: ElectronApplication,
    snapshot: ClipboardSnapshot,
): Promise<void> {
    await app.evaluate(({ app: electronApp, clipboard, nativeImage }, saved) => {
        electronApp.once('before-quit', () => {
            if (saved.empty) {
                clipboard.clear();
                return;
            }
            if (saved.fallback) {
                clipboard.writeBuffer(
                    saved.fallback.format,
                    // eslint-disable-next-line n/prefer-global/buffer -- Playwright evaluates this callback in Electron Main, outside this module's imports
                    Buffer.from(saved.fallback.data, 'base64'),
                );
                return;
            }
            clipboard.write({
                bookmark: saved.bookmark.title,
                html: saved.html,
                ...(saved.image && {
                    // eslint-disable-next-line n/prefer-global/buffer -- Playwright evaluates this callback in Electron Main, outside this module's imports
                    image: nativeImage.createFromBuffer(Buffer.from(saved.image, 'base64')),
                }),
                rtf: saved.rtf,
                text: saved.text || saved.bookmark.url,
            });
        });
    }, snapshot);
}

/**
 * Restores the system clipboard before an E2E application closes. Clipboard is machine-global even though every Caxri
 * profile is isolated, so leaving a fixture behind would leak one test's state into the user's desktop and later
 * specs.
 */
export async function restoreClipboard(
    app: ElectronApplication,
    snapshot: ClipboardSnapshot,
): Promise<void> {
    await app.evaluate(({ clipboard, nativeImage }, saved) => {
        if (saved.empty) {
            clipboard.clear();
            return;
        }
        if (saved.fallback) {
            clipboard.writeBuffer(
                saved.fallback.format,
                // eslint-disable-next-line n/prefer-global/buffer -- Playwright evaluates this callback in Electron Main, outside this module's imports
                Buffer.from(saved.fallback.data, 'base64'),
            );
            return;
        }
        clipboard.write({
            bookmark: saved.bookmark.title,
            html: saved.html,
            ...(saved.image && {
                // eslint-disable-next-line n/prefer-global/buffer -- Playwright evaluates this callback in Electron Main, outside this module's imports
                image: nativeImage.createFromBuffer(Buffer.from(saved.image, 'base64')),
            }),
            rtf: saved.rtf,
            text: saved.text || saved.bookmark.url,
        });
    }, snapshot);
}

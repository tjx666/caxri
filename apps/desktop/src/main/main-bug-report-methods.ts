import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { MainRequest } from '@caxri/protocol';
import {
    agentProviderCatalog,
    BUG_REPORT_JPEG_DATA_URL_PREFIX,
    CaxriError,
    isChatTerminal,
} from '@caxri/protocol';
import type { BrowserWindow } from 'electron';
import { app, clipboard, ClipboardItem, nativeImage } from 'electron';

import {
    BUG_REPORT_SCREENSHOT_DIRECTORY,
    pruneBugReportScreenshots,
} from './bug-report-screenshots';
import type { DesktopServerConnection } from './server-connection';

type BugReportRequest = Extract<
    MainRequest,
    { method: 'bugReport.captureScreenshot' | 'bugReport.saveScreenshot' | 'bugReport.send' }
>;

export function isBugReportRequest(request: MainRequest): request is BugReportRequest {
    return ['bugReport.send', 'bugReport.captureScreenshot', 'bugReport.saveScreenshot'].includes(
        request.method,
    );
}

/**
 * Answers the bug-report requests that need Electron: capturing the window, saving the capture for an Agent to open,
 * and pasting it into an Agent Terminal's clipboard before delivery.
 */
export async function handleBugReportRequest(
    request: BugReportRequest,
    supervisor: DesktopServerConnection,
    mainWindow: BrowserWindow | undefined,
): Promise<unknown> {
    switch (request.method) {
        case 'bugReport.send':
            return sendBugReport(request.params, supervisor);
        case 'bugReport.captureScreenshot': {
            if (!mainWindow || mainWindow.isDestroyed())
                throw new CaxriError('UNAVAILABLE', 'The Caxri window is not available');
            const image = await mainWindow.webContents.capturePage();
            const { height, width } = image.getSize();
            return {
                dataUrl: `${BUG_REPORT_JPEG_DATA_URL_PREFIX}${image.toJPEG(80).toString('base64')}`,
                height,
                width,
            };
        }
        case 'bugReport.saveScreenshot':
            return saveBugReportScreenshot(request.params.dataUrl);
    }
}

async function sendBugReport(
    parameters: Extract<BugReportRequest, { method: 'bugReport.send' }>['params'],
    supervisor: DesktopServerConnection,
): Promise<unknown> {
    const { chatImage, report, screenshot, sessionId, terminalId } = parameters;
    const records = await supervisor.request('app.records', {
        sessionIds: [],
        terminalIds: [terminalId],
    });
    // `.find` (not index `[0]`) keeps the result typed as possibly missing: `app.records`
    // returns an empty array, not a guaranteed match, when the Terminal no longer exists.
    const terminal = records.terminals.find((candidate) => candidate.id === terminalId);
    if (!terminal) throw new CaxriError('NOT_FOUND', 'Agent Terminal not found');
    if (terminal.sessionId !== sessionId)
        throw new CaxriError('CONFLICT', 'The selected Agent no longer belongs to this Session');
    if (!terminal.provider)
        throw new CaxriError('CONFLICT', 'Bug reports can only be sent to an Agent Terminal');
    /**
     * An Agent Chat has no PTY process to check and no clipboard paste path: the Server starts an idle Chat on demand
     * and attaches the screenshot to the message itself.
     */
    if (isChatTerminal(terminal))
        return supervisor.request('bugReport.deliver', {
            images: chatImage && [chatImage],
            pasteImage: false,
            report,
            sessionId,
            terminalId,
        });
    if (terminal.lastProcessState !== 'running' || terminal.processId === undefined)
        throw new CaxriError('UNAVAILABLE', 'The selected Agent is no longer running');
    const imageInput = agentProviderCatalog[terminal.provider].imageInput;
    const isPasteImage = Boolean(screenshot && imageInput);
    if (isPasteImage && screenshot) {
        const image = nativeImage.createFromDataURL(screenshot.dataUrl);
        if (image.isEmpty())
            throw new CaxriError('VALIDATION', 'Captured screenshot is not a valid image');
        /**
         * Electron 44 removed writeImage in favor of its W3C-style asynchronous clipboard API. Await the atomic write
         * so the Agent cannot receive the paste command before its image is available.
         */
        const imageBytes = Uint8Array.from(image.toPNG());
        const imageBlob = new Blob([imageBytes], { type: 'image/png' });
        await clipboard.write([
            new ClipboardItem({
                'image/png': imageBlob,
            }),
        ]);
    }
    return supervisor.request('bugReport.deliver', {
        pasteImage: isPasteImage,
        report,
        sessionId,
        terminalId,
    });
}

/**
 * Some Agent CLIs (Claude Code among them) have no Caxri-safe way to accept a pasted clipboard image, so the report
 * references an on-disk screenshot the Agent can open with its own file tools instead. The file is deliberately
 * unredacted, because it is exactly the capture the user already reviewed in the bug-report preview. It therefore stays
 * outside any Project in the OS temp directory, in a Caxri-owned folder pruned after 24 hours.
 */
async function saveBugReportScreenshot(dataUrl: string): Promise<{ path: string }> {
    /**
     * The validated data URL already carries JPEG bytes; re-encoding through `nativeImage` would only cost another
     * lossy generation, and decoding a multi-megabyte capture just to learn whether it is an image blocks the Main
     * process for no gain. The two-byte SOI marker is the cheap equivalent: the schema has already fixed the prefix, so
     * this only has to reject base64 that is not actually a JPEG.
     */
    const bytes = Buffer.from(dataUrl.slice(BUG_REPORT_JPEG_DATA_URL_PREFIX.length), 'base64');
    if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
        throw new CaxriError('VALIDATION', 'Screenshot is not a valid JPEG image');
    const directory = join(app.getPath('temp'), BUG_REPORT_SCREENSHOT_DIRECTORY);
    // 0o700/0o600: the capture is unredacted, so nothing outside this user account may read it.
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await pruneBugReportScreenshots(directory);
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const target = join(
        directory,
        `caxri-bug-report-${stamp}-${randomBytes(4).toString('hex')}.jpg`,
    );
    await writeFile(target, bytes, { mode: 0o600 });
    return { path: target };
}

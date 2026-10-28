import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import { lstat, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ServerEvent } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { z } from 'zod';

/**
 * Where the bundled macOS share extension (`apps/desktop/native/share-extension`) copies what the Share menu hands it,
 * relative to the home folder. It is fixed rather than profile-relative because the sandboxed extension may write only
 * the path its entitlement names; the Swift writer and `ShareExtension.entitlements` repeat it.
 */
const SHARE_INBOX_RELATIVE_PATH = 'Library/Application Support/Caxri/Share Inbox';
export const SHARE_REQUEST_FILE_NAME = 'request.caxrishare';
/**
 * A request folder older than this is removed at startup. Long enough that an Agent which was handed the files still
 * finds them when the conversation continues days later, short enough that forwarded chat exports do not pile up.
 */
const SHARE_INBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SHARED_FILES = 20;
const MAX_SHARED_TEXT = 100_000;
const REQUEST_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

const manifestSchema = z.strictObject({
    version: z.literal(1),
    files: z.array(z.string().min(1).max(255)).max(MAX_SHARED_FILES),
    text: z.string().min(1).max(MAX_SHARED_TEXT).optional(),
});

export type ShareRequest = Extract<ServerEvent, { event: 'desktop.shareReceived' }>['payload'];

/**
 * Why a document Caxri was asked to open was not accepted as a share request. Closed so the log can count each cause.
 */
type ShareRejectionReason =
    | 'not-a-request'
    | 'outside-inbox'
    | 'unreadable'
    | 'invalid-manifest'
    | 'unsafe-file-name'
    | 'missing-file'
    | 'empty';

class ShareRequestError extends Error {
    constructor(readonly reason: ShareRejectionReason) {
        super(`Share request rejected: ${reason}`);
    }
}

/**
 * A manifest file name must stay a single entry of its own request folder.
 */
function isSafeFileName(name: string): boolean {
    return (
        name !== '.' &&
        name !== '..' &&
        name !== SHARE_REQUEST_FILE_NAME &&
        !name.includes('/') &&
        !name.includes('\0')
    );
}

/**
 * Reads the manifest at `manifestPath` as a share request, accepting it only when it is the manifest of a request
 * folder directly inside `inboxDirectory` and every file it names is a real entry of that folder.
 *
 * Opening a document is something any application can ask of Caxri, so nothing outside the Share Inbox is ever
 * attached: a `.caxrishare` file elsewhere, or a symlink placed in a request folder, is rejected.
 */
export async function readShareRequest(
    manifestPath: string,
    inboxDirectory: string,
): Promise<ShareRequest> {
    if (basename(manifestPath) !== SHARE_REQUEST_FILE_NAME)
        throw new ShareRequestError('not-a-request');
    let realManifest: string;
    let realInbox: string;
    try {
        [realManifest, realInbox] = await Promise.all([
            realpath(manifestPath),
            realpath(inboxDirectory),
        ]);
    } catch {
        throw new ShareRequestError('unreadable');
    }
    const folder = dirname(realManifest);
    const requestId = basename(folder);
    if (dirname(folder) !== realInbox || !REQUEST_ID.test(requestId))
        throw new ShareRequestError('outside-inbox');
    const manifest = manifestSchema.safeParse(await readBoundedJson(realManifest));
    if (!manifest.success) throw new ShareRequestError('invalid-manifest');
    const { files: names, text } = manifest.data;
    if (names.some((name) => !isSafeFileName(name)))
        throw new ShareRequestError('unsafe-file-name');
    const files = await Promise.all(
        names.map(async (name) => {
            const path = join(folder, name);
            const entry = await lstatOrUndefined(path);
            if (!entry || entry.isSymbolicLink()) throw new ShareRequestError('missing-file');
            return { path, isDirectory: entry.isDirectory() };
        }),
    );
    if (!text && files.length === 0) throw new ShareRequestError('empty');
    return { requestId, files, ...(text && { text }) };
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
    try {
        return await lstat(path);
    } catch {
        return undefined;
    }
}

async function readBoundedJson(path: string): Promise<unknown> {
    try {
        if ((await stat(path)).size > MAX_MANIFEST_BYTES) return undefined;
        return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch {
        return undefined;
    }
}

/**
 * Removes request folders last modified more than `retentionMs` before `now`. Returns how many were removed and how
 * many could not be; a missing inbox (nothing was ever shared) removes nothing.
 */
export async function pruneShareInbox(
    inboxDirectory: string,
    now: number,
    retentionMs = SHARE_INBOX_RETENTION_MS,
): Promise<{ removed: number; failed: number }> {
    let entries: string[];
    try {
        entries = await readdir(inboxDirectory);
    } catch {
        entries = [];
    }
    const results = await Promise.all(
        entries
            .filter((name) => REQUEST_ID.test(name))
            .map(async (name) => {
                const path = join(inboxDirectory, name);
                try {
                    if (now - (await stat(path)).mtimeMs <= retentionMs) return 'kept';
                    await rm(path, { force: true, recursive: true });
                    return 'removed';
                } catch {
                    return 'failed';
                }
            }),
    );
    return {
        removed: results.filter((result) => result === 'removed').length,
        failed: results.filter((result) => result === 'failed').length,
    };
}

export const SHARE_EXTENSION_BUNDLE_ID = 'com.caxri.app.share';

export type ShareExtensionElection = 'enabled' | 'already-elected' | 'not-registered' | 'failed';

/**
 * Turns the bundled share extension on when the user has never chosen either way.
 *
 * MacOS registers a new share extension without enabling it, so it would not appear in WeChat's forward menu or the
 * Share menu until the user found it in System Settings. `pluginkit -m` prefixes an extension the user enabled with `+`
 * and one they disabled with `-`; only an extension with neither is elected, so a user who turned it off keeps it off.
 */
export async function electShareExtension(
    run: (file: string, arguments_: string[]) => Promise<{ stdout: string }> = promisify(execFile),
): Promise<ShareExtensionElection> {
    try {
        const { stdout } = await run('pluginkit', ['-m', '-i', SHARE_EXTENSION_BUNDLE_ID]);
        const line = stdout
            .split('\n')
            .find((candidate) => candidate.includes(SHARE_EXTENSION_BUNDLE_ID));
        if (!line) return 'not-registered';
        const election = line.trimStart().charAt(0);
        if (election === '+' || election === '-') return 'already-elected';
        await run('pluginkit', ['-e', 'use', '-i', SHARE_EXTENSION_BUNDLE_ID]);
        return 'enabled';
    } catch {
        return 'failed';
    }
}

export interface ShareInboxOptions {
    homeDirectory: string;
    /**
     * Only a packaged app contains the extension; a development build neither elects it nor prunes its inbox, which a
     * packaged Caxri on the same Mac owns.
     */
    isPackaged: boolean;
    logger: Pick<StructuredLogger, 'write'>;
    /**
     * Hands each accepted request to the Workbench, raising its window first.
     */
    deliver: (request: ShareRequest) => Promise<void>;
    /**
     * Subscribes to the documents macOS asked Caxri to open (`open-file-requests.ts`).
     */
    onOpenFile: (listener: (path: string) => void) => void;
}

/**
 * Wires the Share menu hand-off once the Workbench can receive it: accepts the documents macOS asks Caxri to open as
 * share requests, and in a packaged app prunes expired requests and elects the extension once.
 */
export function installShareInbox(options: ShareInboxOptions): void {
    const inboxDirectory = join(options.homeDirectory, SHARE_INBOX_RELATIVE_PATH);
    const { logger } = options;
    options.onOpenFile((path) => {
        void (async () => {
            try {
                const request = await readShareRequest(path, inboxDirectory);
                logger.write('info', logEventCatalog.desktop.shareReceived, {
                    fields: {
                        fileCount: request.files.length,
                        directoryCount: request.files.filter((file) => file.isDirectory).length,
                        hasText: request.text !== undefined,
                    },
                });
                await options.deliver(request);
            } catch (error) {
                logger.write('warn', logEventCatalog.desktop.shareRejected, {
                    fields: {
                        reason:
                            error instanceof ShareRequestError ? error.reason : 'delivery-failed',
                    },
                });
            }
        })();
    });
    if (!options.isPackaged) return;
    void (async () => {
        const startedAt = Date.now();
        const [pruned, election] = await Promise.all([
            pruneShareInbox(inboxDirectory, startedAt),
            electShareExtension(),
        ]);
        logger.write('info', logEventCatalog.desktop.shareInboxPruned, {
            fields: { ...pruned, durationMs: Date.now() - startedAt },
        });
        logger.write(
            election === 'failed' ? 'warn' : 'info',
            logEventCatalog.desktop.shareExtensionElection,
            {
                fields: { outcome: election },
            },
        );
    })();
}

import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import { principalSchema } from '../transport/principal.js';

/**
 * A phone-made file upload ID. Unlike an image, which a Chat message carries as data, an uploaded file reaches the
 * Agent as a path on the Server's machine; see `docs/mobile/conversation.md`.
 */
export const mobileFileAttachmentIdSchema = z.string().regex(/^file_[0-9a-f]{32}$/u);

/**
 * The largest file a phone may attach. Phone videos run large; the Server writes chunks straight to disk, so the bound
 * protects disk and upload time rather than memory.
 */
export const MAX_MOBILE_FILE_BYTES = 100 * 1_024 * 1_024;

/**
 * How many files one message may carry, in Chat and in a Terminal Agent submission alike.
 */
export const MAX_MOBILE_FILE_ATTACHMENTS = 10;

/**
 * Bytes of one upload chunk. Every chunk but the last carries exactly this many, so the Server writes each at its own
 * offset and the phone may keep several in flight. A multiple of three, so each chunk's base64 has no padding, and
 * small enough that a chunk plus its envelope fits one gateway frame.
 */
export const MOBILE_FILE_CHUNK_BYTES = 36_864;

/**
 * How many chunks a file of `size` bytes uploads as. An empty file still sends one chunk, which carries no bytes.
 */
export const mobileFileChunkCount = (size: number): number =>
    Math.max(1, Math.ceil(size / MOBILE_FILE_CHUNK_BYTES));

const MAX_FILE_NAME_BYTES = 255;

/**
 * Whether `name` can be a file's last path segment on macOS and Linux as is: no separator, no control character, not a
 * dot segment, within the common 255-byte name limit.
 */
export const isMobileFileName = (name: string): boolean =>
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    new TextEncoder().encode(name).length <= MAX_FILE_NAME_BYTES &&
    ![...name].some((character) => {
        const code = character.codePointAt(0)!;
        return character === '/' || character === '\\' || code < 32 || code === 127;
    });

export const mobileFileUploadParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    attachmentId: mobileFileAttachmentIdSchema,
    /**
     * The file's name as the phone shows it; the Agent sees the uploaded file under the same name.
     */
    name: z.string().refine(isMobileFileName, 'Invalid file name'),
    size: z.number().int().min(0).max(MAX_MOBILE_FILE_BYTES),
    chunkIndex: z
        .number()
        .int()
        .min(0)
        .max(mobileFileChunkCount(MAX_MOBILE_FILE_BYTES) - 1),
    /**
     * Empty only for the single chunk of an empty file.
     */
    chunk: z
        .string()
        .max((MOBILE_FILE_CHUNK_BYTES / 3) * 4)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
});

export const mobileFileUploadResultSchema = z.strictObject({
    ready: z.boolean(),
    /**
     * Where the completed file sits on the Server's machine, once `ready`. A Chat message cites it by this path
     * (`agentChatTextWithPathReferences`), which the phone composes itself so its pending message matches the sent
     * one.
     */
    path: z.string().min(1).optional(),
});

/**
 * `mobile.file.pathsInternal` returns where the uploaded files a message names sit on disk, for the gateway to cite.
 * Only the uploading device generation may resolve them, and only under the Session they were uploaded to.
 */
export const mobileFilePathsInternalParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    attachmentIds: z.array(mobileFileAttachmentIdSchema).min(1).max(MAX_MOBILE_FILE_ATTACHMENTS),
    principal: principalSchema,
});

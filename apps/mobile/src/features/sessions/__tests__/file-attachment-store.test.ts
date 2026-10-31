import { MAX_MOBILE_FILE_BYTES } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { MobileGatewayRequestError } from '../../connection/mobile-gateway-errors';
import type { FileAttachment } from '../file-attachment-store';
import {
    expireFileAttachments,
    FILE_ATTACHMENT_REUSE_MS,
    fileAttachmentKind,
    fileAttachmentRefusal,
    fileAttachmentWaitReason,
    fileUploadFailureMessage,
    formatFileSize,
    isTransientUploadError,
    mobileUploadFileName,
    nextFileExpiryDelayMs,
} from '../file-attachment-store';

const file = (patch: Partial<FileAttachment> = {}): FileAttachment => ({
    id: 'file_a',
    uri: 'file:///cache/clip.mov',
    name: 'clip.mov',
    size: 2_048,
    progress: 1,
    state: 'ready',
    path: '/tmp/file_a/clip.mov',
    uploadedAt: 0,
    ...patch,
});

describe('composer file attachments', () => {
    it('formats sizes as a file manager does', () => {
        expect(formatFileSize(512)).toBe('512 B');
        expect(formatFileSize(1_536)).toBe('1.5 KB');
        expect(formatFileSize(48 * 1_024)).toBe('48 KB');
        expect(formatFileSize(12.4 * 1_024 * 1_024)).toBe('12 MB');
        expect(formatFileSize(3.25 * 1_024 * 1_024)).toBe('3.3 MB');
    });

    it('refuses only a file past the upload limit', () => {
        expect(fileAttachmentRefusal({ name: 'a.mov', size: MAX_MOBILE_FILE_BYTES })).toBeNull();
        expect(fileAttachmentRefusal({ name: 'a.mov', size: MAX_MOBILE_FILE_BYTES + 1 })).toContain(
            'a.mov',
        );
    });

    it('makes a picked name one the Server accepts', () => {
        expect(mobileUploadFileName('Report Q3.pdf', 'file:///x')).toBe('Report Q3.pdf');
        expect(mobileUploadFileName('a/b\\c\u{1}.txt', 'file:///x')).toBe('a_b_c_.txt');
        expect(mobileUploadFileName(null, 'file:///cache/ImagePicker/VID%2001.mp4')).toBe(
            'VID 01.mp4',
        );
        expect(mobileUploadFileName('..', 'file:///')).toBe('file');
        const long = mobileUploadFileName(`${'名'.repeat(200)}.pdf`, 'file:///x');
        expect(long.endsWith('.pdf')).toBe(true);
        expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(255);
    });

    it('picks a glyph from the media type, then the extension', () => {
        expect(fileAttachmentKind({ name: 'a', mimeType: 'video/mp4' })).toBe('video');
        expect(fileAttachmentKind({ name: 'a', mimeType: 'audio/x-m4a' })).toBe('audio');
        expect(fileAttachmentKind({ name: 'a.pdf', mimeType: 'application/pdf' })).toBe('document');
        expect(fileAttachmentKind({ name: 'a.ZIP' })).toBe('archive');
        expect(fileAttachmentKind({ name: 'a.bin', mimeType: 'application/octet-stream' })).toBe(
            'other',
        );
    });

    it('expires a ready file the Server has likely deleted, keeping what Retry needs', () => {
        const current = [file(), file({ id: 'file_b', uploadedAt: FILE_ATTACHMENT_REUSE_MS })];
        expect(expireFileAttachments(current, FILE_ATTACHMENT_REUSE_MS)).toBe(current);
        const [expired, kept] = expireFileAttachments(current, FILE_ATTACHMENT_REUSE_MS + 1);
        expect(expired).toMatchObject({ state: 'failed', uri: file().uri, name: 'clip.mov' });
        expect(expired.path).toBeUndefined();
        expect(kept).toBe(current[1]);
    });

    it('holds Send while a file uploads or failed', () => {
        expect(fileAttachmentWaitReason([file()])).toBeNull();
        expect(fileAttachmentWaitReason([file({ state: 'uploading' })])).not.toBeNull();
        expect(fileAttachmentWaitReason([file({ state: 'failed' })])).not.toBeNull();
    });

    it('schedules the expiry of the earliest ready file', () => {
        const uploading = file({ id: 'file_u', state: 'uploading', uploadedAt: undefined });
        expect(nextFileExpiryDelayMs([uploading], 0)).toBeUndefined();
        const delay = nextFileExpiryDelayMs(
            [file({ id: 'file_late', uploadedAt: 10_000 }), file({ uploadedAt: 1_000 }), uploading],
            2_000,
        );
        expect(delay).toBe(FILE_ATTACHMENT_REUSE_MS - 1_000 + 1);
        expect(nextFileExpiryDelayMs([file({ uploadedAt: 0 })], FILE_ATTACHMENT_REUSE_MS * 2)).toBe(
            0,
        );
    });

    it('retries chunks only for network failures and names a full Server', () => {
        expect(isTransientUploadError(new Error('socket closed'))).toBe(true);
        expect(isTransientUploadError(new MobileGatewayRequestError('TIMEOUT', 'slow'))).toBe(true);
        expect(isTransientUploadError(new MobileGatewayRequestError('CAPACITY', 'full'))).toBe(
            false,
        );
        expect(isTransientUploadError(new MobileGatewayRequestError('VALIDATION', 'bad'))).toBe(
            false,
        );
        const t = (key: string) => key;
        expect(
            fileUploadFailureMessage(new MobileGatewayRequestError('CAPACITY', 'full'), t as never),
        ).toBe('sessions.file.capacity');
        expect(fileUploadFailureMessage(new Error('x'), t as never)).toBe(
            'sessions.image.uploadFailed',
        );
    });
});

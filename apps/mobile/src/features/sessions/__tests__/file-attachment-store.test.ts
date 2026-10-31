import { MAX_MOBILE_FILE_BYTES } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { FileAttachment } from '../file-attachment-store';
import {
    expireFileAttachments,
    FILE_ATTACHMENT_REUSE_MS,
    fileAttachmentKind,
    fileAttachmentRefusal,
    fileAttachmentWaitReason,
    formatFileSize,
    mobileUploadFileName,
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
});

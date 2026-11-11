import { describe, expect, it } from 'vitest';

import {
    attachesAsFile,
    formatMediaDuration,
    recentMediaAccessStep,
    recentMediaMimeType,
} from '../recent-media';

describe('recentMediaAccessStep', () => {
    it('reads the library once access is granted, including limited access', () => {
        expect(recentMediaAccessStep({ granted: true, status: 'granted' })).toBe('read');
    });

    it('asks only when the user was never asked', () => {
        expect(recentMediaAccessStep({ granted: false, status: 'undetermined' })).toBe('ask');
    });

    it('never asks again after the user declined', () => {
        expect(recentMediaAccessStep({ granted: false, status: 'denied' })).toBe('skip');
    });
});

describe('formatMediaDuration', () => {
    it('labels a video like the system gallery', () => {
        expect(formatMediaDuration(7_400)).toBe('0:07');
        expect(formatMediaDuration(750_000)).toBe('12:30');
        expect(formatMediaDuration(3_723_000)).toBe('1:02:03');
    });

    it('clamps a negative length to zero', () => {
        expect(formatMediaDuration(-3_000)).toBe('0:00');
    });
});

describe('attachesAsFile', () => {
    it('attaches a photo as an image when the composer takes images', () => {
        expect(attachesAsFile('image', { imagesAsFiles: false })).toBe(false);
        expect(attachesAsFile('image', undefined)).toBe(false);
    });

    it('attaches every video, and a photo for a composer without image input, as a file', () => {
        expect(attachesAsFile('video', { imagesAsFiles: false })).toBe(true);
        expect(attachesAsFile('image', { imagesAsFiles: true })).toBe(true);
    });

    it('cannot attach a video without a file route', () => {
        expect(attachesAsFile('video', undefined)).toBeUndefined();
    });
});

describe('recentMediaMimeType', () => {
    it('names a library video by its extension, so its file card plays it', () => {
        expect(
            recentMediaMimeType({ kind: 'video', filename: 'clip.MP4', uri: 'file:///a/clip.MP4' }),
        ).toBe('video/mp4');
        expect(recentMediaMimeType({ kind: 'video', uri: 'file:///a/clip.mov' })).toBe(
            'video/quicktime',
        );
    });

    it('falls back to the kind for an unknown extension', () => {
        expect(
            recentMediaMimeType({ kind: 'video', filename: 'clip', uri: 'file:///a/clip' }),
        ).toBe('video/*');
        expect(
            recentMediaMimeType({ kind: 'image', filename: 'a.raw', uri: 'file:///a.raw' }),
        ).toBe('image/*');
    });
});

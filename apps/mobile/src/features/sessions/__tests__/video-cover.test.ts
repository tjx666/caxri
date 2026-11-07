import { describe, expect, it, vi } from 'vitest';

import { createVideoCoverCache, renderVideoCover } from '../video-cover';

const native = vi.hoisted(() => {
    const release = vi.fn();
    const generateThumbnailsAsync = vi.fn<() => Promise<unknown[]>>(() =>
        Promise.resolve([{ frame: true }]),
    );
    const saveAsync = vi.fn(() => Promise.resolve({ uri: 'file:///cache/cover.jpg' }));
    return { generateThumbnailsAsync, release, saveAsync };
});

vi.mock('expo-video', () => ({
    createVideoPlayer: () => ({
        generateThumbnailsAsync: native.generateThumbnailsAsync,
        release: native.release,
    }),
}));
vi.mock('expo-image-manipulator', () => ({
    ImageManipulator: {
        manipulate: () => ({
            renderAsync: () => Promise.resolve({ saveAsync: native.saveAsync }),
        }),
    },
    SaveFormat: { JPEG: 'jpeg' },
}));

describe('renderVideoCover', () => {
    it('saves the first frame as a JPEG and releases the player', async () => {
        await expect(renderVideoCover('file:///clip.mp4')).resolves.toBe('file:///cache/cover.jpg');
        expect(native.generateThumbnailsAsync).toHaveBeenCalledWith(0, {
            maxHeight: 192,
            maxWidth: 192,
        });
        expect(native.saveAsync).toHaveBeenCalledWith({ compress: 0.7, format: 'jpeg' });
        expect(native.release).toHaveBeenCalledTimes(1);
    });

    it('releases the player when no frame comes back', async () => {
        native.release.mockClear();
        native.generateThumbnailsAsync.mockResolvedValueOnce([]);
        await expect(renderVideoCover('file:///clip.mp4')).rejects.toThrow('No frame');
        expect(native.release).toHaveBeenCalledTimes(1);
    });
});

describe('createVideoCoverCache', () => {
    it('grabs a video once and serves the cover from memory afterwards', async () => {
        const render = vi.fn(() => Promise.resolve('file:///cover.jpg'));
        const covers = createVideoCoverCache(render);
        expect(covers.peek('file:///a.mp4')).toBeUndefined();
        const [first, second] = await Promise.all([
            covers.load('file:///a.mp4'),
            covers.load('file:///a.mp4'),
        ]);
        expect(first).toBe('file:///cover.jpg');
        expect(second).toBe('file:///cover.jpg');
        expect(covers.peek('file:///a.mp4')).toBe('file:///cover.jpg');
        await covers.load('file:///a.mp4');
        expect(render).toHaveBeenCalledTimes(1);
    });

    it('remembers a video it cannot read as having no cover', async () => {
        const render = vi.fn(() => Promise.reject(new Error('unreadable')));
        const covers = createVideoCoverCache(render);
        await expect(covers.load('file:///broken.mp4')).resolves.toBeNull();
        expect(covers.peek('file:///broken.mp4')).toBeNull();
        await covers.load('file:///broken.mp4');
        expect(render).toHaveBeenCalledTimes(1);
    });
});

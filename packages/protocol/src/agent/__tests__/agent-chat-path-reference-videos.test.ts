import { describe, expect, it } from 'vitest';

import {
    agentChatMediaUrl,
    agentChatMessageVideoPaths,
    agentChatVideoByteRange,
    agentChatVideoContentType,
    isAgentChatVideoPath,
    parseAgentChatMediaUrl,
} from '../agent-chat-path-references';

describe('isAgentChatVideoPath', () => {
    it('recognizes the formats Chromium plays, in any case', () => {
        expect(isAgentChatVideoPath('/Users/me/Desktop/Recording 13.37.51.mov')).toBe(true);
        expect(isAgentChatVideoPath('/tmp/clip.MP4')).toBe(true);
        expect(isAgentChatVideoPath('/tmp/clip.webm')).toBe(true);
    });

    it('leaves other files, dotfiles, and folders named like videos alone', () => {
        expect(isAgentChatVideoPath('/tmp/clip.avi')).toBe(false);
        expect(isAgentChatVideoPath('/tmp/.mov')).toBe(false);
        expect(isAgentChatVideoPath('/tmp/notes')).toBe(false);
        expect(isAgentChatVideoPath('/tmp/clip.mov/')).toBe(false);
    });
});

describe('agentChatMediaUrl', () => {
    it('round-trips a path with spaces and non-ASCII characters', () => {
        const path = '/Users/me/Desktop/录屏2026-10-24 13.37.51.mov';
        expect(parseAgentChatMediaUrl(agentChatMediaUrl('video', path))).toEqual({
            kind: 'video',
            path,
        });
        expect(parseAgentChatMediaUrl(agentChatMediaUrl('poster', path))).toEqual({
            kind: 'poster',
            path,
        });
    });

    it('refuses anything that does not name a video by absolute path', () => {
        expect(parseAgentChatMediaUrl(agentChatMediaUrl('video', '/etc/passwd'))).toBeUndefined();
        expect(parseAgentChatMediaUrl(agentChatMediaUrl('video', 'clip.mov'))).toBeUndefined();
        expect(parseAgentChatMediaUrl('caxri-media://local/source?path=%2Fa.mov')).toBeUndefined();
        expect(parseAgentChatMediaUrl('caxri-media://other/video?path=%2Fa.mov')).toBeUndefined();
        expect(parseAgentChatMediaUrl('https://local/video?path=%2Fa.mov')).toBeUndefined();
        expect(parseAgentChatMediaUrl('not a url')).toBeUndefined();
    });

    it('asks for the thumbnail of any absolute path, file or folder, but never a relative one', () => {
        const pdf = '/Users/me/Downloads/季度预算说明.pdf';
        expect(parseAgentChatMediaUrl(agentChatMediaUrl('thumbnail', pdf))).toEqual({
            kind: 'thumbnail',
            path: pdf,
        });
        expect(parseAgentChatMediaUrl(agentChatMediaUrl('thumbnail', '/repo/src/'))).toEqual({
            kind: 'thumbnail',
            path: '/repo/src/',
        });
        expect(parseAgentChatMediaUrl(agentChatMediaUrl('thumbnail', 'a.pdf'))).toBeUndefined();
        expect(parseAgentChatMediaUrl(agentChatMediaUrl('poster', pdf))).toBeUndefined();
    });
});

describe('agentChatMessageVideoPaths', () => {
    it('lists each video the text cites once, in order, and skips other paths', () => {
        expect(
            agentChatMessageVideoPaths(
                "why does '/Users/me/Desktop/Recording 13.37.mov' differ from /tmp/b.mp4 and /tmp/notes.md, see /tmp/b.mp4 /tmp/clips.mov/",
            ),
        ).toEqual(['/Users/me/Desktop/Recording 13.37.mov', '/tmp/b.mp4']);
    });

    it('reads the reference lines a message starts with', () => {
        expect(
            agentChatMessageVideoPaths(
                '# Files mentioned by the user:\n\n## demo.mp4: /Users/me/Desktop/demo.mp4\n\n## notes.md: /tmp/notes.md\n\n## My request:\nlook',
            ),
        ).toEqual(['/Users/me/Desktop/demo.mp4']);
    });

    it('reads a reference line whose path holds a space, as a phone upload does', () => {
        expect(
            agentChatMessageVideoPaths(
                '# Files mentioned by the user:\n\n## 12701.mp4: /Users/me/Library/Application Support/Caxri/mobile-files/file_1/12701.mp4\n\n## My request for Claude:\nlook at /tmp/b.mov',
            ),
        ).toEqual([
            '/Users/me/Library/Application Support/Caxri/mobile-files/file_1/12701.mp4',
            '/tmp/b.mov',
        ]);
    });
});

describe('agentChatVideoContentType', () => {
    it('names the container by extension', () => {
        expect(agentChatVideoContentType('/tmp/a.MOV')).toBe('video/quicktime');
        expect(agentChatVideoContentType('/tmp/a.mp4')).toBe('video/mp4');
        expect(agentChatVideoContentType('/tmp/a.webm')).toBe('video/webm');
    });
});

describe('agentChatVideoByteRange', () => {
    it('reads the first, a middle, a suffix, and a clamped range', () => {
        expect(agentChatVideoByteRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
        expect(agentChatVideoByteRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3 });
        expect(agentChatVideoByteRange('bytes=4-6', 10)).toEqual({ start: 4, end: 6 });
        expect(agentChatVideoByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
        expect(agentChatVideoByteRange('bytes=5-99', 10)).toEqual({ start: 5, end: 9 });
    });

    it('sends the whole file for no or a multi-part range, and refuses one past the end', () => {
        expect(agentChatVideoByteRange(null, 10)).toBeUndefined();
        expect(agentChatVideoByteRange('bytes=0-1,4-5', 10)).toBeUndefined();
        expect(agentChatVideoByteRange('bytes=10-', 10)).toBe('unsatisfiable');
        expect(agentChatVideoByteRange('bytes=6-2', 10)).toBe('unsatisfiable');
        expect(agentChatVideoByteRange('bytes=-0', 10)).toBe('unsatisfiable');
    });
});

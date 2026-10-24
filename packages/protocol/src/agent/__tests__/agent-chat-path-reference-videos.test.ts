import { describe, expect, it } from 'vitest';

import {
    agentChatMediaUrl,
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
});

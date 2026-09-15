import { describe, expect, it } from 'vitest';

import { remoteDebuggingChipCopy } from '../remote-debugging-label';

describe('remoteDebuggingChipCopy', () => {
    it('says nothing when no debugging channel is open', () => {
        expect(remoteDebuggingChipCopy({ transport: 'disabled' })).toBeUndefined();
    });

    it('names the loopback address a listening port accepts connections on', () => {
        const copy = remoteDebuggingChipCopy({ port: '9224', transport: 'port' });
        expect(copy?.text).toBe('Debug port');
        expect(copy?.description).toContain('127.0.0.1:9224');
        expect(copy?.description).toContain('act as you');
    });

    /**
     * `--remote-debugging-port` with no number leaves Chromium to pick one it never reports back. The chip still has to
     * disclose that something is listening rather than go silent or print an empty address.
     */
    it('still discloses a port whose number the launch never fixed', () => {
        const copy = remoteDebuggingChipCopy({ transport: 'port' });
        expect(copy?.text).toBe('Debug port');
        expect(copy?.description).toContain('loopback port');
        expect(copy?.description).not.toContain('pipe');
    });

    /**
     * A pipe is opened by the launcher and has no address to print, so the sentence has to describe the channel instead
     * of leaving a dangling "on" with nothing after it.
     */
    it('describes a pipe without inventing an address', () => {
        const copy = remoteDebuggingChipCopy({ transport: 'pipe' });
        expect(copy?.text).toBe('Debug pipe');
        expect(copy?.description).not.toContain('127.0.0.1');
        expect(copy?.description).toContain('pipe');
    });
});

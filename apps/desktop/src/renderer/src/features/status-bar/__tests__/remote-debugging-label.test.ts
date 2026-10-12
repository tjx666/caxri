import { describe, expect, it } from 'vitest';

import { remoteDebuggingChipCopy } from '../remote-debugging-label';

describe('remoteDebuggingChipCopy', () => {
    it('says nothing when no debugging channel is open', () => {
        expect(remoteDebuggingChipCopy({ transport: 'disabled' })).toBeUndefined();
    });

    /**
     * DESIGN.md keeps a standing mode icon-only on the bar, so the copy carries no visible label for a chip to render.
     */
    it('gives the chip no visible label, only an accessible name and a tooltip', () => {
        const copy = remoteDebuggingChipCopy({ port: '9224', transport: 'port' });
        expect(copy).not.toHaveProperty('text');
        expect(copy).toHaveProperty('description');
    });

    it('names the loopback address a listening port accepts connections on', () => {
        const copy = remoteDebuggingChipCopy({ port: '9224', transport: 'port' });
        expect(copy?.description).toContain('127.0.0.1:9224');
        expect(copy?.description).toContain('act as you');
    });

    it('splits the tooltip into a heading, the address, the consequence, and the click hint', () => {
        const tooltip = remoteDebuggingChipCopy({ port: '9224', transport: 'port' })?.tooltip;
        expect(tooltip?.title).toBe('Accepting debugging connections');
        expect(tooltip?.rows).toEqual([
            { label: 'Address', value: '127.0.0.1:9224', isCode: true },
        ]);
        expect(tooltip?.notes?.[0]).toContain('act as you');
        expect(tooltip?.hint).toBe('Click to open the setting');
    });

    /**
     * `--remote-debugging-port` with no number leaves Chromium to pick one it never reports back. The chip still has to
     * disclose that something is listening rather than go silent or print an empty address.
     */
    it('still discloses a port whose number the launch never fixed', () => {
        const copy = remoteDebuggingChipCopy({ transport: 'port' });
        expect(copy?.description).toContain('loopback port');
        expect(copy?.description).not.toContain('pipe');
    });

    /**
     * A pipe is opened by the launcher and has no address to print, so the sentence has to describe the channel instead
     * of leaving a dangling "on" with nothing after it.
     */
    it('describes a pipe without inventing an address', () => {
        const copy = remoteDebuggingChipCopy({ transport: 'pipe' });
        expect(copy?.description).not.toContain('127.0.0.1');
        expect(copy?.description).toContain('pipe');
    });
});

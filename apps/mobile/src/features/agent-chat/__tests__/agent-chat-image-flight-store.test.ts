import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    AGENT_CHAT_FLIGHT_TIMEOUT_MS,
    endImageFlight,
    imageFlightsSnapshot,
    isImageFlying,
    landImageFlight,
    prepareImageFlights,
    registerImageFlightSource,
} from '../agent-chat-image-flight-store';

const view = (x: number, y: number, size = 64) => ({
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
        callback(x, y, size, size),
});

const tile = { height: 96, width: 96, x: 200, y: 300 };

describe('agent chat image flights', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.runAllTimers();
        vi.useRealTimers();
        for (const uri of ['a', 'b', 'c', 'd', 'e', 'hidden']) registerImageFlightSource(uri, null);
    });

    it('starts each sent image at its thumbnail and lands it on its tile', async () => {
        registerImageFlightSource('a', view(10, 700));
        await prepareImageFlights(['a', 'unknown']);
        expect(imageFlightsSnapshot().map(({ from, uri }) => ({ from, uri }))).toEqual([
            { from: { height: 64, width: 64, x: 10, y: 700 }, uri: 'a' },
        ]);
        expect(isImageFlying('a')).toBe(true);
        expect(isImageFlying('unknown')).toBe(false);
        landImageFlight('a', tile);
        const flight = imageFlightsSnapshot().at(0);
        expect(flight?.to).toEqual(tile);
        endImageFlight(flight?.id ?? 0);
        expect(isImageFlying('a')).toBe(false);
    });

    it('flies at most four images, and none whose thumbnail has no size', async () => {
        for (const [index, uri] of ['a', 'b', 'c', 'd', 'e'].entries())
            registerImageFlightSource(uri, view(index * 70, 700));
        registerImageFlightSource('hidden', view(0, 0, 0));
        await prepareImageFlights(['hidden', 'a', 'b', 'c', 'd', 'e']);
        expect(imageFlightsSnapshot().map(({ uri }) => uri)).toEqual(['a', 'b', 'c']);
    });

    it('ends a flight whose tile never lays out, so the tile is never left hidden', async () => {
        registerImageFlightSource('a', view(10, 700));
        await prepareImageFlights(['a']);
        vi.advanceTimersByTime(AGENT_CHAT_FLIGHT_TIMEOUT_MS);
        expect(isImageFlying('a')).toBe(false);
    });
});

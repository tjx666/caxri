import { notifyListeners } from '../../lib/notify-listeners';

/**
 * The phone's counterpart of Desktop's sent-image flight (`agent-chat-sent-image-flight.ts` in the Renderer): on Send,
 * each composer thumbnail flies into its tile in the pending message, so the images visibly go with the message instead
 * of vanishing from the strip. The composer measures the thumbnails before it clears them (`prepareImageFlights`), each
 * pending tile reports where it laid out (`landImageFlight`) and stays hidden while its image is in the air, and the
 * Session screen's overlay (`AgentChatImageFlights`) animates every landed flight and ends it.
 */

/**
 * A window-space box, as `measureInWindow` reports it.
 */
export interface AgentChatFlightBox {
    height: number;
    width: number;
    x: number;
    y: number;
}

/**
 * One sent image crossing from its composer thumbnail to its tile; `to` is unset until the tile lays out.
 */
export interface AgentChatImageFlight {
    from: AgentChatFlightBox;
    id: number;
    to?: AgentChatFlightBox;
    uri: string;
}

/**
 * What `measureInWindow` needs, so a test can stand in for a native view.
 */
export interface AgentChatFlightMeasurable {
    measureInWindow: (
        callback: (x: number, y: number, width: number, height: number) => void,
    ) => void;
}

/**
 * Beyond this many images the rest leave without flying, as on Desktop: a dozen tiles crossing at once read as noise.
 */
const MAX_FLYING_IMAGES = 4;

/**
 * Every flight ends by this long after Send, landed or not, so a tile that never laid out (the send failed at once, the
 * screen went away) or a flight no overlay animated never leaves its tile hidden.
 */
export const AGENT_CHAT_FLIGHT_TIMEOUT_MS = 2000;

const sources = new Map<string, AgentChatFlightMeasurable>();
const listeners = new Set<(value: undefined) => void>();
/**
 * The flights in the air and the id the next one takes.
 */
const state: { flights: readonly AgentChatImageFlight[]; nextId: number } = {
    flights: [],
    nextId: 1,
};

const publish = (next: readonly AgentChatImageFlight[]): void => {
    state.flights = next;
    notifyListeners(listeners, undefined);
};

/**
 * Records the strip thumbnail showing `uri`, so a send can measure where its flight starts; `null` forgets it.
 */
export function registerImageFlightSource(
    uri: string,
    view: AgentChatFlightMeasurable | null,
): void {
    if (view) sources.set(uri, view);
    else sources.delete(uri);
}

/**
 * Where `view` sits in the window, or `undefined` while it has no size.
 */
export const measureImageFlightBox = (
    view: AgentChatFlightMeasurable,
): Promise<AgentChatFlightBox | undefined> =>
    new Promise((resolve) => {
        view.measureInWindow((x, y, width, height) =>
            resolve(width > 0 && height > 0 ? { height, width, x, y } : undefined),
        );
    });

/**
 * Measures the thumbnails of `uris` before the composer clears them and queues their flights, each waiting for its
 * tile. Resolves once measured, so the caller clears the composer right after.
 */
export async function prepareImageFlights(uris: readonly string[]): Promise<void> {
    const measured = await Promise.all(
        uris.slice(0, MAX_FLYING_IMAGES).map(async (uri) => {
            const view = sources.get(uri);
            const from = view ? await measureImageFlightBox(view) : undefined;
            return from ? { from, uri } : undefined;
        }),
    );
    const queued = measured.flatMap((flight) => {
        if (!flight) return [];
        state.nextId += 1;
        return [{ ...flight, id: state.nextId }];
    });
    if (queued.length === 0) return;
    const ids = new Set(queued.map(({ id }) => id));
    // The same image sent again before its last flight ended replaces that flight.
    publish([
        ...state.flights.filter(({ uri }) => queued.every((flight) => flight.uri !== uri)),
        ...queued,
    ]);
    setTimeout(
        () => publish(state.flights.filter(({ id }) => !ids.has(id))),
        AGENT_CHAT_FLIGHT_TIMEOUT_MS,
    );
}

/**
 * Whether `uri` has a flight on its way; its tile stays hidden until the flight ends so the image never shows twice.
 */
export const isImageFlying = (uri: string): boolean =>
    state.flights.some((flight) => flight.uri === uri);

/**
 * Gives the flight of `uri` its landing box once the tile has laid out; a flight already landed keeps its box.
 */
export function landImageFlight(uri: string, to: AgentChatFlightBox): void {
    if (state.flights.every((flight) => !(flight.uri === uri && !flight.to))) return;
    publish(
        state.flights.map((flight) =>
            flight.uri === uri && !flight.to ? { ...flight, to } : flight,
        ),
    );
}

/**
 * Ends the flight `id`, revealing its tile.
 */
export function endImageFlight(id: number): void {
    if (state.flights.some((flight) => flight.id === id))
        publish(state.flights.filter((flight) => flight.id !== id));
}

export function subscribeImageFlights(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export const imageFlightsSnapshot = (): readonly AgentChatImageFlight[] => state.flights;

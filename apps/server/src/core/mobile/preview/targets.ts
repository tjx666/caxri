import path from 'node:path';

import type { MobilePreviewTarget } from '@caxri/protocol';

import type { ListeningProcesses, ListeningSocket } from './listening-ports';

const MAXIMUM_TARGETS = 32;

/**
 * A port the phone may preview, plus the address the proxy connects to on this computer.
 */
export interface PreviewTarget extends MobilePreviewTarget {
    host: string;
}

const isInside = (directory: string, root: string): boolean => {
    const relative = path.relative(root, directory);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * IPv4 loopback first: a dual-stack dev server answers on both, and the IPv4 socket is the one every tool reaches.
 */
const preferredSocket = (current: ListeningSocket, next: ListeningSocket): ListeningSocket =>
    current.host === '127.0.0.1' || next.host !== '127.0.0.1' ? current : next;

/**
 * The listening ports whose owning process works inside one of `roots` (the Session's directories), one entry per port
 * in ascending order. `excludedPids` keeps Server Core's own listeners, including the preview proxies, out of the list.
 * A process outside every root, such as a system service, is never offered.
 */
export function previewTargetsForRoots(
    listening: ListeningProcesses,
    roots: readonly string[],
    excludedPids: ReadonlySet<number>,
): PreviewTarget[] {
    const byPort = new Map<number, ListeningSocket>();
    for (const socket of listening.sockets) {
        if (excludedPids.has(socket.pid)) continue;
        const directory = listening.workingDirectories.get(socket.pid);
        if (!directory || roots.every((root) => !isInside(directory, root))) continue;
        const current = byPort.get(socket.port);
        byPort.set(socket.port, current ? preferredSocket(current, socket) : socket);
    }
    return byPort
        .values()
        .toArray()
        .toSorted((left, right) => left.port - right.port)
        .slice(0, MAXIMUM_TARGETS)
        .map(({ host, port, processName }) => ({ host, port, processName }));
}

const discardedSockets = new WeakSet<WebSocket>();

/**
 * Closes a gateway socket the client gave up on: an address-race loser, a socket past its open deadline, or one whose
 * pairing attempt was cancelled.
 *
 * React Native Android registers a socket in its native module only once it opens, so `close()` on a socket that is
 * still CONNECTING is silently dropped and the socket opens anyway
 * (https://github.com/facebook/react-native/issues/35554). Left alone it idles until Server's handshake deadline and is
 * counted as a spurious `handshakeTimeout`. A one-shot `open` listener closes it again once native owns it; the
 * `error`/`close` listeners drop that hook when the socket ends first. Idempotent per socket.
 */
export const discardSocket = (socket: WebSocket): void => {
    if (discardedSockets.has(socket)) return;
    discardedSockets.add(socket);
    function forget(): void {
        socket.removeEventListener('open', closeLateOpen);
        socket.removeEventListener('error', forget);
        socket.removeEventListener('close', forget);
    }
    function closeLateOpen(): void {
        forget();
        socket.close();
    }
    socket.addEventListener('open', closeLateOpen, { once: true });
    socket.addEventListener('error', forget, { once: true });
    socket.addEventListener('close', forget, { once: true });
    socket.close();
};

/**
 * A discarded socket that opens late must never carry a handshake.
 */
export const isSocketDiscarded = (socket: WebSocket): boolean => discardedSockets.has(socket);

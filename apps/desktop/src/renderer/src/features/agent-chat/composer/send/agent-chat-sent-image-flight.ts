import { flushSync } from 'react-dom';

import { motionDurationMs, motionEasing, motionSettleTimeoutMs } from '../../../../lib/motion';

/**
 * Beyond this many images, the rest leave the composer without flying: a dozen tiles crossing the Chat at once read as
 * noise rather than "these went with the message".
 */
const MAX_FLYING_IMAGES = 4;
const DURATION_TOKEN = '--motion-image-send';

type Box = Pick<DOMRect, 'height' | 'left' | 'top' | 'width'>;

function isOnScreen(rect: DOMRect): boolean {
    return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
    );
}

const MESSAGE_TILE = 'img[data-agent-chat-message-image]';

/**
 * The tile an image is landing on now: the pending row's while it shows, then the accepted message's, which wears the
 * same thumbnail. Tiles already on the page at send time (an earlier message with the same screenshot) and other
 * pending rows (the same screenshot sent again) are never this message's, so the first remaining match is.
 */
function landingTile(
    pendingTile: HTMLImageElement,
    source: string,
    earlierTiles: ReadonlySet<HTMLImageElement>,
): HTMLImageElement | undefined {
    if (pendingTile.isConnected) return pendingTile;
    return [...document.querySelectorAll<HTMLImageElement>(MESSAGE_TILE)].find(
        (tile) =>
            tile.src === source &&
            !earlierTiles.has(tile) &&
            !tile.closest('[data-agent-chat-pending-id]'),
    );
}

function boxKeyframe({ height, left, top, width }: Box, borderRadius: string): Keyframe {
    return {
        borderRadius,
        height: `${height}px`,
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
    };
}

/**
 * Sends a message with images so each composer thumbnail flies into its tile in the pending message. `send` must
 * synchronously show the pending row and clear the sent attachments, and return the pending row's id; it runs inside
 * `flushSync`, so the tiles exist when this returns that id.
 *
 * A same-document View Transition was tried first and dropped: the browser skips a transition as soon as a captured
 * element stops rendering, and the pending row gives way to the accepted message as soon as the provider records it,
 * often within the flight, so the images jumped instead of flying. Each image here flies as a detached clone (FLIP with
 * the Web Animations API) instead, which nothing in the Chat can interrupt: it starts on the thumbnail and lands on
 * wherever its tile is by then, the pending row's or the accepted message's, which stays hidden until it does.
 *
 * Images pair by order, the order the pending row lists them in. A thumbnail or tile off screen (a Chat scrolled up, a
 * message queued outside the timeline) does not fly, so nothing crosses the whole window. Sends plainly under reduced
 * motion, read per send since this runs outside render.
 */
export function sendWithAgentChatImageFlight(
    attachmentIds: readonly string[],
    send: () => string,
): string {
    const canFly =
        attachmentIds.length > 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sources = canFly
        ? attachmentIds.slice(0, MAX_FLYING_IMAGES).flatMap((id, index) => {
              const image = document.querySelector<HTMLImageElement>(
                  `img[data-agent-chat-composer-image="${CSS.escape(id)}"]`,
              );
              const rect = image?.getBoundingClientRect();
              return image && rect && isOnScreen(rect)
                  ? [{ index, rect, radius: getComputedStyle(image).borderRadius, src: image.src }]
                  : [];
          })
        : [];
    const pendingId = flushSync(send);
    const tiles = [
        ...document.querySelectorAll<HTMLImageElement>(
            `[data-agent-chat-pending-id="${CSS.escape(pendingId)}"] ${MESSAGE_TILE}`,
        ),
    ];
    const flights = sources.flatMap((source) => {
        const tile = tiles.at(source.index);
        if (!tile) return [];
        const clone = document.createElement('img');
        clone.alt = '';
        clone.className = 'agent-chat-image-flight';
        clone.src = source.src;
        Object.assign(clone.style, boxKeyframe(source.rect, source.radius));
        document.body.append(clone);
        tile.style.visibility = 'hidden';
        return [
            {
                animation: undefined as Animation | undefined,
                clone,
                hidden: new Set([tile]),
                source,
                tile,
            },
        ];
    });
    if (flights.length === 0) return pendingId;
    const earlierTiles = new Set(document.querySelectorAll<HTMLImageElement>(MESSAGE_TILE));
    let isSettled = false;
    const settle = (): void => {
        if (isSettled) return;
        isSettled = true;
        for (const { animation, clone, hidden } of flights) {
            animation?.cancel();
            clone.remove();
            for (const tile of hidden) tile.style.visibility = '';
        }
    };
    // A hidden window runs no frames, so the flight would never land; this bound (plus the measuring frame) releases the
    // tiles regardless.
    setTimeout(settle, motionSettleTimeoutMs(DURATION_TOKEN) + 50);
    const options: KeyframeAnimationOptions = {
        duration: motionDurationMs(DURATION_TOKEN),
        easing: `cubic-bezier(${motionEasing('--motion-ease-emphasized').join(', ')})`,
        fill: 'forwards',
    };
    // Measured a frame later, after the transcript followed the new row, then again every frame: the row gives way to
    // the accepted message and the transcript scrolls as the reply arrives, and the image lands wherever its tile is now.
    requestAnimationFrame(() => {
        const animations = flights.flatMap((flight) => {
            if (!isOnScreen(flight.tile.getBoundingClientRect())) {
                flight.clone.remove();
                flight.tile.style.visibility = '';
                return [];
            }
            const keyframes = (target: HTMLImageElement): Keyframe[] => [
                boxKeyframe(flight.source.rect, flight.source.radius),
                boxKeyframe(target.getBoundingClientRect(), getComputedStyle(target).borderRadius),
            ];
            const effect = new KeyframeEffect(flight.clone, keyframes(flight.tile), options);
            const animation = new Animation(effect);
            flight.animation = animation;
            animation.play();
            const follow = (): void => {
                if (isSettled || animation.playState !== 'running') return;
                const target = landingTile(flight.tile, flight.source.src, earlierTiles);
                if (target) {
                    target.style.visibility = 'hidden';
                    flight.hidden.add(target);
                    effect.setKeyframes(keyframes(target));
                }
                requestAnimationFrame(follow);
            };
            requestAnimationFrame(follow);
            return [animation.finished];
        });
        void Promise.allSettled(animations).then(settle);
    });
    return pendingId;
}

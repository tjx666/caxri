import {
    adbShell,
    androidBounds,
    mobileDisplayState,
    mobileSemantics,
    tapMobileCheck,
} from './mobile-android';

export async function tapTerminalKey(serial: string, key: 'down' | 'enter'): Promise<void> {
    const checkId = `terminal-key-${key}`;
    const display = await mobileDisplayState(serial);
    const frame = display.size.override ?? display.size.physical;
    const isOnFrame = (bounds: NonNullable<ReturnType<typeof androidBounds>>): boolean =>
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= frame.width &&
        bounds.bottom <= frame.height;
    for (let attempt = 0; attempt < 6; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- every swipe needs a fresh sanitized device view.
        const nodes = await mobileSemantics(serial);
        if (nodes.every(({ checkId }) => checkId !== 'session-detail'))
            throw new Error('Android left Session detail while locating a Terminal key');
        const target = nodes.find((node) => node.checkId === checkId);
        if (target?.clickable && target.enabled) {
            const targetBounds = androidBounds(target.bounds);
            if (targetBounds && isOnFrame(targetBounds)) {
                // eslint-disable-next-line no-await-in-loop -- this is the only reachable key after inspection.
                await tapMobileCheck(serial, checkId);
                return;
            }
        }
        const visibleKeys = nodes
            .filter(({ checkId: id }) =>
                /^terminal-key-(?:escape|tab|shift-tab|ctrl|up|down|left|right|[123]|enter|paste)$/u.test(
                    id,
                ),
            )
            .map((node) => androidBounds(node.bounds))
            .filter((bounds): bounds is NonNullable<typeof bounds> =>
                Boolean(bounds && isOnFrame(bounds)),
            )
            .toSorted((left, right) => left.left - right.left);
        const first = visibleKeys.at(0);
        if (!first)
            throw new Error(
                `Android Terminal has no visible key to locate its row: ${JSON.stringify(
                    {
                        frame,
                        keys: nodes
                            .filter(({ checkId: id }) => id.startsWith('terminal-key-'))
                            .map(({ bounds, checkId, clickable, enabled }) => ({
                                bounds,
                                checkId,
                                clickable,
                                enabled,
                            })),
                    },
                    null,
                    2,
                )}`,
            );
        const last = visibleKeys.at(-1) ?? first;
        const y = Math.floor((first.top + first.bottom) / 2);
        /**
         * Android Back swipes begin at either edge, so keep the key-row gesture inside the screen.
         *
         * @see https://developer.android.com/develop/ui/views/touch-and-input/gestures/gesturenav
         */
        const edgeInset = Math.floor(frame.width / 5);
        const startX = Math.min(
            frame.width - edgeInset,
            Math.max(last.right - 8, first.right + 80),
        );
        const endX = Math.max(edgeInset, first.left + 8);
        if (startX <= endX) throw new Error('Android Terminal key row cannot be scrolled');
        // eslint-disable-next-line no-await-in-loop -- the next semantic inspection must observe this gesture.
        await adbShell(serial, [
            'input',
            'swipe',
            String(startX),
            String(y),
            String(endX),
            String(y),
            '300',
        ]);
    }
    throw new Error(`Android Terminal ${key} key could not be reached`);
}

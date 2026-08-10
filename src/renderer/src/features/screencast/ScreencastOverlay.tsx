import { useEffect, useRef, useState } from 'react';

import { getRegisteredCommand } from '../../commands/registry';
import { ShortcutBadge } from '../../components/ShortcutBadge';
import { isEditableEventTarget } from '../../lib/keybindings';
import { useWorkbenchStore } from '../../stores/workbench';
import {
    describeScreencastKey,
    useScreencastStore,
    type ScreencastKeyDescription,
} from './screencast';

const CLICK_LIFETIME_MS = 700;
const KEY_LIFETIME_MS = 1_500;

interface ClickMarker {
    id: number;
    x: number;
    y: number;
}

interface KeyOverlay extends ScreencastKeyDescription {
    id: number;
}

function ActiveScreencastOverlay() {
    const keybindings = useWorkbenchStore((state) => state.bootstrap?.keybindings ?? []);
    const [clicks, setClicks] = useState<ClickMarker[]>([]);
    const [keyOverlay, setKeyOverlay] = useState<KeyOverlay>();
    const nextId = useRef(0);
    const clickTimers = useRef(new Set<number>());
    const keyTimer = useRef<number | undefined>(undefined);

    useEffect(() => {
        const onPointerDown = (event: PointerEvent): void => {
            const marker = { id: ++nextId.current, x: event.clientX, y: event.clientY };
            setClicks((current) => [...current, marker]);
            const timer = window.setTimeout(() => {
                clickTimers.current.delete(timer);
                setClicks((current) => current.filter((item) => item.id !== marker.id));
            }, CLICK_LIFETIME_MS);
            clickTimers.current.add(timer);
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            const description = describeScreencastKey(event, keybindings, {
                commandAllowsEditable: (commandId) =>
                    getRegisteredCommand(commandId)?.allowInEditable === true,
                editable: isEditableEventTarget(event.target),
            });
            if (!description) return;
            setKeyOverlay({ ...description, id: ++nextId.current });
            if (keyTimer.current !== undefined) window.clearTimeout(keyTimer.current);
            keyTimer.current = window.setTimeout(() => setKeyOverlay(undefined), KEY_LIFETIME_MS);
        };

        window.addEventListener('pointerdown', onPointerDown, { capture: true });
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => {
            window.removeEventListener('pointerdown', onPointerDown, { capture: true });
            window.removeEventListener('keydown', onKeyDown, { capture: true });
            for (const timer of clickTimers.current) window.clearTimeout(timer);
            clickTimers.current.clear();
            if (keyTimer.current !== undefined) window.clearTimeout(keyTimer.current);
        };
    }, [keybindings]);

    return (
        <div
            aria-live="polite"
            className="pointer-events-none fixed inset-0 z-[100] overflow-hidden"
            data-screencast-overlay
        >
            {clicks.map((click) => (
                <span
                    key={click.id}
                    aria-hidden="true"
                    className="absolute size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-[color-mix(in_srgb,var(--accent)_24%,transparent)] motion-safe:animate-ping"
                    data-screencast-click
                    style={{ left: click.x, top: click.y }}
                />
            ))}
            {keyOverlay && (
                <div
                    key={keyOverlay.id}
                    className="absolute bottom-10 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-elevated px-3 py-2 text-[13px] text-foreground shadow-[0_8px_24px_var(--shadow)] motion-safe:animate-in fade-in-0 zoom-in-95"
                    data-screencast-key
                >
                    <ShortcutBadge shortcut={keyOverlay.shortcut} />
                    {keyOverlay.commandTitle && <span>{keyOverlay.commandTitle}</span>}
                </div>
            )}
        </div>
    );
}

export function ScreencastOverlay() {
    const enabled = useScreencastStore((state) => state.enabled);
    return enabled ? <ActiveScreencastOverlay /> : null;
}

const SCROLL_IDLE_MS = 120;
const MOMENTUM_IDLE_MS = 160;

/**
 * Keeps list order fixed until touch, drag, and momentum have all settled.
 */
export const createSessionListInteraction = (begin: () => void, finish: () => void) => {
    let isTouching = false;
    let isDragging = false;
    let hasMomentum = false;
    let isActive = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelIdle = (): void => {
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = null;
    };
    const activate = (): void => {
        cancelIdle();
        if (isActive) return;
        isActive = true;
        begin();
    };
    const settle = (): void => {
        cancelIdle();
        idleTimer = setTimeout(
            () => {
                idleTimer = null;
                if (isTouching || isDragging || !isActive) return;
                /**
                 * A missing momentum-end event must not leave the list frozen after scrolling stops.
                 */
                hasMomentum = false;
                isActive = false;
                finish();
            },
            hasMomentum ? MOMENTUM_IDLE_MS : SCROLL_IDLE_MS,
        );
    };
    return {
        touchStart: (): void => {
            isTouching = true;
            activate();
        },
        touchEnd: (): void => {
            isTouching = false;
            settle();
        },
        touchCancel: (): void => {
            isTouching = false;
            isDragging = false;
            settle();
        },
        dragStart: (): void => {
            isDragging = true;
            activate();
        },
        dragEnd: (): void => {
            isDragging = false;
            settle();
        },
        momentumStart: (): void => {
            hasMomentum = true;
            activate();
        },
        momentumEnd: (): void => {
            hasMomentum = false;
            settle();
        },
        scroll: (): void => {
            if (isActive) settle();
        },
        dispose: (): void => {
            cancelIdle();
            isTouching = false;
            isDragging = false;
            hasMomentum = false;
            if (!isActive) return;
            isActive = false;
            finish();
        },
    };
};

import { afterEach, describe, expect, it, vi } from 'vitest';

import { reconcileSessionAnimations } from '../hidden-session-transitions';

class FakeAnimation {
    playState = 'running';
    cancel = vi.fn();
    pause = vi.fn(() => {
        this.playState = 'paused';
    });
    play = vi.fn(() => {
        this.playState = 'running';
    });
}
class FakeTransition extends FakeAnimation {}
class FakeCSSAnimation extends FakeAnimation {}

afterEach(() => {
    vi.unstubAllGlobals();
});

function session(isHidden: boolean, animations: FakeAnimation[]) {
    return {
        hasAttribute: () => isHidden,
        getAnimations: vi.fn(() => animations),
        setHidden(isNextHidden: boolean) {
            isHidden = isNextHidden;
        },
    };
}

function rootOf(...sessions: object[]) {
    return { querySelectorAll: vi.fn(() => sessions) } as unknown as ParentNode;
}

describe('reconcileSessionAnimations', () => {
    it('cancels transitions, pauses running animations, and resumes only those on show', () => {
        vi.stubGlobal('CSSTransition', FakeTransition);
        vi.stubGlobal('CSSAnimation', FakeCSSAnimation);
        const transition = new FakeTransition();
        const running = new FakeCSSAnimation();
        const alreadyPaused = new FakeCSSAnimation();
        alreadyPaused.playState = 'paused';
        const target = session(true, [transition, running, alreadyPaused]);
        const root = rootOf(target);

        reconcileSessionAnimations(root);
        reconcileSessionAnimations(root);

        expect(target.getAnimations).toHaveBeenCalledWith({ subtree: true });
        expect(transition.cancel).toHaveBeenCalled();
        expect(running.pause).toHaveBeenCalledOnce();
        expect(alreadyPaused.pause).not.toHaveBeenCalled();

        target.setHidden(false);
        reconcileSessionAnimations(root);
        reconcileSessionAnimations(root);

        expect(running.play).toHaveBeenCalledOnce();
        expect(alreadyPaused.play).not.toHaveBeenCalled();
    });

    it('leaves a visible Session that was never paused alone', () => {
        vi.stubGlobal('CSSTransition', FakeTransition);
        vi.stubGlobal('CSSAnimation', FakeCSSAnimation);
        const target = session(false, [new FakeCSSAnimation()]);

        reconcileSessionAnimations(rootOf(target));

        expect(target.getAnimations).not.toHaveBeenCalled();
    });
});

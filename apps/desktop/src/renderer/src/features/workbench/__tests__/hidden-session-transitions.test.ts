import { afterEach, describe, expect, it, vi } from 'vitest';

import { cancelHiddenSessionTransitions } from '../hidden-session-transitions';

class FakeAnimation {
    cancel = vi.fn();
}
class FakeTransition extends FakeAnimation {}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('cancelHiddenSessionTransitions', () => {
    it('cancels transitions in hidden Sessions and leaves CSS animations running', () => {
        vi.stubGlobal('CSSTransition', FakeTransition);
        const transition = new FakeTransition();
        const animation = new FakeAnimation();
        const getAnimations = vi.fn(() => [transition, animation]);
        const querySelectorAll = vi.fn(() => [{ getAnimations }]);
        const root = { querySelectorAll } as unknown as ParentNode;

        cancelHiddenSessionTransitions(root);

        expect(querySelectorAll).toHaveBeenCalledWith('.workbench-session[hidden]');
        expect(getAnimations).toHaveBeenCalledWith({ subtree: true });
        expect(transition.cancel).toHaveBeenCalledOnce();
        expect(animation.cancel).not.toHaveBeenCalled();
    });
});

import { composerByteLength } from './session-composer-state';

const counters = {
    inputCalls: 0,
    updateCalls: 0,
    setDraftCalls: 0,
    visibleDraftCalls: 0,
    focusCalls: 0,
    keyCalls: 0,
    pulseCalls: 0,
    providerGeneration: 0,
};

/**
 * Temporary Stage 6 probe. Only counts and booleans may enter the device log.
 */
const report = (details: Record<string, boolean | number | string>): void => {
    console.info(`CAXRI_COMPOSER_DIAG ${JSON.stringify(details)}`);
};

export const recordComposerInput = (value: string): void => {
    counters.inputCalls += 1;
    report({ stage: 'onChangeText', calls: counters.inputCalls, bytes: composerByteLength(value) });
};

export const recordComposerFocus = (): void => {
    counters.focusCalls += 1;
    report({ stage: 'onFocus', calls: counters.focusCalls });
};

export const recordComposerKey = (): void => {
    counters.keyCalls += 1;
    report({ stage: 'onKeyPress', calls: counters.keyCalls });
};

export const recordComposerPulse = (isActive: boolean): void => {
    counters.pulseCalls += 1;
    report({ stage: 'js-pulse', calls: counters.pulseCalls, isActive });
};

export const recordComposerUpdate = (value: string, isBusy: boolean, isEqual: boolean): void => {
    counters.updateCalls += 1;
    report({
        stage: 'updateDraft',
        calls: counters.updateCalls,
        bytes: composerByteLength(value),
        isBusy,
        isEqual,
    });
};

export const recordHostSessionsDraft = (value: string): void => {
    counters.setDraftCalls += 1;
    report({ stage: 'setDraft', calls: counters.setDraftCalls, bytes: composerByteLength(value) });
};

export const recordVisibleComposerDraft = (value: string): void => {
    counters.visibleDraftCalls += 1;
    report({
        stage: 'visibleDraft',
        calls: counters.visibleDraftCalls,
        bytes: composerByteLength(value),
    });
};

export const recordHostSessionsMount = (): (() => void) => {
    counters.providerGeneration += 1;
    const generation = counters.providerGeneration;
    report({ stage: 'provider-mount', generation });
    return () => report({ stage: 'provider-unmount', generation });
};

import { expect, test } from '@playwright/test';

function sharedFailure(): never {
    throw new Error('deterministic shared census failure');
}

test('census failure one', () => {
    sharedFailure();
});

test('census failure two', () => {
    sharedFailure();
});

test('census failure three', () => {
    sharedFailure();
});

test('census suppressed failure', () => {
    sharedFailure();
});

test('census suppressed pass', () => {
    expect(true).toBe(true);
});

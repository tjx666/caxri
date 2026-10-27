import { describe, expect, it } from 'vitest';

import { botMethods } from '../bot/caxri-bot-contract.js';

describe('caxriBot.open parameters', () => {
    const parameters = botMethods['caxriBot.open'].params;

    it('keeps a plain open parameter-free', () => {
        expect(parameters.parse(undefined)).toEqual({});
        expect(parameters.parse({})).toEqual({});
    });

    it('accepts the Inbox as the one target the window can open to', () => {
        expect(parameters.parse({ target: 'inbox' })).toEqual({ target: 'inbox' });
    });

    it('rejects an unknown target or an extra field instead of opening the window plainly', () => {
        expect(parameters.safeParse({ target: 'board' }).success).toBe(false);
        expect(parameters.safeParse({ target: 'inbox', itemId: 'item-1' }).success).toBe(false);
    });
});

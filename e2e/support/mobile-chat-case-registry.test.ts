import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectAndroidChatCases } from '../../scripts/mobile-android-chat-case-collector';
import { collectMobileChatCaseHandlers, mobileChatCaseGroups } from './mobile-chat-case-registry';

const definitionsDirectory = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../scripts/mobile-android-chat-cases',
);

describe('mobile Chat case registry', () => {
    it('pairs every definition group with a handler group of the same name', () => {
        const definitionGroups = readdirSync(definitionsDirectory)
            .filter((file) => file.endsWith('.ts'))
            .map((file) => file.slice(0, -'.ts'.length))
            .toSorted((a, b) => a.localeCompare(b));
        expect(mobileChatCaseGroups()).toEqual(definitionGroups);
    });

    it('registers exactly one handler for every defined case id', async () => {
        const definitions = await collectAndroidChatCases();
        const handlers = await collectMobileChatCaseHandlers();
        expect(
            handlers
                .keys()
                .toArray()
                .toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(Object.keys(definitions).toSorted((a, b) => a.localeCompare(b)));
    });
});

import { commandDefinitions, workbenchCoreContributions } from '@caxri/protocol';
import {
    commandCategoryKey,
    commandDescriptionKey,
    commandTitleKey,
} from '@desktop-shared/i18n/command-keys';
import { commands as enCommands } from '@desktop-shared/i18n/en/commands';
import { commands as zhCommands } from '@desktop-shared/i18n/zh-cn/commands';
import { describe, expect, it } from 'vitest';

import type { Translate } from '../../../i18n';
import { withLocale } from '../../../i18n';
import { commandCategory, commandDescription, commandTitle } from '../../../lib/command-labels';
import { staticCommandSearchEntry } from '../command-palette-commands';
import { paletteSearchScore } from '../palette-search';

const enKeys: ReadonlySet<string> = new Set(Object.keys(enCommands));
const zhCN: Readonly<Record<string, string>> = zhCommands;
const translateZhCN: Translate = withLocale((key) => zhCN[key] ?? key, 'zh-CN');

describe('commands namespace coverage', () => {
    it('translates the title, category, and description of every protocol catalog command', () => {
        const missing = commandDefinitions.flatMap((command) =>
            [
                commandTitleKey(command.id),
                commandCategoryKey(command.category),
                commandDescriptionKey(command.id),
            ].filter((key) => !enKeys.has(key)),
        );
        expect(missing).toEqual([]);
    });

    it('translates every Workbench Core contributed command the palette lists', () => {
        const missing = workbenchCoreContributions
            .flatMap(({ commands }) => commands)
            .map(({ id }) => commandTitleKey(id))
            .filter((key) => !enKeys.has(key));
        expect(missing).toEqual([]);
    });

    it('keeps each English title identical to the catalog title it translates', () => {
        for (const command of commandDefinitions) {
            expect(enCommands[commandTitleKey(command.id) as keyof typeof enCommands]).toBe(
                command.title,
            );
        }
    });
});

describe('command labels', () => {
    const create = commandDefinitions.find(({ id }) => id === 'session.create');
    if (!create) throw new Error('session.create is missing from the command catalog');

    it('derives camelCase category keys', () => {
        expect(commandCategoryKey('Secondary Side Bar')).toBe('commands.category.secondarySideBar');
        expect(commandCategoryKey('View')).toBe('commands.category.view');
    });

    it('translates catalog commands and falls back to English for unknown ids', () => {
        expect(commandTitle(create, translateZhCN)).toBe('新建会话');
        expect(commandCategory(create.category, translateZhCN)).toBe('会话');
        expect(
            commandTitle({ id: 'publisher.fixture.action', title: 'Fixture' }, translateZhCN),
        ).toBe('Fixture');
        expect(commandCategory('Fixture Category', translateZhCN)).toBe('Fixture Category');
        expect(
            commandDescription({ id: 'publisher.fixture.action' }, translateZhCN),
        ).toBeUndefined();
    });

    it('matches palette searches in both English and the translated language', () => {
        const entry = staticCommandSearchEntry(create, translateZhCN);
        expect(paletteSearchScore(entry, 'new sess')).toBeGreaterThan(0.8);
        expect(paletteSearchScore(entry, '新建')).toBeGreaterThan(0.8);
    });
});

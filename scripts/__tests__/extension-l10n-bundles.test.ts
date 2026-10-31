import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Bundled extensions ship their Simplified Chinese copy as data the type checker cannot see: runtime messages keyed by
 * their English text in `l10n/bundle.l10n.zh-cn.json`, and manifest strings behind `%key%` placeholders in
 * `package.nls*.json`. A message added without a translation silently stays English, and a translation whose message
 * changed is dead weight, so these checks keep both sides in step.
 */
const EXTENSIONS = ['git', 'status'] as const;

const ROOT = path.resolve(import.meta.dirname, '../../extensions');

/**
 * A string literal passed as `l10n.t`'s first argument.
 */
const L10N_CALL = /\bl10n\.t\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Template lists a module passes to `l10n.t` by variable; their elements are messages too.
 */
const MESSAGE_LISTS: Readonly<Partial<Record<(typeof EXTENSIONS)[number], string>>> = {
    status: 'status-server-text.ts',
};

function readJson(file: string): Record<string, unknown> {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function unescape(literal: string): string {
    return literal.replaceAll(/\\(.)/g, '$1');
}

function runtimeMessages(extension: (typeof EXTENSIONS)[number]): Set<string> {
    const sourceDirectory = path.join(ROOT, extension, 'src');
    const messages = new Set<string>();
    for (const file of readdirSync(sourceDirectory)) {
        if (!file.endsWith('.ts')) continue;
        const source = readFileSync(path.join(sourceDirectory, file), 'utf8');
        for (const match of source.matchAll(L10N_CALL)) messages.add(unescape(match[2]));
        if (MESSAGE_LISTS[extension] === file) {
            for (const match of source.matchAll(/^\s+(['"])((?:\\.|(?!\1).)*)\1,$/gm))
                messages.add(unescape(match[2]));
        }
    }
    return messages;
}

function byText(left: string, right: string): number {
    return left.localeCompare(right);
}

function placeholders(message: string): string[] {
    return message
        .matchAll(PLACEHOLDER)
        .map((match) => match[1])
        .toArray()
        .toSorted(byText);
}

function manifestKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (typeof value === 'string') {
        const match = /^%(.+)%$/.exec(value);
        if (match) keys.add(match[1]);
    } else if (Array.isArray(value)) {
        for (const item of value) manifestKeys(item, keys);
    } else if (value && typeof value === 'object') {
        for (const item of Object.values(value)) manifestKeys(item, keys);
    }
    return keys;
}

describe.each(EXTENSIONS)('%s extension localization', (extension) => {
    const bundle = readJson(path.join(ROOT, extension, 'l10n', 'bundle.l10n.zh-cn.json'));

    it('translates every runtime message and nothing else', () => {
        const messages = runtimeMessages(extension);
        expect([...messages].filter((message) => !(message in bundle))).toEqual([]);
        expect(Object.keys(bundle).filter((message) => !messages.has(message))).toEqual([]);
    });

    it('keeps each runtime translation on its message placeholders', () => {
        const mismatched = Object.entries(bundle).filter(
            ([message, translation]) =>
                placeholders(message).join(',') !== placeholders(String(translation)).join(','),
        );
        expect(mismatched).toEqual([]);
    });

    it('resolves every manifest placeholder in both languages', () => {
        const keys = [
            ...manifestKeys(readJson(path.join(ROOT, extension, 'package.json'))),
        ].toSorted(byText);
        const english = readJson(path.join(ROOT, extension, 'package.nls.json'));
        const chinese = readJson(path.join(ROOT, extension, 'package.nls.zh-cn.json'));
        expect(Object.keys(english).toSorted(byText)).toEqual(keys);
        expect(Object.keys(chinese).toSorted(byText)).toEqual(keys);
    });
});

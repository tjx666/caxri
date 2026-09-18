import { describe, expect, it } from 'vitest';

import {
    expandLaunchArguments,
    formatLaunchArguments,
    parseLaunchArguments,
} from '../launch-arguments';

describe('parseLaunchArguments', () => {
    it('treats spaces and newlines as the same separator', () => {
        expect(parseLaunchArguments('--yolo\n--sandbox workspace')).toEqual([
            '--yolo',
            '--sandbox',
            'workspace',
        ]);
        expect(parseLaunchArguments('--yolo --sandbox workspace')).toEqual([
            '--yolo',
            '--sandbox',
            'workspace',
        ]);
    });

    it('keeps an equals-form flag as one token', () => {
        expect(parseLaunchArguments('--sandbox=workspace')).toEqual(['--sandbox=workspace']);
    });

    it('keeps a quoted value with spaces as one token', () => {
        expect(parseLaunchArguments('--model "opus 4"')).toEqual(['--model', 'opus 4']);
        expect(parseLaunchArguments("--model 'opus 4'")).toEqual(['--model', 'opus 4']);
    });

    it('drops empty fragments', () => {
        expect(parseLaunchArguments('  \n  --yolo  \n')).toEqual(['--yolo']);
        expect(parseLaunchArguments('')).toEqual([]);
    });
});

describe('expandLaunchArguments', () => {
    it('splits a persisted one-line flag and value', () => {
        expect(expandLaunchArguments(['--yolo', '--sandbox workspace'])).toEqual([
            '--yolo',
            '--sandbox',
            'workspace',
        ]);
    });

    it('leaves already-split argv and equals-form flags alone', () => {
        expect(expandLaunchArguments(['--sandbox', 'workspace', '--sandbox=off'])).toEqual([
            '--sandbox',
            'workspace',
            '--sandbox=off',
        ]);
    });

    it('does not re-tokenize a quoted value that already contains whitespace', () => {
        expect(expandLaunchArguments(['--model', 'opus 4'])).toEqual(['--model', 'opus 4']);
    });

    it('parses a persisted flag whose quoted value still sits in the same token', () => {
        expect(expandLaunchArguments(['--model "opus 4"'])).toEqual(['--model', 'opus 4']);
    });
});

describe('formatLaunchArguments', () => {
    it('writes a flag and its value on one line', () => {
        expect(formatLaunchArguments(['--yolo', '--sandbox', 'workspace'])).toBe(
            '--yolo\n--sandbox workspace',
        );
        expect(formatLaunchArguments(['--sandbox=workspace'])).toBe('--sandbox=workspace');
    });

    it('quotes a value that contains whitespace', () => {
        expect(formatLaunchArguments(['--model', 'opus 4'])).toBe('--model "opus 4"');
    });

    it('displays a persisted combined flag and value without quoting the whole fragment', () => {
        expect(formatLaunchArguments(['--yolo', '--sandbox workspace'])).toBe(
            '--yolo\n--sandbox workspace',
        );
    });
});

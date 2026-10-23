import { describe, expect, it } from 'vitest';

import {
    detectedEditorLanguage,
    firstLineLanguageExtension,
    rankDetectedLanguages,
} from '../language-detection';

describe('rankDetectedLanguages', () => {
    it('offers nothing when the top guess is not confident enough', () => {
        expect(rankDetectedLanguages([])).toEqual([]);
        expect(rankDetectedLanguages([{ languageId: 'py', confidence: 0.1 }])).toEqual([]);
    });

    it('penalizes languages the model guesses too eagerly', () => {
        expect(
            rankDetectedLanguages([
                { languageId: 'sql', confidence: 0.6 },
                { languageId: 'py', confidence: 0.1 },
            ]),
        ).toEqual([]);
    });

    it('offers a clearly separated leader', () => {
        expect(
            rankDetectedLanguages([
                { languageId: 'py', confidence: 0.9 },
                { languageId: 'rb', confidence: 0.05 },
            ]),
        ).toEqual(['py']);
    });

    it('offers a run of close guesses only once a weaker guess separates them', () => {
        expect(
            rankDetectedLanguages([
                { languageId: 'ts', confidence: 0.45 },
                { languageId: 'js', confidence: 0.4 },
                { languageId: 'md', confidence: 0.1 },
            ]),
        ).toEqual(['ts', 'js']);
    });
});

describe('firstLineLanguageExtension', () => {
    it('reads the interpreter a shebang names', () => {
        expect(firstLineLanguageExtension('#!/usr/bin/env python3\nprint(1)')).toBe('py');
        expect(firstLineLanguageExtension('#!/bin/bash')).toBe('sh');
        expect(firstLineLanguageExtension('#!/usr/bin/env node')).toBe('js');
        expect(firstLineLanguageExtension('#!/usr/bin/unknown')).toBeUndefined();
    });

    it('recognizes markup preambles', () => {
        expect(firstLineLanguageExtension('<?xml version="1.0"?>')).toBe('xml');
        expect(firstLineLanguageExtension('<!DOCTYPE html>\n<html>')).toBe('html');
        expect(firstLineLanguageExtension('<?php echo 1;')).toBe('php');
        expect(firstLineLanguageExtension('hello world')).toBeUndefined();
    });
});

describe('detectedEditorLanguage', () => {
    const registrations = [
        { id: 'python', extensions: ['.py'] },
        { id: 'typescript', extensions: ['.ts'] },
    ];

    it('takes the first candidate Monaco has a language for', () => {
        expect(detectedEditorLanguage(['erl', 'ts', 'py'], registrations)).toBe('typescript');
        expect(detectedEditorLanguage(['erl'], registrations)).toBeUndefined();
        expect(detectedEditorLanguage([], registrations)).toBeUndefined();
    });
});

import '../../../components/prism-grammars';

import { Prism } from 'prism-react-renderer';
import { describe, expect, it } from 'vitest';

import { codeLanguage, fileLanguage } from '../file-language';

describe('fileLanguage', () => {
    it('maps common source files to a bundled Prism grammar', () => {
        expect(fileLanguage('auth.test.ts')).toBe('typescript');
        expect(fileLanguage('index.auth.HTML')).toBe('markup');
        expect(fileLanguage('App.tsx')).toBe('tsx');
    });

    it('previews dotfiles, extensionless, and unknown files as plain text', () => {
        expect(fileLanguage('.gitignore')).toBeNull();
        expect(fileLanguage('Makefile')).toBeNull();
        expect(fileLanguage('notes.unknown')).toBeNull();
    });

    it('only names grammars the renderer actually bundles', () => {
        for (const name of [
            'a.c',
            'a.cpp',
            'a.css',
            'a.go',
            'a.gql',
            'a.html',
            'a.js',
            'a.json',
            'a.jsx',
        ])
            expect(Prism.languages[fileLanguage(name) ?? '']).toBeDefined();
        for (const name of [
            'a.kt',
            'a.m',
            'a.md',
            'a.py',
            'a.rs',
            'a.sql',
            'a.swift',
            'a.ts',
            'a.tsx',
            'a.yaml',
            'a.sh',
            'a.diff',
        ])
            expect(Prism.languages[fileLanguage(name) ?? '']).toBeDefined();
    });

    it('maps the language Agent Chat infers for output, painting anything unknown as plain text', () => {
        expect(codeLanguage('shell')).toBe('bash');
        expect(codeLanguage('diff')).toBe('diff');
        expect(codeLanguage('json')).toBe('json');
        expect(codeLanguage('TS')).toBe('typescript');
        expect(codeLanguage('unknownext')).toBeNull();
        expect(codeLanguage(undefined)).toBeNull();
    });
});

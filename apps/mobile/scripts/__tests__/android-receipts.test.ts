import { describe, expect, it } from 'vitest';

import {
    centerOfAndroidBounds,
    isAndroidCheckId,
    observeAndroidNodeFromUiAutomator,
    resumedPackageFromWindowDump,
    semanticNodesFromUiAutomator,
} from '../android-receipts';

describe('Android content-free receipts', () => {
    it('keeps only stable Caxri identifiers and structural fields', () => {
        const source = `<?xml version="1.0"?><hierarchy>
          <node text="private Session name" resource-id="pairing-entry-screen" class="android.view.View" package="com.caxri.mobile" content-desc="secret" clickable="false" enabled="true" bounds="[0,0][100,100]">
            <node text="Scan pairing code" resource-id="com.caxri.mobile:id/pairing-scan-button" class="android.widget.Button" package="com.caxri.mobile" clickable="true" enabled="true" bounds="[0,100][100,160]" />
          </node>
          <node text="Notification" resource-id="system-secret" class="android.widget.TextView" package="com.android.systemui" clickable="false" enabled="true" bounds="[0,0][1,1]" />
        </hierarchy>`;

        expect(semanticNodesFromUiAutomator(source)).toEqual([
            {
                bounds: '[0,0][100,100]',
                checkId: 'pairing-entry-screen',
                className: 'android.view.View',
                clickable: false,
                enabled: true,
                selected: false,
            },
            {
                bounds: '[0,100][100,160]',
                checkId: 'pairing-scan-button',
                className: 'android.widget.Button',
                clickable: true,
                enabled: true,
                selected: false,
            },
        ]);
        expect(JSON.stringify(semanticNodesFromUiAutomator(source))).not.toContain('private');
        expect(JSON.stringify(semanticNodesFromUiAutomator(source))).not.toContain('secret');
    });

    it('preserves bounded timeline controls with generation separators', () => {
        const checkId = 'conversation-group-tools:1a.2b.3c.0:4:0';
        const source = `<node resource-id="com.caxri.mobile:id/${checkId}" class="android.view.View" package="com.caxri.mobile" clickable="true" enabled="true" bounds="[0,0][100,100]" />`;
        expect(isAndroidCheckId(checkId)).toBe(true);
        expect(semanticNodesFromUiAutomator(source).map((node) => node.checkId)).toEqual([checkId]);
        expect(isAndroidCheckId('conversation-tool-$(touch /tmp/unsafe)')).toBe(false);
    });

    it('locates nested Add Project rows by their slash-containing test ID', () => {
        const checkId = 'add-project-folder-example/nested';
        const source = `<node resource-id="com.caxri.mobile:id/${checkId}" class="android.view.View" package="com.caxri.mobile" clickable="true" enabled="true" bounds="[0,0][100,100]" />`;
        expect(isAndroidCheckId(checkId)).toBe(true);
        expect(semanticNodesFromUiAutomator(source).map((node) => node.checkId)).toEqual([checkId]);
    });

    it('observes focus and decoded multiline Unicode without returning device text', () => {
        const source = `<hierarchy>
          <node resource-id="com.caxri.mobile:id/session-composer-input" package="com.caxri.mobile" focused="true" text="第一行&#10;第二行&#xA;A &amp; B" content-desc="private accessibility description" />
        </hierarchy>`;
        const expectedText = '第一行\n第二行\nA & B';

        const exact = observeAndroidNodeFromUiAutomator(source, 'session-composer-input', {
            kind: 'equals',
            value: expectedText,
        });
        expect(exact).toEqual({ exists: true, focused: true, textMatches: true });
        expect(
            observeAndroidNodeFromUiAutomator(source, 'session-composer-input', {
                kind: 'includes',
                value: '第二行\nA &',
            }),
        ).toEqual(exact);
        expect(JSON.stringify(exact)).not.toContain('第一行');
        expect(JSON.stringify(exact)).not.toContain('private');
        expect(JSON.stringify(exact)).not.toContain('session-composer-input');
        expect(
            observeAndroidNodeFromUiAutomator(source, 'session-composer-input', {
                kind: 'equals',
                value: 'wrong',
            }),
        ).toEqual({ exists: true, focused: true, textMatches: false });
    });

    it('rejects an empty includes predicate even when the node exists', () => {
        const source =
            '<node resource-id="session-composer-input" package="com.caxri.mobile" text="private" />';
        expect(() =>
            observeAndroidNodeFromUiAutomator(source, 'session-composer-input', {
                kind: 'includes',
                value: '',
            }),
        ).toThrow('Android includes text must not be empty');
    });

    it('ignores wrong IDs, foreign packages, and foreign resource namespaces', () => {
        const source = `<hierarchy>
          <node resource-id="com.caxri.mobile:id/other-control" package="com.caxri.mobile" focused="true" text="secret" />
          <node resource-id="com.caxri.mobile:id/session-composer-input" package="com.android.systemui" focused="true" text="secret" />
          <node resource-id="com.other.app:id/session-composer-input" package="com.caxri.mobile" focused="true" text="secret" />
        </hierarchy>`;
        expect(
            observeAndroidNodeFromUiAutomator(source, 'session-composer-input', {
                kind: 'includes',
                value: 'secret',
            }),
        ).toEqual({ exists: false, focused: false, textMatches: false });
        expect(observeAndroidNodeFromUiAutomator(source, 'session-composer-input')).toEqual({
            exists: false,
            focused: false,
        });
    });

    it('extracts only the resumed package identity', () => {
        expect(
            resumedPackageFromWindowDump(
                'mCurrentFocus=Window{abc u0 com.caxri.mobile/com.caxri.mobile.MainActivity}',
            ),
        ).toBe('com.caxri.mobile');
    });

    it('derives a stable tap point from UIAutomator bounds', () => {
        expect(centerOfAndroidBounds('[10,20][110,220]')).toEqual({ x: 60, y: 120 });
        expect(() => centerOfAndroidBounds('[10,20][10,220]')).toThrow(
            'Android bounds are invalid',
        );
        expect(() => centerOfAndroidBounds('private text')).toThrow('Android bounds are invalid');
    });
});

import { describe, expect, it } from 'vitest';

import {
    centerOfAndroidBounds,
    isAndroidCheckId,
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
            },
            {
                bounds: '[0,100][100,160]',
                checkId: 'pairing-scan-button',
                className: 'android.widget.Button',
                clickable: true,
                enabled: true,
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

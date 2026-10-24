import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { scanFromURLAsync } from 'expo-camera';
import { File, Paths } from 'expo-file-system';

import { useMobileTheme } from '../../theme/use-mobile-theme';
import type { BarcodeVectorStatus } from './barcode-vector';
import {
    BARCODE_VECTOR_ID,
    BARCODE_VECTOR_PNG_BASE64,
    verifyBarcodeVector,
} from './barcode-vector';

const styles = StyleSheet.create({
    content: { alignItems: 'center', flex: 1, gap: 12, justifyContent: 'center', padding: 24 },
    detail: { fontSize: 14, lineHeight: 20 },
    safeArea: { flex: 1 },
    status: { fontSize: 16, fontWeight: '700' },
    title: { fontSize: 22, fontWeight: '700' },
});

/**
 * Decodes the bundled vector through `scanFromURLAsync`, the decoder behind Choose from Photos. A release build that
 * lost ML Kit's components reports no code here, the same silent failure a user sees on the scan screen.
 */
const decodeBarcodeVector = async (): Promise<BarcodeVectorStatus> => {
    const file = new File(Paths.cache, `${BARCODE_VECTOR_ID}.png`);
    await file.write(BARCODE_VECTOR_PNG_BASE64, { encoding: 'base64' });
    const results = await scanFromURLAsync(file.uri, ['qr']);
    return verifyBarcodeVector(results.map(({ data }) => data));
};

export const BarcodeVectorScreen = () => {
    const theme = useMobileTheme();
    const [status, setStatus] = useState<BarcodeVectorStatus | 'pending'>('pending');

    useEffect(() => {
        const controller = new AbortController();
        void (async () => {
            let result: BarcodeVectorStatus;
            try {
                result = await decodeBarcodeVector();
            } catch {
                result = 'failed';
            }
            if (!controller.signal.aborted) setStatus(result);
        })();
        return () => {
            controller.abort();
        };
    }, []);

    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.safeArea, { backgroundColor: theme.background }]}
            testID={`acceptance-barcode-vector-${status}`}
        >
            <View style={styles.content}>
                <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
                    Barcode decoder check
                </Text>
                <Text style={[styles.detail, { color: theme.muted }]}>{BARCODE_VECTOR_ID}</Text>
                <Text style={[styles.status, { color: theme.text }]}>
                    {status === 'pending' ? 'Decoding…' : status === 'passed' ? 'Passed' : 'Failed'}
                </Text>
            </View>
        </SafeAreaView>
    );
};

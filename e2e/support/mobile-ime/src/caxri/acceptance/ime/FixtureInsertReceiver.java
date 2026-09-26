package caxri.acceptance.ime;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Routes a fixture-only broadcast to the active input method without logging its text. */
public final class FixtureInsertReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        FixtureIme ime = FixtureIme.active;
        String base64 = intent.getStringExtra("textBase64");
        if (ime == null || base64 == null) {
            setResultCode(Activity.RESULT_CANCELED);
            setResultData("no-active-input");
            return;
        }
        try {
            boolean compose = intent.getBooleanExtra("compose", false);
            if (!ime.commitFixture(base64, compose)) {
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("commit-failed");
                return;
            }
        } catch (IllegalArgumentException error) {
            setResultCode(Activity.RESULT_CANCELED);
            setResultData("invalid-fixture");
            return;
        }
        setResultCode(Activity.RESULT_OK);
        setResultData(intent.getBooleanExtra("compose", false) ? "composed" : "committed");
    }
}

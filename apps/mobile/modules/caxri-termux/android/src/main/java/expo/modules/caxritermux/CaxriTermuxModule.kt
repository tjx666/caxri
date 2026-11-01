package expo.modules.caxritermux

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

private const val TERMUX_PACKAGE = "com.termux"
private const val RUN_COMMAND_PERMISSION = "com.termux.permission.RUN_COMMAND"
private const val RUN_COMMAND_SERVICE = "com.termux.app.RunCommandService"
private const val RUN_COMMAND_ACTION = "com.termux.RUN_COMMAND"
private const val EXTRA_PATH = "com.termux.RUN_COMMAND_PATH"
private const val EXTRA_ARGUMENTS = "com.termux.RUN_COMMAND_ARGUMENTS"
private const val EXTRA_WORKDIR = "com.termux.RUN_COMMAND_WORKDIR"
private const val EXTRA_BACKGROUND = "com.termux.RUN_COMMAND_BACKGROUND"
private const val EXTRA_PENDING_INTENT = "com.termux.RUN_COMMAND_PENDING_INTENT"
private const val EXTRA_COMMAND_LABEL = "com.termux.RUN_COMMAND_COMMAND_LABEL"
private const val RESULT_BUNDLE = "result"
private const val TERMUX_PREFIX_BIN = "/data/data/com.termux/files/usr/bin"

/**
 * Exit status of coreutils `timeout` when it stopped the command; reported as the `timeout` failure.
 */
private const val TIMEOUT_EXIT_CODE = 124

/**
 * How long past the command's deadline to wait for Termux's answer before reporting `timeout` anyway: `timeout -k`
 * escalates to SIGKILL after 2 s, and the result still has to cross back as a broadcast.
 */
private const val ANSWER_GRACE_MS = 3_000L

/**
 * Runs one command in Termux through its `RUN_COMMAND` service, in the background so Termux's UI never opens, and
 * returns its output. See https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent. The command is wrapped in
 * `timeout`, which Termux's base install always has, so a deadline actually stops it instead of leaving it running.
 */
class CaxriTermuxModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("CaxriTermux")

    Function("isInstalled") {
      isTermuxInstalled(context)
    }

    Function("hasPermission") {
      hasPermission(context)
    }

    AsyncFunction("requestPermission") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        RUN_COMMAND_PERMISSION,
      )
    }

    AsyncFunction("run") { argv: List<String>, cwd: String?, timeoutMs: Double, promise: Promise ->
      run(context.applicationContext, argv, cwd, timeoutMs.toLong(), promise)
    }
  }

  private fun run(context: Context, argv: List<String>, cwd: String?, timeoutMs: Long, promise: Promise) {
    if (!isTermuxInstalled(context)) return promise.resolve(failure("termux-missing"))
    if (!hasPermission(context)) return promise.resolve(failure("permission-denied"))
    val requestCode = nextRequestCode.incrementAndGet()
    val action = "${context.packageName}.TERMUX_RESULT.$requestCode"
    val settled = AtomicBoolean(false)
    val handler = Handler(Looper.getMainLooper())
    lateinit var receiver: BroadcastReceiver
    val settle = { value: Map<String, Any?> ->
      if (settled.compareAndSet(false, true)) {
        handler.removeCallbacksAndMessages(action)
        try {
          context.unregisterReceiver(receiver)
        } catch (_: IllegalArgumentException) {
        }
        promise.resolve(value)
      }
    }
    receiver = object : BroadcastReceiver() {
      override fun onReceive(receiverContext: Context, intent: Intent) {
        settle(readResult(intent))
      }
    }
    // A PendingIntent broadcast is sent as this app, so the receiver stays unexported.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
      context.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
    else context.registerReceiver(receiver, IntentFilter(action))
    handler.postAtTime(
      { settle(failure("timeout")) },
      action,
      SystemClock.uptimeMillis() + timeoutMs + ANSWER_GRACE_MS,
    )
    // Termux fills the result extras into this intent, so it must stay mutable; the explicit package keeps it ours.
    val resultIntent = PendingIntent.getBroadcast(
      context,
      requestCode,
      Intent(action).setPackage(context.packageName),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
    )
    val seconds = String.format(Locale.ROOT, "%.3f", timeoutMs / 1000.0)
    val intent = Intent()
      .setClassName(TERMUX_PACKAGE, RUN_COMMAND_SERVICE)
      .setAction(RUN_COMMAND_ACTION)
      .putExtra(EXTRA_PATH, "$TERMUX_PREFIX_BIN/timeout")
      .putExtra(EXTRA_ARGUMENTS, (listOf("-k", "2", seconds) + argv).toTypedArray())
      .putExtra(EXTRA_BACKGROUND, true)
      .putExtra(EXTRA_COMMAND_LABEL, "Caxri")
      .putExtra(EXTRA_PENDING_INTENT, resultIntent)
    if (cwd != null) intent.putExtra(EXTRA_WORKDIR, cwd)
    try {
      context.startService(intent)
    } catch (error: Exception) {
      // Android refuses a background start, or Termux's service is missing in an incompatible build.
      settle(failure("termux-error", error.javaClass.simpleName))
    }
  }

  private fun readResult(intent: Intent): Map<String, Any?> {
    val bundle = intent.getBundleExtra(RESULT_BUNDLE) ?: return failure("termux-error", "Termux sent no result")
    val err = bundle.getInt("err", -1)
    if (err != -1) return failure("termux-error", bundle.getString("errmsg")?.take(1_000))
    val exitCode = bundle.getInt("exitCode", 0)
    if (exitCode == TIMEOUT_EXIT_CODE) return failure("timeout")
    return mapOf(
      "status" to "exited",
      "exitCode" to exitCode,
      "stdout" to (bundle.getString("stdout") ?: ""),
      "stderr" to (bundle.getString("stderr") ?: ""),
      // Termux itself cuts large output to fit a binder transaction and then reports the original length.
      "termuxTruncated" to (bundle.getString("stdout_original_length") != null ||
        bundle.getString("stderr_original_length") != null),
    )
  }

  private fun failure(reason: String, message: String? = null): Map<String, Any?> =
    mapOf("status" to "failed", "reason" to reason, "message" to message)

  private fun hasPermission(context: Context): Boolean =
    context.checkSelfPermission(RUN_COMMAND_PERMISSION) == PackageManager.PERMISSION_GRANTED

  private fun isTermuxInstalled(context: Context): Boolean =
    try {
      context.packageManager.getPackageInfo(TERMUX_PACKAGE, 0)
      true
    } catch (_: PackageManager.NameNotFoundException) {
      false
    }

  private companion object {
    val nextRequestCode = AtomicInteger(0)
  }
}

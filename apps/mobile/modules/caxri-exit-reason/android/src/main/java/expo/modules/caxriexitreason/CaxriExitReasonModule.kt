package expo.modules.caxriexitreason

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val PREFERENCES = "caxri_exit_reason"
private const val UNCAUGHT_CLASS = "uncaughtClass"
private const val UNCAUGHT_AT = "uncaughtAt"

/**
 * Reads why this app's previous main process ended, so the next connection can report a crash Caxri would otherwise
 * never see. Android's exit record names no exception, so an uncaught-exception handler keeps the class name of the last
 * Java crash beside it; the message and stack are never stored.
 */
class CaxriExitReasonModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("CaxriExitReason")

    OnCreate {
      installUncaughtExceptionRecorder(context.applicationContext)
    }

    AsyncFunction("readPreviousExit") {
      readPreviousExit(context)
    }
  }

  private fun readPreviousExit(context: Context): Map<String, Any?>? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
    val manager = context.getSystemService(ActivityManager::class.java) ?: return null
    val exit = manager.getHistoricalProcessExitReasons(context.packageName, 0, 0)
      .firstOrNull { it.processName == context.packageName } ?: return null
    val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    return mapOf(
      "reason" to exit.reason,
      "timestamp" to exit.timestamp.toDouble(),
      "uncaughtClass" to preferences.getString(UNCAUGHT_CLASS, null),
      "uncaughtAt" to preferences.getLong(UNCAUGHT_AT, 0L).takeIf { it > 0L }?.toDouble(),
    )
  }

  private companion object {
    @Volatile
    private var isRecorderInstalled = false

    /**
     * Wraps the current default handler once per process. The write is synchronous because the process dies right
     * after the handler returns; a failed write is ignored so the original handler always runs.
     */
    @Synchronized
    fun installUncaughtExceptionRecorder(context: Context) {
      if (isRecorderInstalled) return
      isRecorderInstalled = true
      val previous = Thread.getDefaultUncaughtExceptionHandler()
      Thread.setDefaultUncaughtExceptionHandler { thread, error ->
        try {
          context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
            .putString(UNCAUGHT_CLASS, error.javaClass.name)
            .putLong(UNCAUGHT_AT, System.currentTimeMillis())
            .commit()
        } catch (_: Throwable) {
        }
        previous?.uncaughtException(thread, error)
      }
    }
  }
}

#!/usr/bin/env bash
# 构建临时目录中的测试输入法 APK 和签名材料，不修改应用或设备。
set -euo pipefail

source_directory="$(cd "$(dirname "$0")" && pwd)"
output_directory="$1"
sdk_directory="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
android_jar="$sdk_directory/platforms/android-36/android.jar"
tools_directory="$sdk_directory/build-tools/36.0.0"
java_directory="/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin"
export JAVA_HOME="$(dirname "$java_directory")"
export PATH="$java_directory:$PATH"
mkdir -p "$output_directory/classes" "$output_directory/dex"
run_stage() {
    local stage="$1"
    shift
    if ! "$@" >"$output_directory/$stage.log" 2>&1; then
        echo "Fixture IME build failed at $stage" >&2
        return 1
    fi
}
cd "$source_directory"

run_stage compile-resources "$tools_directory/aapt2" compile --dir res \
    -o "$output_directory/resources.zip"
run_stage link-apk "$tools_directory/aapt2" link -I "$android_jar" \
    --manifest AndroidManifest.xml -o "$output_directory/unsigned.apk" \
    "$output_directory/resources.zip"
run_stage compile-java "$java_directory/javac" -source 8 -target 8 -cp "$android_jar" \
    -d "$output_directory/classes" \
    src/caxri/acceptance/ime/FixtureIme.java \
    src/caxri/acceptance/ime/FixtureInsertReceiver.java
run_stage package-classes "$java_directory/jar" cf "$output_directory/classes.jar" \
    -C "$output_directory/classes" .
run_stage dex "$tools_directory/d8" --lib "$android_jar" --output "$output_directory/dex" \
    "$output_directory/classes.jar"
cd "$output_directory"
run_stage package-dex zip -q -j unsigned.apk dex/classes.dex
run_stage align "$tools_directory/zipalign" -f -p 4 unsigned.apk aligned.apk
run_stage create-key openssl req -x509 -newkey rsa:2048 -nodes -keyout fixture-key.pem \
    -out fixture-cert.pem -subj '/CN=Caxri Acceptance Fixture' -days 1
run_stage convert-key openssl pkcs8 -topk8 -inform PEM -outform DER -nocrypt \
    -in fixture-key.pem -out fixture-key.pk8
run_stage sign "$tools_directory/apksigner" sign --key fixture-key.pk8 --cert fixture-cert.pem \
    --out fixture-ime.apk aligned.apk
run_stage verify-signature "$tools_directory/apksigner" verify fixture-ime.apk

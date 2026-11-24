#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/app"
OUT_APK="$ROOT_DIR/公考朱批录_v1.0.0.apk"

echo "==> [1/5] 检查并准备 JDK 21 与 Android Command-Line Tools..."
if ! /opt/homebrew/opt/openjdk@21/bin/java -version >/dev/null 2>&1; then
  echo "正在通过 Homebrew 安装 openjdk@21..."
  brew install openjdk@21
fi
export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"

SDK_ROOT="$HOME/Library/Android/sdk"
mkdir -p "$SDK_ROOT"
export ANDROID_HOME="$SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"

CMDLINE_BIN=""
if [ -x "/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin/sdkmanager" ]; then
  CMDLINE_BIN="/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin"
elif [ -x "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]; then
  CMDLINE_BIN="$SDK_ROOT/cmdline-tools/latest/bin"
else
  echo "正在通过 Homebrew 安装 android-commandlinetools..."
  brew install --cask android-commandlinetools
  CMDLINE_BIN="/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin"
fi
export PATH="$CMDLINE_BIN:$SDK_ROOT/platform-tools:$PATH"

echo "==> [2/5] 接受 Android SDK 许可并安装必要构建组件..."
yes | sdkmanager --sdk_root="$SDK_ROOT" --licenses >/dev/null || true
sdkmanager --sdk_root="$SDK_ROOT" "platform-tools" "platforms;android-36" "build-tools;36.0.0" || true

echo "==> [3/5] 执行 Expo Prebuild 生成原生 Android 工程..."
cd "$APP_DIR"
export EXPO_NO_TELEMETRY=1
npx tsc --noEmit
npx expo prebuild --platform android --clean

echo "==> [4/5] 使用 Gradle 编译独立签名 Release APK (arm64-v8a)..."
cd "$APP_DIR/android"
echo "sdk.dir=$SDK_ROOT" > local.properties
./gradlew assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  -Dorg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=1g -Dfile.encoding=UTF-8" \
  --no-daemon

cp "$APP_DIR/android/app/build/outputs/apk/release/app-release.apk" "$OUT_APK"
echo ""
echo "✅ APK 打包成功！文件已输出至："
ls -lh "$OUT_APK"

const { withAndroidManifest } = require('expo/config-plugins');

/**
 * 允许正式版 APK 访问局域网 HTTP 服务（用于可选的 Mac 本地 Apple Vision OCR 桥接服务）
 */
module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (mod) => {
    const mainApp = mod.modResults.manifest.application?.[0];
    if (mainApp) {
      mainApp.$['android:usesCleartextTraffic'] = 'true';
    }
    return mod;
  });
};

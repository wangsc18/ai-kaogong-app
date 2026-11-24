import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';

export interface SafePickedDocument {
  uri: string;
  name: string;
  size?: number;
  mimeType?: string;
  base64?: string;
}

/**
 * 跨平台安全文件选择器（彻底解决 Android Expo Go 下的 DocumentPicker 缓存目录权限报错）
 *
 * 根因说明：
 * expo-document-picker 在 Android 上若开启 copyToCacheDirectory: true，会将文件写入
 * unscoped 的 /data/user/0/host.exp.exponent/cache/DocumentPicker/ 目录，
 * 而 Expo Go 的 ScopedFilePermissionModule 仅放行 ExperienceData/<scope> 子目录及系统授权的 content:// URI，
 * 从而导致 ExponentFileSystem.readAsStringAsync 抛出 "Location 'file:///.../DocumentPicker/...' isn't readable"。
 *
 * 因此在 Android 下必须设置 copyToCacheDirectory: false，直接读取系统授权的 content:// URI，同时保留真实中文文件名！
 */
export async function pickDocumentSafe(
  mimeTypes: string | string[]
): Promise<SafePickedDocument | null> {
  const list = await pickMultipleDocumentsSafe(mimeTypes, false);
  return list.length > 0 ? list[0] : null;
}

/**
 * 支持一次多选（长按勾选多份 PDF）或单选的安全文件选择器
 */
export async function pickMultipleDocumentsSafe(
  mimeTypes: string | string[],
  allowMultiple = true
): Promise<SafePickedDocument[]> {
  const res = await DocumentPicker.getDocumentAsync({
    type: mimeTypes,
    copyToCacheDirectory: Platform.OS === 'ios',
    multiple: allowMultiple,
    base64: false,
  });

  if (res.canceled || !res.assets || res.assets.length === 0) {
    return [];
  }

  return res.assets.map((asset, idx) => ({
    uri: asset.uri,
    name: asset.name || `备考文件_${idx + 1}`,
    size: asset.size,
    mimeType: asset.mimeType,
    base64: asset.base64,
  }));
}

/**
 * React Native 原生网络/ContentResolver 层读取 Blob（完全不经过 ExponentFileSystem 权限拦截器）
 */
function readUriViaNativeXhr(uri: string, asDataUrl: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.onload = () => {
      const blob = xhr.response;
      if (!blob) {
        reject(new Error('文件内容为空'));
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        if (!result) {
          reject(new Error('FileReader 未能读取到文件内容'));
          return;
        }
        if (asDataUrl) {
          const commaIdx = result.indexOf(',');
          resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
        } else {
          resolve(result);
        }
      };
      reader.onerror = () => {
        reject(new Error('FileReader 解析本地文件失败'));
      };
      if (asDataUrl) {
        reader.readAsDataURL(blob);
      } else {
        reader.readAsText(blob, 'UTF-8');
      }
    };
    xhr.onerror = () => {
      reject(new Error(`系统底层无法打开文件流: ${uri}`));
    };
    xhr.responseType = 'blob';
    xhr.open('GET', uri, true);
    xhr.send(null);
  });
}

/**
 * 四重兜底读取任意本地 URI (content:// 或 file://) 为纯 Base64 字符串（不含 data: 前缀）
 */
export async function readUriAsBase64(
  uri: string,
  preloadedBase64?: string
): Promise<string> {
  if (preloadedBase64) {
    const idx = preloadedBase64.indexOf(',');
    return idx >= 0 ? preloadedBase64.slice(idx + 1) : preloadedBase64;
  }

  // 通道 1：优先走 React Native OS 级 ContentResolver / XHR + NativeFileReaderModule（100% 绕开 Expo Go 沙盒目录限制）
  if (Platform.OS !== 'web') {
    try {
      const b64 = await readUriViaNativeXhr(uri, true);
      if (b64) return b64;
    } catch {
      // 继续回退尝试其他通道
    }
  }

  // 通道 2：Expo SDK 58 新版 File.base64()（支持 SAF content:// 与应用沙盒内 file://）
  try {
    const b64 = await new File(uri).base64();
    if (b64) return b64;
  } catch {
    // 继续回退
  }

  // 通道 3：Legacy FileSystem
  return await LegacyFileSystem.readAsStringAsync(uri, {
    encoding: LegacyFileSystem.EncodingType.Base64,
  });
}

/**
 * 三重兜底读取任意本地 URI (content:// 或 file://) 为 UTF-8 文本
 */
export async function readUriAsText(uri: string): Promise<string> {
  if (Platform.OS !== 'web') {
    try {
      const txt = await readUriViaNativeXhr(uri, false);
      if (txt) return txt;
    } catch {
      // 继续回退
    }
  }

  try {
    return await new File(uri).text();
  } catch {
    return await LegacyFileSystem.readAsStringAsync(uri);
  }
}

/**
 * 仅在 iOS 启用了缓存复制时安全清理临时文件（绝不在 Android 上触碰非沙盒路径）
 */
export function cleanupTempPickedUri(uri?: string | null): void {
  if (!uri || Platform.OS !== 'ios') return;
  try {
    if (uri.startsWith('file://') && uri.includes('DocumentPicker')) {
      const tmp = new File(uri);
      if (tmp.exists) tmp.delete();
    }
  } catch {
    // ignore cleanup error
  }
}

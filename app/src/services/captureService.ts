import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';

export interface RawPickedImage {
  uri: string;
  width: number;
  height: number;
  base64?: string | null;
  mimeType?: string;
}

export interface CapturedImageAsset {
  localUri: string;
  base64: string;
  mimeType: string;
}

/**
 * 第一步：调用系统相机或相册获取原始图片（allowsEditing 设为 false，
 * 使用系统原生「确定/完成」按钮直接返回，不再强制拦截进系统裁切页！）
 */
export async function pickRawImage(
  source: 'camera' | 'library'
): Promise<RawPickedImage | null> {
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      throw new Error('需要授予相机权限才能拍摄纸质试卷错题');
    }
  } else {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      throw new Error('需要授予相册读取权限才能导入错题截图');
    }
  }

  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 0.86,
    base64: true,
  };

  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return null;
  }

  const asset = result.assets[0];
  return {
    uri: asset.uri,
    width: asset.width || 1080,
    height: asset.height || 1440,
    base64: asset.base64 || null,
    mimeType: asset.mimeType || 'image/jpeg',
  };
}

/** 顺时针旋转 90° 并返回新临时图（供预览窗内实时旋转） */
export async function rotateImage90(raw: RawPickedImage): Promise<RawPickedImage> {
  const ctx = ImageManipulator.manipulate(raw.uri);
  ctx.rotate(90);
  const rendered = await ctx.renderAsync();
  const saved = await rendered.saveAsync({
    compress: 0.88,
    format: SaveFormat.JPEG,
    base64: true,
  });
  return {
    uri: saved.uri,
    width: saved.width,
    height: saved.height,
    base64: saved.base64 || null,
    mimeType: 'image/jpeg',
  };
}

/**
 * 第二步：将用户直接确认的原图（或可选裁剪后的区域）持久化写入 App 专属目录
 * 使用 Base64 落盘，彻底规避 Expo Go 下 FileSystemFile.copy 跨缓存目录的 READ 权限报错！
 */
export async function finalizeCapturedImage(
  raw: RawPickedImage,
  cropNormalized?: { left: number; top: number; right: number; bottom: number } | null
): Promise<CapturedImageAsset> {
  let finalBase64 = raw.base64 || '';
  let mimeType = raw.mimeType || 'image/jpeg';

  if (cropNormalized) {
    const originX = Math.max(0, Math.round(cropNormalized.left * raw.width));
    const originY = Math.max(0, Math.round(cropNormalized.top * raw.height));
    const cropW = Math.min(
      raw.width - originX,
      Math.max(24, Math.round((cropNormalized.right - cropNormalized.left) * raw.width))
    );
    const cropH = Math.min(
      raw.height - originY,
      Math.max(24, Math.round((cropNormalized.bottom - cropNormalized.top) * raw.height))
    );

    const ctx = ImageManipulator.manipulate(raw.uri);
    ctx.crop({
      originX,
      originY,
      width: cropW,
      height: cropH,
    });
    const rendered = await ctx.renderAsync();
    const saved = await rendered.saveAsync({
      compress: 0.85,
      format: SaveFormat.JPEG,
      base64: true,
    });
    finalBase64 = saved.base64 || '';
    mimeType = 'image/jpeg';
  } else if (!finalBase64) {
    // 兜底通过 ImageManipulator 提取 Base64，避免直接跨目录 copy
    const ctx = ImageManipulator.manipulate(raw.uri);
    const rendered = await ctx.renderAsync();
    const saved = await rendered.saveAsync({
      compress: 0.85,
      format: SaveFormat.JPEG,
      base64: true,
    });
    finalBase64 = saved.base64 || '';
    mimeType = 'image/jpeg';
  }

  const capturesDir = new Directory(Paths.document, 'captures');
  capturesDir.create({ idempotent: true });

  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  const fileName = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const dstFile = new File(capturesDir, fileName);

  await LegacyFileSystem.writeAsStringAsync(dstFile.uri, finalBase64, {
    encoding: LegacyFileSystem.EncodingType.Base64,
  });

  return {
    localUri: dstFile.uri,
    base64: finalBase64,
    mimeType,
  };
}

export async function readLocalImageAsDataUri(uri?: string | null): Promise<string | null> {
  if (!uri) return null;
  if (uri.startsWith('data:image/')) return uri;
  try {
    const b64 = await LegacyFileSystem.readAsStringAsync(uri, {
      encoding: LegacyFileSystem.EncodingType.Base64,
    });
    if (!b64) return null;
    const mime = uri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

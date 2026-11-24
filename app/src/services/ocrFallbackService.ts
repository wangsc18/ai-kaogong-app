import { ImageInputPayload } from '../ai/aiClient';

export type OcrFallbackMode = 'auto' | 'force_ocr';

export interface OcrFallbackConfig {
  /** auto: 优先尝试模型原生识图，若模型不支持图片则自动降级走备用OCR；force_ocr: 始终先走备用OCR转纯文本再调DeepSeek */
  mode: OcrFallbackMode;
  /** 可选：局域网 Mac Apple Vision 高精度 OCR 服务地址（如 http://192.168.1.10:8765/ocr），留空则走内置免费云端中文 OCR */
  localMacOcrUrl: string;
  /** OCR.space 免费公共测试 Key 为 'helloworld'（用户也可在 ocr.space 免费领专属 25000次/月 Key 填入） */
  ocrSpaceApiKey: string;
}

export const DEFAULT_OCR_FALLBACK_CONFIG: OcrFallbackConfig = {
  mode: 'auto',
  localMacOcrUrl: '',
  ocrSpaceApiKey: 'helloworld',
};

/**
 * 单张图片调用备用 OCR 提取纯文本：
 * 1. 若配置了局域网 Mac Apple Vision OCR 桥接地址，优先调用（99%+ 中文印刷体精度，毫秒级）；
 * 2. 否则调用免注册开箱即用的 OCR.space 中文多语种引擎（Engine 2 对中文排版与数字表格更优，失败回退 Engine 1）。
 */
async function recognizeSingleImageText(
  img: ImageInputPayload,
  config: OcrFallbackConfig
): Promise<string> {
  const macUrl = (config.localMacOcrUrl || '').trim();
  if (macUrl) {
    try {
      const endpoint = macUrl.endsWith('/ocr') ? macUrl : `${macUrl.replace(/\/+$/, '')}/ocr`;
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base64: img.base64,
          mimeType: img.mimeType || 'image/jpeg',
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.text && String(data.text).trim()) {
          return String(data.text).trim();
        }
      }
    } catch {
      // 局域网不可达时平滑回退至内置云端免费 OCR
    }
  }

  const ocrKey = (config.ocrSpaceApiKey || 'helloworld').trim() || 'helloworld';
  const dataUri = `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}`;

  for (const engine of ['2', '1']) {
    try {
      const formBody = [
        `apikey=${encodeURIComponent(ocrKey)}`,
        `base64Image=${encodeURIComponent(dataUri)}`,
        `language=${encodeURIComponent('chs')}`,
        `OCREngine=${engine}`,
        `scale=true`,
        `isTable=true`,
      ].join('&');

      const resp = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody,
      });

      if (!resp.ok) continue;
      const json = await resp.json();
      const parsedText = json?.ParsedResults?.map((r: any) => r?.ParsedText || '')
        .join('\n')
        .trim();
      if (parsedText) {
        return parsedText;
      }
    } catch {
      // 尝试下一个引擎
    }
  }

  throw new Error(
    '备用免费 OCR 未能提取出有效文字（可能是纯几何图形题或网络受限）。建议将识图模型设为支持原生多模态的 deepseek-flash 或 gpt-5，或启动 Mac 本地 OCR 桥接脚本。'
  );
}

/** 批量提取多张图片（题干图 / 材料图 / 答案解析图）的 OCR 文本拼装结果 */
export async function extractTextViaFallbackOcr(
  images: ImageInputPayload[],
  config: OcrFallbackConfig
): Promise<string> {
  const blocks: string[] = [];
  for (const img of images) {
    const txt = await recognizeSingleImageText(img, config);
    blocks.push(`=== 【${img.label} OCR 识别原始文本】 ===\n${txt}`);
  }
  return blocks.join('\n\n');
}

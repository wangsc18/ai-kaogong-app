import React, { useImperativeHandle, useRef, forwardRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { readUriAsBase64 } from '../services/localFileReader';

export interface PdfExtractionOutput {
  totalPages: number;
  outlineText: string;
  sampledText: string;
  isScannedPdf: boolean;
  scannedPageImages: Array<{
    pageNum: number;
    base64: string;
  }>;
}

export interface PickedPdfAsset {
  uri: string;
  name?: string;
  size?: number;
  base64?: string;
}

export interface PdfExtractorHandle {
  extractPdf: (
    pickedFile: PickedPdfAsset,
    onProgress?: (msg: string) => void
  ) => Promise<PdfExtractionOutput>;
}

const PDF_PARSER_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
</head>
<body>
<script>
  window.__b64Parts = [];
  window.__pdfReady = false;

  function sendMsg(payload) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  }

  // 优先走国内极速阿里云 npmmirror CDN，失败自动切换 jsdelivr / unpkg
  const CDNS = [
    {
      lib: 'https://registry.npmmirror.com/pdfjs-dist/3.11.174/files/build/pdf.min.js',
      worker: 'https://registry.npmmirror.com/pdfjs-dist/3.11.174/files/build/pdf.worker.min.js',
      cmaps: 'https://registry.npmmirror.com/pdfjs-dist/3.11.174/files/cmaps/'
    },
    {
      lib: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
      worker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
      cmaps: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/'
    },
    {
      lib: 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js',
      worker: 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
      cmaps: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/'
    }
  ];

  window.__activeCmapUrl = CDNS[0].cmaps;

  function loadPdfJs(idx) {
    if (idx >= CDNS.length) {
      sendMsg({ type: 'lib_error', message: 'PDF 解析引擎加载失败，请检查手机网络连接' });
      return;
    }
    const s = document.createElement('script');
    s.src = CDNS[idx].lib;
    s.onload = function() {
      if (window.pdfjsLib) {
        try {
          const workerBlob = new Blob(
            ['importScripts("' + CDNS[idx].worker + '");'],
            { type: 'application/javascript' }
          );
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
        } catch (e) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDNS[idx].worker;
        }
        window.__activeCmapUrl = CDNS[idx].cmaps;
        window.__pdfReady = true;
        sendMsg({ type: 'ready' });
      } else {
        loadPdfJs(idx + 1);
      }
    };
    s.onerror = function() {
      loadPdfJs(idx + 1);
    };
    document.head.appendChild(s);
  }
  loadPdfJs(0);

  window.__resetPdfBuffer = function() {
    window.__b64Parts = [];
  };

  window.__appendPdfChunk = function(chunk) {
    window.__b64Parts.push(chunk);
  };

  async function flattenOutline(items, depth) {
    let lines = [];
    if (!items) return lines;
    for (const it of items) {
      const indent = '  '.repeat(depth);
      lines.push(indent + '- ' + (it.title || '').trim());
      if (it.items && it.items.length > 0 && depth < 3) {
        const sub = await flattenOutline(it.items, depth + 1);
        lines = lines.concat(sub);
      }
    }
    return lines;
  }

  window.__runPdfExtraction = async function() {
    try {
      if (!window.__pdfReady && !window.pdfjsLib) {
        loadPdfJs(0);
      }
      let waitCount = 0;
      while (!window.__pdfReady && waitCount < 75) {
        await new Promise(r => setTimeout(r, 200));
        waitCount++;
      }
      if (!window.pdfjsLib) {
        throw new Error('PDF 解析组件加载超时，请确认手机已连接网络后重试');
      }

      const fullB64 = window.__b64Parts.join('');
      window.__b64Parts = [];
      const binary = atob(fullB64);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      sendMsg({ type: 'progress', message: '正在打开 PDF 文档结构...' });
      let pdf;
      try {
        pdf = await window.pdfjsLib.getDocument({
          data: bytes,
          cMapUrl: window.__activeCmapUrl,
          cMapPacked: true
        }).promise;
      } catch (workerErr) {
        pdf = await window.pdfjsLib.getDocument({
          data: bytes,
          cMapUrl: window.__activeCmapUrl,
          cMapPacked: true,
          disableWorker: true
        }).promise;
      }
      const totalPages = pdf.numPages;

      // 1. 提取书签目录树 (Outline)
      let outlineText = '';
      try {
        const rawOutline = await pdf.getOutline();
        if (rawOutline && rawOutline.length > 0) {
          const outlineLines = await flattenOutline(rawOutline, 0);
          outlineText = outlineLines.slice(0, 120).join('\\n');
        }
      } catch (e) {}

      // 2. 智能规划采样页：前 20 页全读（目录+核心方法论）+ 中段均匀采样最多 32 页 + 末尾 4 页（锁定总题号/终章）
      const pageSet = new Set();
      const headLimit = Math.min(totalPages, 20);
      for (let p = 1; p <= headLimit; p++) pageSet.add(p);

      if (totalPages > 20) {
        const tailStart = Math.max(21, totalPages - 3);
        for (let p = tailStart; p <= totalPages; p++) pageSet.add(p);

        const middleSpan = tailStart - 21;
        if (middleSpan > 0) {
          const step = Math.max(1, Math.floor(middleSpan / 30));
          for (let p = 21; p < tailStart; p += step) {
            pageSet.add(p);
          }
        }
      }

      const targetPages = Array.from(pageSet).sort((a, b) => a - b);
      const pageTexts = [];
      let totalChars = 0;

      for (let idx = 0; idx < targetPages.length; idx++) {
        const pNum = targetPages[idx];
        if (idx % 6 === 0) {
          sendMsg({
            type: 'progress',
            message: '正在提取 PDF 文字 (第 ' + pNum + ' / ' + totalPages + ' 页)...'
          });
        }
        const page = await pdf.getPage(pNum);
        const content = await page.getTextContent();
        const strings = content.items.map(item => item.str || '');
        const joined = strings.join(' ').replace(/\\s+/g, ' ').trim();
        if (joined.length > 0) {
          totalChars += joined.length;
          // 单页保留前 1100 字防止上下文爆炸
          pageTexts.push('【第 ' + pNum + ' 页】\\n' + joined.slice(0, 1100));
        }
      }

      // 3. 若整本提取文字不足 100 字，判定为纯扫描图片版 PDF，自动渲染 5 张关键页快照供视觉/OCR识别！
      const isScannedPdf = totalChars < 100;
      const scannedPageImages = [];

      if (isScannedPdf) {
        const scanTargets = Array.from(new Set([
          1,
          Math.min(2, totalPages),
          Math.min(4, totalPages),
          Math.max(1, Math.floor(totalPages * 0.4)),
          totalPages
        ])).slice(0, 5);

        for (const sp of scanTargets) {
          sendMsg({
            type: 'progress',
            message: '检测到扫描版 PDF，正在渲染第 ' + sp + ' 页图像供 AI 识别...'
          });
          const page = await pdf.getPage(sp);
          const viewport = page.getViewport({ scale: 1.3 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport }).promise;
          const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
          const b64 = dataUrl.split(',')[1] || '';
          if (b64) {
            scannedPageImages.push({ pageNum: sp, base64: b64 });
          }
        }
      }

      const sampledJoined = pageTexts.join('\\n\\n').slice(0, 42000);
      try {
        await pdf.cleanup();
        await pdf.destroy();
      } catch (e) {}

      sendMsg({
        type: 'done',
        result: {
          totalPages,
          outlineText,
          sampledText: sampledJoined,
          isScannedPdf,
          scannedPageImages
        }
      });
    } catch (err) {
      sendMsg({
        type: 'error',
        message: (err && err.message) ? err.message : String(err)
      });
    }
  };
</script>
</body>
</html>`;

export const PdfExtractorWebView = forwardRef<PdfExtractorHandle>((_, ref) => {
  const webViewRef = useRef<WebView<object>>(null);
  const pendingJobRef = useRef<{
    resolve: (res: PdfExtractionOutput) => void;
    reject: (err: Error) => void;
    onProgress?: (msg: string) => void;
  } | null>(null);

  useImperativeHandle(ref, () => ({
    async extractPdf(pickedFile: PickedPdfAsset, onProgress?: (msg: string) => void) {
      if (!webViewRef.current) {
        throw new Error('PDF 解析器组件未挂载');
      }

      if (pickedFile.size && pickedFile.size > 45 * 1024 * 1024) {
        throw new Error('单个 PDF 文件超过 45MB，建议按模块拆分后再上传分析');
      }

      onProgress?.('正在读取本地 PDF 文件...');
      const b64 = await readUriAsBase64(pickedFile.uri, pickedFile.base64);
      if (b64.length > 62 * 1024 * 1024) {
        throw new Error('单个 PDF 文件超过 45MB，建议按模块拆分后再上传分析');
      }

      webViewRef.current.injectJavaScript('window.__resetPdfBuffer(); true;');
      const CHUNK_SIZE = 180000;
      const totalChunks = Math.max(1, Math.ceil(b64.length / CHUNK_SIZE));
      let chunkIdx = 0;

      for (let offset = 0; offset < b64.length; offset += CHUNK_SIZE) {
        const slice = b64.slice(offset, offset + CHUNK_SIZE);
        webViewRef.current?.injectJavaScript(
          `window.__appendPdfChunk(${JSON.stringify(slice)}); true;`
        );
        chunkIdx += 1;
        if (chunkIdx % 3 === 0) {
          onProgress?.(
            `正在载入 PDF 数据 (${Math.min(99, Math.round((chunkIdx / totalChunks) * 100))}%)...`
          );
          await new Promise((r) => setTimeout(r, 8));
        }
      }

      return new Promise<PdfExtractionOutput>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          if (pendingJobRef.current) {
            pendingJobRef.current = null;
            reject(new Error('PDF 文档解析超时，请检查网络连接或尝试拆分超大 PDF 后重试'));
          }
        }, 90000);

        pendingJobRef.current = {
          resolve: (res) => {
            clearTimeout(timeoutId);
            resolve(res);
          },
          reject: (err) => {
            clearTimeout(timeoutId);
            reject(err);
          },
          onProgress,
        };
        webViewRef.current?.injectJavaScript('window.__runPdfExtraction(); true;');
      });
    },
  }));

  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      const job = pendingJobRef.current;
      if (!job) return;

      if (msg.type === 'progress') {
        job.onProgress?.(msg.message);
      } else if (msg.type === 'done') {
        pendingJobRef.current = null;
        job.resolve(msg.result as PdfExtractionOutput);
      } else if (msg.type === 'error' || msg.type === 'lib_error') {
        pendingJobRef.current = null;
        job.reject(new Error(msg.message || 'PDF 解析异常'));
      }
    } catch {
      // ignore malformed messages
    }
  };

  return (
    <View style={styles.hiddenContainer} pointerEvents="none">
      <WebView<object>
        ref={webViewRef}
        originWhitelist={['*']}
        source={{ html: PDF_PARSER_HTML, baseUrl: 'https://localhost' }}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        mixedContentMode="always"
        onMessage={handleMessage}
        onError={(e) => {
          const job = pendingJobRef.current;
          if (job) {
            pendingJobRef.current = null;
            job.reject(new Error(e.nativeEvent.description || 'WebView 解析环境异常'));
          }
        }}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  hiddenContainer: {
    width: 2,
    height: 2,
    opacity: 0.01,
    position: 'absolute',
    right: 0,
    bottom: 0,
    zIndex: -1,
  },
});

import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { recommendSimilarRealQuestions } from '../engine/recommender';
import { MistakeRecord, QuestionOption } from '../types/models';
import { readLocalImageAsDataUri } from './captureService';

function escapeHtml(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>');
}

function renderOptionsHtml(options: QuestionOption[]): string {
  return `<div class="options">
    ${options
      .map(
        (o) => `<div class="opt-item"><strong>${escapeHtml(o.key)}.</strong> ${escapeHtml(o.text)}</div>`
      )
      .join('')}
  </div>`;
}

export async function exportPracticePdf(params: {
  mistakes: MistakeRecord[];
  includeSimilarCount: number;
  title?: string;
}): Promise<void> {
  const { mistakes, includeSimilarCount } = params;
  if (!mistakes.length) {
    throw new Error('请至少选择 1 道错题导出 PDF');
  }

  const sheetTitle =
    params.title ||
    `公考行测错题与同类母题特训卷（${new Date().toISOString().slice(0, 10)}）`;

  interface PrintableItem {
    indexLabel: string;
    badge: string;
    materialText?: string | null;
    imageDataUri?: string | null;
    stemText: string;
    options: QuestionOption[];
    answer: string;
    myWrong?: string;
    fastTips: string;
    analysis: string;
  }

  const items: PrintableItem[] = [];
  let seq = 1;

  for (const m of mistakes) {
    const stemImgDataUri = !m.matchedQid
      ? await readLocalImageAsDataUri(m.captureImages.stemImageUri)
      : null;

    items.push({
      indexLabel: `第 ${seq} 题`,
      badge: `【原错题 · ${m.moduleL1} · ${m.motherTypeL3}】`,
      materialText: m.materialText,
      imageDataUri: stemImgDataUri,
      stemText: m.stemText,
      options: m.options,
      answer: m.correctAnswer,
      myWrong: m.myWrongAnswer,
      fastTips: m.pitfallWarning,
      analysis: m.aiFastSolution,
    });
    seq += 1;

    if (includeSimilarCount > 0) {
      const recs = await recommendSimilarRealQuestions(m, 'mother_type', includeSimilarCount);
      for (const rec of recs) {
        items.push({
          indexLabel: `第 ${seq} 题`,
          badge: `【同类真题巩固 · ${rec.question.sourceExam}】`,
          materialText: rec.question.materialText,
          imageDataUri: null,
          stemText: rec.question.stem,
          options: rec.question.options,
          answer: rec.question.answer,
          fastTips: rec.question.fastTips,
          analysis: rec.question.officialAnalysis,
        });
        seq += 1;
      }
    }
  }

  const questionsHtml = items
    .map(
      (it) => `
    <div class="q-block">
      <div class="q-header">
        <span class="q-num">${it.indexLabel}</span>
        <span class="q-badge">${escapeHtml(it.badge)}</span>
      </div>
      ${
        it.materialText
          ? `<div class="material-box">${escapeHtml(it.materialText)}</div>`
          : ''
      }
      ${
        it.imageDataUri
          ? `<div class="img-wrap"><img src="${it.imageDataUri}" class="q-img" /></div>`
          : ''
      }
      <div class="stem">${escapeHtml(it.stemText)}</div>
      ${renderOptionsHtml(it.options)}
      <div class="scratch-space"></div>
    </div>`
    )
    .join('\n');

  const answersHtml = items
    .map(
      (it) => `
    <div class="ans-block">
      <div class="ans-title">
        <strong>${it.indexLabel}</strong> 标准答案：<span class="ans-key">${escapeHtml(it.answer)}</span>
        ${it.myWrong ? `<span class="wrong-tag">（曾错选：${escapeHtml(it.myWrong)}）</span>` : ''}
      </div>
      ${
        it.fastTips
          ? `<div class="fast-tip">⚡ 秒杀/防坑锚点：${escapeHtml(it.fastTips)}</div>`
          : ''
      }
      <div class="ans-detail">${escapeHtml(it.analysis)}</div>
    </div>`
    )
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>
    @page { margin: 16mm 14mm; }
    body {
      font-family: -apple-system, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
      color: #111827;
      font-size: 11pt;
      line-height: 1.6;
    }
    .doc-header {
      text-align: center;
      border-bottom: 2px solid #1F2937;
      padding-bottom: 10px;
      margin-bottom: 18px;
    }
    .doc-header h1 { font-size: 16pt; margin: 0 0 4px 0; }
    .doc-header p { font-size: 9.5pt; color: #4B5563; margin: 0; }
    .q-block {
      margin-bottom: 18px;
      padding-bottom: 10px;
      border-bottom: 1px dashed #D1D5DB;
      break-inside: avoid;
    }
    .q-header { margin-bottom: 6px; }
    .q-num { font-weight: 700; font-size: 11.5pt; color: #1E3A8A; margin-right: 6px; }
    .q-badge { font-size: 9.5pt; color: #4B5563; }
    .material-box {
      background: #F9FAFB;
      border-left: 3px solid #6B7280;
      padding: 8px 10px;
      font-size: 10pt;
      margin-bottom: 8px;
    }
    .img-wrap { margin: 8px 0; }
    .q-img { max-width: 85%; max-height: 220px; object-fit: contain; border: 1px solid #E5E7EB; }
    .stem { margin-bottom: 8px; font-weight: 500; }
    .options { margin-left: 4px; }
    .opt-item { margin-bottom: 4px; }
    .scratch-space { height: 22px; }
    .answer-section { page-break-before: always; }
    .ans-block {
      margin-bottom: 14px;
      padding-bottom: 10px;
      border-bottom: 1px solid #E5E7EB;
      break-inside: avoid;
    }
    .ans-key { color: #059669; font-weight: 800; font-size: 12pt; }
    .wrong-tag { color: #DC2626; font-size: 9.5pt; }
    .fast-tip {
      background: #FEF3C7;
      color: #92400E;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 9.5pt;
      margin: 4px 0;
    }
    .ans-detail { font-size: 9.8pt; color: #374151; }
  </style>
</head>
<body>
  <div class="doc-header">
    <h1>${escapeHtml(sheetTitle)}</h1>
    <p>共 ${items.length} 题（无答案刷题区 · 参考答案与秒杀复盘附于末页） · 建议限时 ${Math.ceil(items.length * 0.9)} 分钟</p>
  </div>
  ${questionsHtml}

  <div class="answer-section">
    <div class="doc-header">
      <h1>参考答案与考场秒杀速查</h1>
    </div>
    ${answersHtml}
  </div>
</body>
</html>`;

  const { uri } = await Print.printToFileAsync({ html });
  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(uri, {
      mimeType: 'application/pdf',
      dialogTitle: '保存或发送无答案刷题 PDF',
      UTI: 'com.adobe.pdf',
    });
  }
}

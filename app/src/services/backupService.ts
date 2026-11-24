import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';
import {
  cleanupTempPickedUri,
  pickDocumentSafe,
  readUriAsText,
} from './localFileReader';
import {
  getUserDb,
  listCourseMaterials,
  listMistakes,
  loadStudyPlanState,
  saveStudyPlanState,
  upsertCourseMaterial,
  upsertMistake,
} from '../db/database';
import { CourseMaterialDoc, MistakeRecord, StudyPlanState } from '../types/models';
import { readLocalImageAsDataUri } from './captureService';

interface PortableBackupPayload {
  backupVersion: '1.0' | '1.1';
  exportedAt: string;
  mistakes: Array<{
    record: MistakeRecord;
    embeddedImages: {
      stemDataUri?: string | null;
      materialDataUri?: string | null;
      answerDataUri?: string | null;
    };
  }>;
  practiceLogs: any[];
  courseMaterials?: CourseMaterialDoc[];
  studyPlan?: StudyPlanState | null;
}

function stripDataUriPrefix(dataUri: string): { ext: string; base64: string } {
  const match = dataUri.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
  if (!match) {
    return { ext: 'jpg', base64: dataUri };
  }
  const ext = match[1].includes('png') ? 'png' : 'jpg';
  return { ext, base64: match[2] };
}

function base64ToUint8Array(base64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const byteLen = (clean.length * 3) / 4 - padding;
  const out = new Uint8Array(byteLen);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const e1 = chars.indexOf(clean[i]);
    const e2 = chars.indexOf(clean[i + 1]);
    const e3 = clean[i + 2] === '=' ? 0 : chars.indexOf(clean[i + 2]);
    const e4 = clean[i + 3] === '=' ? 0 : chars.indexOf(clean[i + 3]);
    const n = (e1 << 18) | (e2 << 12) | (e3 << 6) | e4;
    if (p < byteLen) out[p++] = (n >> 16) & 255;
    if (p < byteLen) out[p++] = (n >> 8) & 255;
    if (p < byteLen) out[p++] = n & 255;
  }
  return out;
}

/** 导出包含全部错题、SM-2进度、追问历史与实拍原图的便携式单文件备份包 */
export async function exportFullNotebookBackup(): Promise<void> {
  const mistakes = await listMistakes();
  const uDb = getUserDb();
  const practiceLogs = await uDb.getAllAsync<any>('SELECT * FROM practice_logs');

  const packedMistakes: PortableBackupPayload['mistakes'] = [];
  for (const m of mistakes) {
    packedMistakes.push({
      record: m,
      embeddedImages: {
        stemDataUri: await readLocalImageAsDataUri(m.captureImages.stemImageUri),
        materialDataUri: await readLocalImageAsDataUri(m.captureImages.materialImageUri),
        answerDataUri: await readLocalImageAsDataUri(m.captureImages.answerImageUri),
      },
    });
  }

  const [courseMaterials, studyPlan] = await Promise.all([
    listCourseMaterials(),
    loadStudyPlanState(),
  ]);

  const payload: PortableBackupPayload = {
    backupVersion: '1.1',
    exportedAt: new Date().toISOString(),
    mistakes: packedMistakes,
    practiceLogs,
    courseMaterials,
    studyPlan,
  };

  const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outFile = new File(Paths.cache, `公考朱批录错题备份_${dateTag}.json`);
  if (outFile.exists) {
    outFile.delete();
  }
  outFile.create();
  await outFile.write(JSON.stringify(payload, null, 2));

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(outFile.uri, {
      mimeType: 'application/json',
      dialogTitle: '导出保存错题本全量备份文件',
    });
  }
}

/** 从手机文件选择器导入恢复错题备份包 */
export async function importFullNotebookBackup(): Promise<{ restoredMistakes: number }> {
  const asset = await pickDocumentSafe(['application/json', 'text/plain', '*/*']);
  if (!asset) {
    return { restoredMistakes: 0 };
  }

  let rawText = '';
  try {
    rawText = await readUriAsText(asset.uri);
  } finally {
    cleanupTempPickedUri(asset.uri);
  }
  const parsed = JSON.parse(rawText) as PortableBackupPayload;
  if (!parsed || !Array.isArray(parsed.mistakes)) {
    throw new Error('所选文件不是有效的「公考朱批录」备份文件');
  }

  const capturesDir = new Directory(Paths.document, 'captures');
  capturesDir.create({ idempotent: true });

  const restoreImage = async (dataUri?: string | null, prefix = 'rest'): Promise<string | null> => {
    if (!dataUri) return null;
    const { ext, base64 } = stripDataUriPrefix(dataUri);
    const dst = new File(
      capturesDir,
      `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`
    );
    dst.create();
    await dst.write(base64ToUint8Array(base64));
    return dst.uri;
  };

  let count = 0;
  for (const item of parsed.mistakes) {
    const rec = item.record;
    const stemUri = await restoreImage(item.embeddedImages?.stemDataUri, 'stem');
    const matUri = await restoreImage(item.embeddedImages?.materialDataUri, 'mat');
    const ansUri = await restoreImage(item.embeddedImages?.answerDataUri, 'ans');

    await upsertMistake({
      ...rec,
      captureImages: {
        stemImageUri: stemUri || rec.captureImages?.stemImageUri || null,
        materialImageUri: matUri || rec.captureImages?.materialImageUri || null,
        answerImageUri: ansUri || rec.captureImages?.answerImageUri || null,
      },
    });
    count += 1;
  }

  if (Array.isArray(parsed.practiceLogs)) {
    const uDb = getUserDb();
    for (const pl of parsed.practiceLogs) {
      await uDb.runAsync(
        `INSERT OR IGNORE INTO practice_logs (
          id, target_type, target_id, source_mistake_id,
          selected_answer, is_correct, time_spent_sec, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          String(pl.id),
          String(pl.target_type || 'real_question'),
          String(pl.target_id),
          pl.source_mistake_id || null,
          String(pl.selected_answer || 'A'),
          Number(pl.is_correct || 0),
          Number(pl.time_spent_sec || 0),
          Number(pl.created_at || Date.now()),
        ]
      );
    }
  }

  if (Array.isArray(parsed.courseMaterials)) {
    for (const cm of parsed.courseMaterials) {
      await upsertCourseMaterial(cm);
    }
  }
  if (parsed.studyPlan) {
    await saveStudyPlanState(parsed.studyPlan);
  }

  return { restoredMistakes: count };
}

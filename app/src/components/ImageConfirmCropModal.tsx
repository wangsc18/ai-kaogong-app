import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  CapturedImageAsset,
  finalizeCapturedImage,
  RawPickedImage,
  rotateImage90,
} from '../services/captureService';

interface Props {
  visible: boolean;
  rawImage: RawPickedImage | null;
  onCancel: () => void;
  onConfirm: (finalAsset: CapturedImageAsset) => void;
}

interface NormCrop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const DEFAULT_CROP: NormCrop = {
  left: 0.04,
  top: 0.08,
  right: 0.96,
  bottom: 0.92,
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function ImageConfirmCropModal({
  visible,
  rawImage,
  onCancel,
  onConfirm,
}: Props) {
  const [currentImg, setCurrentImg] = useState<RawPickedImage | null>(rawImage);
  const [isCropMode, setIsCropMode] = useState(false);
  const [crop, setCrop] = useState<NormCrop>(DEFAULT_CROP);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    setCurrentImg(rawImage);
    setIsCropMode(false);
    setCrop(DEFAULT_CROP);
    setProcessing(false);
  }, [rawImage, visible]);

  // 计算图片在 contain 模式下的精确屏幕投影区域
  const displayRect = useMemo(() => {
    if (!currentImg || containerSize.width <= 0 || containerSize.height <= 0) {
      return { x: 0, y: 0, w: 1, h: 1 };
    }
    const scale = Math.min(
      containerSize.width / currentImg.width,
      containerSize.height / currentImg.height
    );
    const w = currentImg.width * scale;
    const h = currentImg.height * scale;
    const x = (containerSize.width - w) / 2;
    const y = (containerSize.height - h) / 2;
    return { x, y, w: Math.max(1, w), h: Math.max(1, h) };
  }, [currentImg, containerSize]);

  const cropRef = useRef(crop);
  cropRef.current = crop;
  const rectRef = useRef(displayRect);
  rectRef.current = displayRect;

  const dragStartRef = useRef<NormCrop>(DEFAULT_CROP);

  // 左上角控制柄
  const tlPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          dragStartRef.current = { ...cropRef.current };
        },
        onPanResponderMove: (_, g) => {
          const { w, h } = rectRef.current;
          const s = dragStartRef.current;
          setCrop({
            ...s,
            left: clamp(s.left + g.dx / w, 0, s.right - 0.12),
            top: clamp(s.top + g.dy / h, 0, s.bottom - 0.1),
          });
        },
      }),
    []
  );

  // 右上角控制柄
  const trPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          dragStartRef.current = { ...cropRef.current };
        },
        onPanResponderMove: (_, g) => {
          const { w, h } = rectRef.current;
          const s = dragStartRef.current;
          setCrop({
            ...s,
            right: clamp(s.right + g.dx / w, s.left + 0.12, 1),
            top: clamp(s.top + g.dy / h, 0, s.bottom - 0.1),
          });
        },
      }),
    []
  );

  // 左下角控制柄
  const blPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          dragStartRef.current = { ...cropRef.current };
        },
        onPanResponderMove: (_, g) => {
          const { w, h } = rectRef.current;
          const s = dragStartRef.current;
          setCrop({
            ...s,
            left: clamp(s.left + g.dx / w, 0, s.right - 0.12),
            bottom: clamp(s.bottom + g.dy / h, s.top + 0.1, 1),
          });
        },
      }),
    []
  );

  // 右下角控制柄
  const brPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          dragStartRef.current = { ...cropRef.current };
        },
        onPanResponderMove: (_, g) => {
          const { w, h } = rectRef.current;
          const s = dragStartRef.current;
          setCrop({
            ...s,
            right: clamp(s.right + g.dx / w, s.left + 0.12, 1),
            bottom: clamp(s.bottom + g.dy / h, s.top + 0.1, 1),
          });
        },
      }),
    []
  );

  // 裁剪框整体拖动平移
  const movePan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          dragStartRef.current = { ...cropRef.current };
        },
        onPanResponderMove: (_, g) => {
          const { w, h } = rectRef.current;
          const s = dragStartRef.current;
          const bw = s.right - s.left;
          const bh = s.bottom - s.top;
          const nextLeft = clamp(s.left + g.dx / w, 0, 1 - bw);
          const nextTop = clamp(s.top + g.dy / h, 0, 1 - bh);
          setCrop({
            left: nextLeft,
            top: nextTop,
            right: nextLeft + bw,
            bottom: nextTop + bh,
          });
        },
      }),
    []
  );

  if (!currentImg) return null;

  const handleLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setContainerSize({ width, height });
  };

  const handleRotate = async () => {
    if (processing) return;
    setProcessing(true);
    try {
      const rotated = await rotateImage90(currentImg);
      setCurrentImg(rotated);
      setCrop(DEFAULT_CROP);
    } catch (err: any) {
      Alert.alert('旋转失败', err?.message || String(err));
    } finally {
      setProcessing(false);
    }
  };

  const handleFinalize = async (applyCrop: boolean) => {
    if (processing) return;
    setProcessing(true);
    try {
      const result = await finalizeCapturedImage(
        currentImg,
        applyCrop ? crop : null
      );
      onConfirm(result);
    } catch (err: any) {
      Alert.alert('保存图片失败', err?.message || String(err));
      setProcessing(false);
    }
  };

  const boxLeft = displayRect.x + crop.left * displayRect.w;
  const boxTop = displayRect.y + crop.top * displayRect.h;
  const boxWidth = (crop.right - crop.left) * displayRect.w;
  const boxHeight = (crop.bottom - crop.top) * displayRect.h;

  return (
    <View style={styles.root}>
      {/* 顶部栏 */}
        <View style={styles.header}>
          <Pressable style={styles.backBtn} onPress={onCancel} disabled={processing}>
            <Ionicons name="arrow-back" size={22} color="#FFFFFF" />
            <Text style={styles.backText}>重新选图</Text>
          </Pressable>

          <Text style={styles.headerTitle}>
            {isCropMode ? '拖动四角框选单道题目' : '图片预览确认'}
          </Text>

          <Pressable style={styles.rotateTopBtn} onPress={handleRotate} disabled={processing}>
            <Ionicons name="refresh" size={18} color="#FFFFFF" />
            <Text style={styles.rotateTopText}>旋转</Text>
          </Pressable>
        </View>

        {/* 画布区 */}
        <View style={styles.canvas} onLayout={handleLayout}>
          <Image
            source={{ uri: currentImg.uri }}
            style={styles.fullImage}
            resizeMode="contain"
          />

          {isCropMode && containerSize.width > 0 ? (
            <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
              {/* 四周半透明暗色遮罩 */}
              <View
                pointerEvents="none"
                style={[styles.dimMask, { top: 0, left: 0, right: 0, height: boxTop }]}
              />
              <View
                pointerEvents="none"
                style={[
                  styles.dimMask,
                  { top: boxTop + boxHeight, left: 0, right: 0, bottom: 0 },
                ]}
              />
              <View
                pointerEvents="none"
                style={[
                  styles.dimMask,
                  { top: boxTop, left: 0, width: boxLeft, height: boxHeight },
                ]}
              />
              <View
                pointerEvents="none"
                style={[
                  styles.dimMask,
                  {
                    top: boxTop,
                    left: boxLeft + boxWidth,
                    right: 0,
                    height: boxHeight,
                  },
                ]}
              />

              {/* 裁剪框主体（支持按住内部平移） */}
              <View
                {...movePan.panHandlers}
                style={[
                  styles.cropFrame,
                  {
                    left: boxLeft,
                    top: boxTop,
                    width: boxWidth,
                    height: boxHeight,
                  },
                ]}
              >
                <View style={styles.gridRow1} pointerEvents="none" />
                <View style={styles.gridRow2} pointerEvents="none" />
              </View>

              {/* 四个大触控角标 */}
              <View
                {...tlPan.panHandlers}
                style={[styles.handleHitBox, { left: boxLeft - 18, top: boxTop - 18 }]}
              >
                <View style={[styles.cornerL, styles.cornerTL]} />
              </View>

              <View
                {...trPan.panHandlers}
                style={[
                  styles.handleHitBox,
                  { left: boxLeft + boxWidth - 18, top: boxTop - 18 },
                ]}
              >
                <View style={[styles.cornerL, styles.cornerTR]} />
              </View>

              <View
                {...blPan.panHandlers}
                style={[
                  styles.handleHitBox,
                  { left: boxLeft - 18, top: boxTop + boxHeight - 18 },
                ]}
              >
                <View style={[styles.cornerL, styles.cornerBL]} />
              </View>

              <View
                {...brPan.panHandlers}
                style={[
                  styles.handleHitBox,
                  { left: boxLeft + boxWidth - 18, top: boxTop + boxHeight - 18 },
                ]}
              >
                <View style={[styles.cornerL, styles.cornerBR]} />
              </View>
            </View>
          ) : null}
        </View>

        {/* 底部操作栏：默认直接给「可选裁剪」+「独立确认键」！ */}
        <View style={styles.footer}>
          {processing ? (
            <View style={styles.processingWrap}>
              <ActivityIndicator color="#FFFFFF" />
              <Text style={styles.processingText}>正在处理图片...</Text>
            </View>
          ) : !isCropMode ? (
            <View style={styles.btnRow}>
              <Pressable
                style={styles.optionalCropBtn}
                onPress={() => setIsCropMode(true)}
              >
                <Ionicons name="crop" size={19} color="#E0E7FF" />
                <Text style={styles.optionalCropText}>裁剪框选（可选）</Text>
              </Pressable>

              <Pressable
                style={styles.confirmDirectBtn}
                onPress={() => handleFinalize(false)}
              >
                <Ionicons name="checkmark-circle" size={21} color="#FFFFFF" />
                <Text style={styles.confirmDirectText}>确认使用原图</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.btnRow}>
              <Pressable
                style={styles.cancelCropBtn}
                onPress={() => setIsCropMode(false)}
              >
                <Text style={styles.cancelCropText}>取消裁剪</Text>
              </Pressable>

              <Pressable
                style={styles.confirmDirectBtn}
                onPress={() => handleFinalize(true)}
              >
                <Ionicons name="checkmark-done-circle" size={21} color="#FFFFFF" />
                <Text style={styles.confirmDirectText}>应用裁剪并确认</Text>
              </Pressable>
            </View>
          )}
        </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#1E293B',
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
  },
  backText: {
    color: '#E2E8F0',
    fontSize: 14,
    fontWeight: '600',
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 15.5,
    fontWeight: '700',
  },
  rotateTopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  rotateTopText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  canvas: {
    flex: 1,
    margin: 12,
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullImage: {
    width: '100%',
    height: '100%',
  },
  dimMask: {
    position: 'absolute',
    backgroundColor: 'rgba(0, 0, 0, 0.58)',
  },
  cropFrame: {
    position: 'absolute',
    borderWidth: 1.8,
    borderColor: '#818CF8',
  },
  gridRow1: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '33.3%',
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  gridRow2: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '66.6%',
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  handleHitBox: {
    position: 'absolute',
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cornerL: {
    width: 20,
    height: 20,
    borderColor: '#FFFFFF',
  },
  cornerTL: {
    borderTopWidth: 3.5,
    borderLeftWidth: 3.5,
  },
  cornerTR: {
    borderTopWidth: 3.5,
    borderRightWidth: 3.5,
  },
  cornerBL: {
    borderBottomWidth: 3.5,
    borderLeftWidth: 3.5,
  },
  cornerBR: {
    borderBottomWidth: 3.5,
    borderRightWidth: 3.5,
  },
  footer: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  processingWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 10,
  },
  processingText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  btnRow: {
    flexDirection: 'row',
    gap: 12,
  },
  optionalCropBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1.2,
    borderColor: '#6366F1',
    backgroundColor: 'rgba(99, 102, 241, 0.16)',
  },
  optionalCropText: {
    color: '#E0E7FF',
    fontSize: 14,
    fontWeight: '700',
  },
  cancelCropBtn: {
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelCropText: {
    color: '#E2E8F0',
    fontSize: 14,
    fontWeight: '700',
  },
  confirmDirectBtn: {
    flex: 1.35,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: '#10B981',
  },
  confirmDirectText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
});

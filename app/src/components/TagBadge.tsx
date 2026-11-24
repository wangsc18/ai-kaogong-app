import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ERROR_REASONS, MODULE_THEME } from '../taxonomy/kaogongTaxonomy';
import { ErrorReason, MasteryStatus, ModuleL1 } from '../types/models';

export function ModuleBadge({ module }: { module: ModuleL1 }) {
  const theme = MODULE_THEME[module] || MODULE_THEME['判断推理'];
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: theme.bg, borderColor: theme.border },
      ]}
    >
      <Text style={[styles.badgeText, { color: theme.text }]}>{module}</Text>
    </View>
  );
}

export function ErrorReasonBadge({ reason }: { reason: ErrorReason }) {
  const meta = ERROR_REASONS.find((r) => r.value === reason);
  const color = meta?.color || '#4B5563';
  return (
    <View style={[styles.badge, { backgroundColor: `${color}15`, borderColor: `${color}40` }]}>
      <Text style={[styles.badgeText, { color }]}>{reason}</Text>
    </View>
  );
}

export function MasteryBadge({ status }: { status: MasteryStatus }) {
  const map: Record<MasteryStatus, { label: string; bg: string; color: string }> = {
    learning: { label: '待攻坚', bg: '#FEE2E2', color: '#B91C1C' },
    reviewing: { label: '巩固中', bg: '#E0E7FF', color: '#3730A3' },
    mastered: { label: '已掌握', bg: '#D1FAE5', color: '#065F46' },
  };
  const cfg = map[status] || map.learning;
  return (
    <View style={[styles.badge, { backgroundColor: cfg.bg, borderColor: 'transparent' }]}>
      <Text style={[styles.badgeText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  badgeText: {
    fontSize: 11.5,
    fontWeight: '600',
  },
});

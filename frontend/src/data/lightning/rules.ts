/**
 * 判定规则与取值范围：全系统收敛成一套。
 * - 取值上限只有一个：RESISTANCE_LIMIT = 200Ω（同时是检测表计的有效量程上限）。
 * - 合格判定按检测点分档：强电舱 / 弱电（含综合）舱各一个阈值。
 * - 规则可以换版，但阈值与上限在任一时刻只有"现行一版"在生效；
 *   旧版冻结在 RULE_VERSIONS 里仅用于存量留痕，不再参与新登记判定。
 *
 * 缺项处理办法（处理说明，落地见 service.ts 的登记/补录逻辑）：
 *   1. 任何来源都禁止臆造或填默认值——缺项一律保持为空，并登记到 missingFields 与 source；
 *   2. 缺"接地电阻实测值"或"防雷检测日期"（判定必需项）的记录，判为「数据缺项」，
 *      卡在第①段不予判定，自动挂一条「缺项补测」待办到设备保养计划，补测回写后才放行；
 *   3. 上线前纸质老记录整批补录时，缺项单独标注来源（如"检测队记录纸2024-08，电阻栏空白"），
 *      同样按第 2 条处理，不因是老记录而放行，也不替它猜一个读数。
 */

import type { CabinClass, LightningRecord, SpdStatus, Verdict } from './types'

/** 接地电阻取值上限（Ω），唯一一套。超上限（含表计超量程）一律超限处理。 */
export const RESISTANCE_LIMIT = 200

/** SPD 状态中视为异常、需要处置的取值（并入同一条记录判定）。 */
export const SPD_ABNORMAL: SpdStatus[] = ['劣化', '失效', '未装']

export interface RuleVersion {
  version: string
  label: string
  /** 生效起（含）；按防雷检测日期匹配。 */
  effectiveFrom: string
  /** 生效止（不含）；null 表示至今有效。任一时刻只允许一个版本至今有效。 */
  effectiveTo: string | null
  /** 分档阈值（Ω），电阻 ≤ 阈值为合格。 */
  thresholds: Record<CabinClass, number>
  note: string
}

/**
 * 旧版 v1 只作留痕：新登记一律按现行 v2 判。
 * 冲突时的准据（写进每条记录的 conflictNote）：
 *   以"登记当时生效版本"的判定为准并冻结；新版上线只影响新登记，已入账不翻案。
 */
export const RULE_VERSIONS: RuleVersion[] = [
  {
    version: 'v1',
    label: '旧版（电力部分4Ω / 弱电部分10Ω）',
    effectiveFrom: '2024-01-01',
    effectiveTo: '2026-01-01',
    thresholds: { 强电: 4, 弱电: 10 },
    note: 'GB 50838 旧档：电力舱接地电阻不大于4Ω，弱电舱不大于10Ω。仅用于上线前老记录留痕。',
  },
  {
    version: 'v2',
    label: '现行版（强电4Ω / 弱电10Ω，2026-01-01起）',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    thresholds: { 强电: 4, 弱电: 10 },
    note: '现行有效版本，2026-01-01 起所有新登记、复测一律按此版判定，取值上限200Ω。',
  },
]

/** 现行唯一在效版本。 */
export const CURRENT_RULE: RuleVersion =
  RULE_VERSIONS.find((item) => item.effectiveTo === null) ?? RULE_VERSIONS[RULE_VERSIONS.length - 1]

/** 按业务发生日（防雷检测日期）取当时生效版本；找不到时回落现行版并标注。 */
export function ruleAtDate(date: string): RuleVersion {
  const hit = RULE_VERSIONS.find(
    (item) => date >= item.effectiveFrom && (item.effectiveTo === null || date < item.effectiveTo),
  )
  return hit ?? CURRENT_RULE
}

/** 电阻判定：null=缺项不判；超上限=超限不合格；否则按舱室分档比阈值。 */
export function judgeResistance(
  resistance: number | null,
  overRange: boolean,
  cabinClass: CabinClass,
  rule: RuleVersion,
): { verdict: Verdict | null; reason: string } {
  if (resistance === null || Number.isNaN(resistance)) {
    return { verdict: null, reason: '接地电阻缺项，无法判定' }
  }
  const limitText = `取值上限${RESISTANCE_LIMIT}Ω`
  if (overRange || resistance > RESISTANCE_LIMIT) {
    return {
      verdict: '不合格',
      reason: `实测${resistance}Ω超出${limitText}（含表计超量程），照超限处理判不合格，挂复测`,
    }
  }
  const threshold = rule.thresholds[cabinClass]
  if (resistance <= threshold) {
    return {
      verdict: '合格',
      reason: `${cabinClass}舱阈值${threshold}Ω，实测${resistance}Ω，达标（${rule.version}）`,
    }
  }
  return {
    verdict: '不合格',
    reason: `${cabinClass}舱阈值${threshold}Ω，实测${resistance}Ω，超标（${rule.version}）`,
  }
}

export function isSpdAbnormal(status: SpdStatus): boolean {
  return SPD_ABNORMAL.includes(status)
}

/** 新旧两版结论冲突时的留痕说明；以登记当时版本为准。 */
export function buildConflictNote(record: Pick<LightningRecord, 'inspectDate' | 'ruleVersion' | 'verdict'>): string {
  const other = RULE_VERSIONS.find((item) => item.version !== record.ruleVersion)
  if (!other) return ''
  return `冲突准据：以登记当时（检测日${record.inspectDate}）生效的 ${record.ruleVersion} 判定为准并冻结，结论「${record.verdict ?? '—'}」；${other.version} 结论仅留痕，不改判、不重算。`
}

export function ruleLabel(version: string): string {
  return RULE_VERSIONS.find((item) => item.version === version)?.label ?? version
}

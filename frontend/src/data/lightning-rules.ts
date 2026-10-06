// 廊内防雷接地检测的判定规则只维护这一份：分档阈值、取值上限、浪涌保护器状态都在这里，
// 台账页面、报送、复测、整批补录都读这一份，不另抄第二套。换版时新增一个版本段，
// 已入账的记录继续沿用登记当时的版本，现行版只影响新登记的那份。

export type RuleGrade = 'Ⅰ档' | 'Ⅱ档'

export type RuleVersion = {
  version: string
  effectiveFrom: string // 适用起始日（含），按防雷检测日期对齐
  effectiveTo: string | null // 适用截止日（含），null 表示现行版
  gradeLimits: Record<RuleGrade, number> // 合格阈值（Ω），按检测点分档
  hardLimit: number // 取值上限（Ω），实测值超过上限一律判超限
}

export const GRADE_LABELS: Record<RuleGrade, string> = {
  Ⅰ档: '引下线/接地干线检测点',
  Ⅱ档: '设备与浪涌保护器接地检测点',
}

export const RULE_VERSIONS: RuleVersion[] = [
  {
    version: '2025版',
    effectiveFrom: '2025-01-01',
    effectiveTo: '2025-12-31',
    gradeLimits: { Ⅰ档: 4, Ⅱ档: 10 },
    hardLimit: 30,
  },
  {
    version: '2026版',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    gradeLimits: { Ⅰ档: 1, Ⅱ档: 4 },
    hardLimit: 10,
  },
]

// 现行版：新登记（含重复报送的新一版）一律按这套判定。
export const CURRENT_RULE_VERSION = '2026版'

// 浪涌保护器状态并入同一条检测记录参与判定：劣化、失效直接判不合格；状态缺失按缺项处理。
export const SPD_FAIL_STATES = ['劣化', '失效']
export const SPD_MISSING_STATE = '未登记'
export const SPD_STATES = ['正常', '劣化', '失效', SPD_MISSING_STATE]

// 缺项占位值：实测值缺失不估数、不沿用邻点，记「缺测」并挂复测。
export const MISSING_READING = '缺测'

export type Judgement = {
  conclusion: '合格' | '不合格' | '超限' | '缺项待补'
  reason: string
}

export function currentRuleVersion(): RuleVersion {
  const found = RULE_VERSIONS.find((item) => item.version === CURRENT_RULE_VERSION)
  if (!found) {
    throw new Error(`判定规则缺少现行版 ${CURRENT_RULE_VERSION}`)
  }
  return found
}

export function ruleVersionByName(version: string): RuleVersion {
  const found = RULE_VERSIONS.find((item) => item.version === version)
  if (!found) {
    throw new Error(`判定规则没有登记「${version}」`)
  }
  return found
}

// 存量检测点按防雷检测日期回填适用版本，只在整批补录时用一次。
export function ruleVersionByDate(date: string): RuleVersion {
  const found = RULE_VERSIONS.find(
    (item) => item.effectiveFrom <= date && (item.effectiveTo === null || date <= item.effectiveTo),
  )
  if (!found) {
    throw new Error(`防雷检测日期 ${date} 找不到适用的判定规则版本`)
  }
  return found
}

// 判定入口：同一份读数只出一个结论，阈值与取值上限都取传入的这一版规则。
export function judgeReading(
  grade: string,
  reading: string | number,
  spdState: string,
  rule: RuleVersion,
): Judgement {
  const raw = String(reading ?? '').trim()
  if (raw === '' || raw === MISSING_READING) {
    return {
      conclusion: '缺项待补',
      reason: '接地电阻实测值缺失，按缺测处理：不估数、不沿用邻点，需挂复测现场补测',
    }
  }
  const value = Number(raw)
  if (Number.isNaN(value) || value < 0) {
    return { conclusion: '缺项待补', reason: `实测值「${raw}」无法辨认，按缺项处理，需挂复测重新采集` }
  }
  const limit = rule.gradeLimits[grade as RuleGrade]
  if (limit === undefined) {
    return { conclusion: '缺项待补', reason: `检测点分档「${grade}」未登记，需先补登分档再判定` }
  }
  const spdFailed = SPD_FAIL_STATES.includes(spdState)
  if (value > rule.hardLimit) {
    const extra = spdFailed ? `，且浪涌保护器${spdState}需更换` : ''
    return {
      conclusion: '超限',
      reason: `实测${value}Ω超出取值上限${rule.hardLimit}Ω（${rule.version}）${extra}，按超限处理`,
    }
  }
  const reasons: string[] = []
  if (value > limit) {
    reasons.push(`实测${value}Ω超出${grade}合格阈值${limit}Ω（${rule.version}）`)
  }
  if (spdFailed) {
    reasons.push(`浪涌保护器${spdState}，需安排更换`)
  }
  if (reasons.length > 0) {
    return { conclusion: '不合格', reason: reasons.join('；') }
  }
  if (spdState === SPD_MISSING_STATE) {
    return { conclusion: '缺项待补', reason: '浪涌保护器状态未登记，按缺项处理，随复测现场补登' }
  }
  return { conclusion: '合格', reason: `实测${value}Ω不高于${grade}合格阈值${limit}Ω（${rule.version}）` }
}

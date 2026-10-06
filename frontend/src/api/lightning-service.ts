import {
  CURRENT_RULE_VERSION,
  MISSING_READING,
  SPD_MISSING_STATE,
  currentRuleVersion,
  judgeReading,
  ruleVersionByDate,
  ruleVersionByName,
} from '@/data/lightning-rules'
import { LEGACY_PAPER_ROWS, LEGACY_SOURCE_LABEL } from '@/data/lightning-legacy'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 廊内防雷接地检测台账的专用服务：报送去重、分环节流转、判定、复测联动设备台账都在这里。
// 台账（lightning）与设备侧待办清单（device）在同一个动作里一起落库，两边不各算各的。
const KEY = 'lightning'
const DEVICE_KEY = 'device'
const LINK_FIELD = '来源检测点'
// 上线前老记录整批补录的批次号：入账时打上这个标记，跑过一次就不再重复入账。
const BACKFILL_BATCH = 'BL-2026-01'

// 环节只能一段一段往下推进：待判定 → 已判定 →（合格归档 | 挂出复测）→ 复测中 → 已闭环。
const STAGES = ['待判定', '已判定', '复测中', '已闭环'] as const

export type ReadingInput = {
  检测点编号: string
  桩号: string
  所属舱室: string
  检测点分档: string
  接地电阻实测值: string
  防雷检测日期: string
  浪涌保护器状态: string
}

export type BackfillResult = ActionResult & { lines: string[] }

export type ConsistencyResult = {
  ledgerOpenRetest: number
  deviceOpenTodo: number
  consistent: boolean
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function findPoint(rows: EntryRow[], code: string): EntryRow | undefined {
  return rows.find((row) => String(row['检测点编号']) === code)
}

// 留痕：每次被新版读数顶替时，把上一版完整快照进留痕串，可追溯但不参与判定。
// snapshot 缺省时存台账当前这一版；补录老记录被现行版压住时，改存纸质记录那一版。
function appendTrace(
  row: EntryRow,
  source: string,
  snapshot?: { 接地电阻实测值: string | number; 防雷检测日期: string; 浪涌保护器状态: string },
): string {
  let trace: unknown[] = []
  try {
    trace = JSON.parse(String(row['报送留痕'] ?? '[]')) as unknown[]
    if (!Array.isArray(trace)) {
      trace = []
    }
  } catch {
    trace = []
  }
  trace.push({
    留痕时间: today(),
    来源: source,
    报送版本: snapshot ? '纸质记录' : (row['报送版本'] ?? 1),
    接地电阻实测值: snapshot ? snapshot.接地电阻实测值 : (row['接地电阻实测值'] ?? ''),
    防雷检测日期: snapshot ? snapshot.防雷检测日期 : (row['防雷检测日期'] ?? ''),
    浪涌保护器状态: snapshot ? snapshot.浪涌保护器状态 : (row['浪涌保护器状态'] ?? ''),
    判定标准版本: snapshot ? '' : (row['判定标准版本'] ?? ''),
    判定结论: snapshot ? '' : (row['判定结论'] ?? ''),
  })
  return JSON.stringify(trace)
}

function traceCount(row: EntryRow): number {
  try {
    const trace = JSON.parse(String(row['报送留痕'] ?? '[]')) as unknown[]
    return Array.isArray(trace) ? trace.length : 0
  } catch {
    return 0
  }
}

function stageBlocked(row: EntryRow, expected: string, action: string): ActionResult | null {
  const current = String(row.status)
  if (current === expected) {
    return null
  }
  const currentIndex = STAGES.indexOf(current as (typeof STAGES)[number])
  const expectedIndex = STAGES.indexOf(expected as (typeof STAGES)[number])
  const direction = currentIndex < expectedIndex ? '尚未走到' : '已经走过'
  return {
    ok: false,
    message: `「${action}」打回：该检测点卡在「${current}」环节（${direction}「${expected}」），环节只能一段一段往下推进`,
  }
}

function validateReading(input: ReadingInput): string | null {
  if (!input.检测点编号.trim()) return '检测点编号不能为空'
  if (!input.桩号.trim()) return '桩号不能为空'
  if (!input.所属舱室.trim()) return '所属舱室不能为空'
  if (!input.检测点分档.trim()) return '检测点分档不能为空'
  if (!input.防雷检测日期.trim()) return '防雷检测日期不能为空'
  const value = Number(input.接地电阻实测值)
  if (input.接地电阻实测值.trim() === '' || Number.isNaN(value) || value < 0) {
    return '接地电阻实测值需为不小于 0 的数字；老记录缺项请走整批补录，按缺测标注'
  }
  return null
}

// 报送登记：同一检测点重复报送只认最后一版，旧版进留痕，两次读数不叠加、不取平均。
// 新报送一律用现行版判定规则；已入账的老记录继续沿用登记当时的版本。
export function submitReading(input: ReadingInput): ActionResult {
  const error = validateReading(input)
  if (error) {
    return { ok: false, message: error }
  }
  const code = input.检测点编号.trim()
  const rows = listRows(KEY)
  const existing = findPoint(rows, code)
  if (existing && String(existing.status) === '复测中') {
    return {
      ok: false,
      message: `「报送登记」打回：检测点${code}卡在「复测中」环节，复测读数请用「登记复测结论」回写，不能另起一条`,
    }
  }
  const base = {
    检测点编号: code,
    桩号: input.桩号.trim(),
    所属舱室: input.所属舱室.trim(),
    检测点分档: input.检测点分档.trim(),
    接地电阻实测值: Number(input.接地电阻实测值),
    防雷检测日期: input.防雷检测日期.trim(),
    浪涌保护器状态: input.浪涌保护器状态.trim() || SPD_MISSING_STATE,
    判定标准版本: CURRENT_RULE_VERSION,
    判定结论: '未判定',
    判定说明: '',
    留痕结论: '',
    缺项说明: '',
    补录来源: '',
    补录批次: '',
    复测次数: 0,
    status: '待判定',
    pending: true,
    abnormal: false,
  }
  if (existing) {
    const version = Number(existing['报送版本'] ?? 1) + 1
    const updated: EntryRow = {
      ...existing,
      ...base,
      报送版本: version,
      报送留痕: appendTrace(existing, '重复报送'),
    }
    saveRows(KEY, rows.map((row) => (row.id === existing.id ? updated : row)))
    return { ok: true, message: `检测点${code}第${version}版读数已入账，上一版已留痕，待重新判定` }
  }
  const created: EntryRow = { id: nextId(rows), ...base, 报送版本: 1, 报送留痕: '[]' }
  saveRows(KEY, [...rows, created])
  return { ok: true, message: `检测点${code}已登记，按${CURRENT_RULE_VERSION}待判定` }
}

// 提交判定：只认记录上登记的判定标准版本；与现行版冲突时以登记版为准，现行版结论只留痕。
export function submitJudgement(id: number): ActionResult {
  const rows = listRows(KEY)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的接地检测点` }
  }
  const blocked = stageBlocked(row, '待判定', '提交判定')
  if (blocked) {
    return blocked
  }
  const rule = ruleVersionByName(String(row['判定标准版本']))
  const judgement = judgeReading(String(row['检测点分档']), String(row['接地电阻实测值']), String(row['浪涌保护器状态']), rule)
  // 新旧两版判定冲突：以登记时适用的版本为准，另一版（现行版）另算一遍只作留痕。
  let traceNote = ''
  if (String(row['判定标准版本']) !== CURRENT_RULE_VERSION) {
    const alt = judgeReading(String(row['检测点分档']), String(row['接地电阻实测值']), String(row['浪涌保护器状态']), currentRuleVersion())
    if (alt.conclusion !== judgement.conclusion) {
      traceNote = `按${CURRENT_RULE_VERSION}复算为「${alt.conclusion}」（仅留痕，不作判定依据）`
    }
  }
  const updated: EntryRow = {
    ...row,
    判定结论: judgement.conclusion,
    判定说明: judgement.reason,
    留痕结论: traceNote,
    status: '已判定',
    pending: true,
    abnormal: judgement.conclusion === '超限',
  }
  saveRows(KEY, rows.map((item) => (item.id === id ? updated : item)))
  return { ok: true, message: `检测点${row['检测点编号']}判定为「${judgement.conclusion}」（${row['判定标准版本']}）` }
}

// 合格归档：只有判定合格的检测点能直接闭环。
export function archiveQualified(id: number): ActionResult {
  const rows = listRows(KEY)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的接地检测点` }
  }
  const blocked = stageBlocked(row, '已判定', '合格归档')
  if (blocked) {
    return blocked
  }
  if (String(row['判定结论']) !== '合格') {
    return { ok: false, message: `「合格归档」打回：该点判定结论为「${row['判定结论']}」，请挂出复测` }
  }
  const updated: EntryRow = { ...row, status: '已闭环', pending: false, abnormal: false }
  saveRows(KEY, rows.map((item) => (item.id === id ? updated : item)))
  return { ok: true, message: `检测点${row['检测点编号']}已合格归档` }
}

// 设备台账侧的联动待办：挂复测时生成/重开，复测闭环时同步销号，两边条数始终一致。
function upsertDeviceTodo(point: EntryRow, conclusion: string): void {
  const devices = listRows(DEVICE_KEY)
  const code = String(point['检测点编号'])
  const existing = devices.find((item) => String(item[LINK_FIELD] ?? '') === code)
  const patch = {
    status: '待保养',
    pending: true,
    abnormal: conclusion === '超限',
    设备状态: '待保养',
    保养周期: `复测待办（${conclusion}）`,
  }
  if (existing) {
    saveRows(DEVICE_KEY, devices.map((item) => (item.id === existing.id ? { ...item, ...patch } : item)))
    return
  }
  const created: EntryRow = {
    id: nextId(devices),
    ...patch,
    设备编号: `FLD-${code}`,
    设备名称: `防雷接地装置（${code}·${point['桩号']}）`,
    设备型号: `${point['检测点分档']}接地检测点`,
    所属舱室: point['所属舱室'],
    投运日期: point['防雷检测日期'],
    上次保养日: '—',
    [LINK_FIELD]: code,
  }
  saveRows(DEVICE_KEY, [...devices, created])
}

// 挂出复测：判定不合格/超限/缺项的检测点进入复测环节，同时在设备台账挂出保养待办。
export function openRetest(id: number): ActionResult {
  const rows = listRows(KEY)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的接地检测点` }
  }
  const blocked = stageBlocked(row, '已判定', '挂出复测')
  if (blocked) {
    return blocked
  }
  const conclusion = String(row['判定结论'])
  if (conclusion === '合格') {
    return { ok: false, message: '「挂出复测」打回：该点判定合格，无需复测；如要收尾请用「合格归档」' }
  }
  const updated: EntryRow = { ...row, status: '复测中', pending: true, abnormal: conclusion === '超限' }
  // 台账与设备侧待办在同一个动作里落库，两处同时更新。
  saveRows(KEY, rows.map((item) => (item.id === id ? updated : item)))
  upsertDeviceTodo(updated, conclusion)
  return { ok: true, message: `检测点${row['检测点编号']}已挂出复测，设备台账保养计划已同步待办` }
}

// 登记复测结论：复测读数顶替上一版（旧版留痕），按登记版规则重新判定；
// 合格则台账闭环、设备待办销号，仍不合格则待办保留，两边条数保持一致。
export function closeRetest(id: number, reading: string, date: string, spdState: string): ActionResult {
  const rows = listRows(KEY)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的接地检测点` }
  }
  const blocked = stageBlocked(row, '复测中', '登记复测结论')
  if (blocked) {
    return blocked
  }
  const value = Number(reading)
  if (reading.trim() === '' || Number.isNaN(value) || value < 0) {
    return { ok: false, message: '复测实测值需为不小于 0 的数字' }
  }
  if (!date.trim()) {
    return { ok: false, message: '复测日期不能为空' }
  }
  const code = String(row['检测点编号'])
  const rule = ruleVersionByName(String(row['判定标准版本']))
  const judgement = judgeReading(String(row['检测点分档']), value, spdState, rule)
  const passed = judgement.conclusion === '合格'
  const updated: EntryRow = {
    ...row,
    接地电阻实测值: value,
    防雷检测日期: date.trim(),
    浪涌保护器状态: spdState,
    判定结论: judgement.conclusion,
    判定说明: `复测：${judgement.reason}`,
    缺项说明: '',
    报送版本: Number(row['报送版本'] ?? 1) + 1,
    复测次数: Number(row['复测次数'] ?? 0) + 1,
    报送留痕: appendTrace(row, '复测'),
    status: passed ? '已闭环' : '复测中',
    pending: !passed,
    abnormal: !passed,
  }
  saveRows(KEY, rows.map((item) => (item.id === id ? updated : item)))
  const devices = listRows(DEVICE_KEY)
  const linked = devices.find((item) => String(item[LINK_FIELD] ?? '') === code)
  if (linked) {
    const patch: Record<string, string | number | boolean> = passed
      ? { status: '已保养', pending: false, abnormal: false, 设备状态: '已保养', 保养周期: '复测已闭环', 上次保养日: date.trim() }
      : { status: '待保养', pending: true, abnormal: true, 设备状态: '待保养', 保养周期: `复测待办（复测仍${judgement.conclusion}）` }
    saveRows(DEVICE_KEY, devices.map((item) => (item.id === linked.id ? { ...item, ...patch } : item)))
  }
  return passed
    ? { ok: true, message: `检测点${code}复测合格，台账已闭环，设备台账保养待办已同步销号` }
    : { ok: true, message: `检测点${code}复测仍「${judgement.conclusion}」，复测待办保留，设备台账同步挂起` }
}

// 上线前老记录整批补录：按业务发生日（防雷检测日期）回填判定标准版本，只回填这一次；
// 缺项不估数、不沿用邻点，统一标注来源与缺项说明；与存量同点位的更早记录只留痕不覆盖。
export function backfillLegacyRows(): BackfillResult {
  const rows = [...listRows(KEY)]
  if (rows.some((row) => String(row['补录批次'] ?? '') === BACKFILL_BATCH)) {
    return { ok: false, message: `上线前老记录已按批次 ${BACKFILL_BATCH} 整批补录过，不重复入账`, lines: [] }
  }
  const lines: string[] = []
  let entered = 0
  let traced = 0
  let missing = 0
  for (const paper of LEGACY_PAPER_ROWS) {
    const rule = ruleVersionByDate(paper.防雷检测日期)
    const lacks: string[] = []
    if (paper.接地电阻实测值.trim() === '') {
      lacks.push('接地电阻实测值缺失：按缺测处理，不估数、不沿用邻点，判定为缺项待补并挂复测')
    }
    if (paper.浪涌保护器状态.trim() === '') {
      lacks.push('浪涌保护器状态缺失：按未登记处理，随复测现场补登')
    }
    const existing = findPoint(rows, paper.检测点编号)
    if (existing) {
      // 同一检测点只认最后一版：纸质记录业务发生日更早，只留痕，不覆盖台账现行版。
      if (paper.防雷检测日期 <= String(existing['防雷检测日期'])) {
        const updated: EntryRow = {
          ...existing,
          报送留痕: appendTrace(existing, LEGACY_SOURCE_LABEL, {
            接地电阻实测值: paper.接地电阻实测值.trim() === '' ? MISSING_READING : Number(paper.接地电阻实测值),
            防雷检测日期: paper.防雷检测日期,
            浪涌保护器状态: paper.浪涌保护器状态.trim() === '' ? SPD_MISSING_STATE : paper.浪涌保护器状态,
          }),
        }
        const index = rows.findIndex((item) => item.id === existing.id)
        rows[index] = updated
        traced += 1
        lines.push(`${paper.检测点编号}：纸质记录（${paper.防雷检测日期}）早于台账现行版，只留痕不覆盖`)
        continue
      }
    }
    const created: EntryRow = {
      id: nextId(rows),
      检测点编号: paper.检测点编号,
      桩号: paper.桩号,
      所属舱室: paper.所属舱室,
      检测点分档: paper.检测点分档,
      接地电阻实测值: paper.接地电阻实测值.trim() === '' ? MISSING_READING : Number(paper.接地电阻实测值),
      防雷检测日期: paper.防雷检测日期,
      浪涌保护器状态: paper.浪涌保护器状态.trim() === '' ? SPD_MISSING_STATE : paper.浪涌保护器状态,
      判定标准版本: rule.version,
      判定结论: '未判定',
      判定说明: '',
      留痕结论: '',
      缺项说明: lacks.join('；'),
      补录来源: LEGACY_SOURCE_LABEL,
      补录批次: BACKFILL_BATCH,
      报送版本: 1,
      复测次数: 0,
      报送留痕: '[]',
      status: '待判定',
      pending: true,
      abnormal: false,
    }
    rows.push(created)
    entered += 1
    if (lacks.length > 0) {
      missing += 1
      lines.push(`${paper.检测点编号}：已入账（${rule.version}），缺项已标注——${lacks.join('；')}`)
    } else {
      lines.push(`${paper.检测点编号}：已入账（${rule.version}）`)
    }
  }
  saveRows(KEY, rows)
  lines.unshift(`整批补录完成：新入账 ${entered} 条，留痕不覆盖 ${traced} 条，其中缺项标注 ${missing} 条`)
  return { ok: true, message: `批次 ${BACKFILL_BATCH} 补录完成`, lines }
}

// 台账与设备侧待办的一致性核对：两处读同一份库，条数必须一致。
export function todoConsistency(): ConsistencyResult {
  const ledgerOpenRetest = listRows(KEY).filter((row) => String(row.status) === '复测中').length
  const deviceOpenTodo = listRows(DEVICE_KEY).filter(
    (row) => String(row[LINK_FIELD] ?? '') !== '' && String(row.status) === '待保养',
  ).length
  return { ledgerOpenRetest, deviceOpenTodo, consistent: ledgerOpenRetest === deviceOpenTodo }
}

export function lightningTrace(row: EntryRow): Record<string, unknown>[] {
  try {
    const trace = JSON.parse(String(row['报送留痕'] ?? '[]')) as Record<string, unknown>[]
    return Array.isArray(trace) ? trace : []
  } catch {
    return []
  }
}

export function lightningTraceCount(row: EntryRow): number {
  return traceCount(row)
}

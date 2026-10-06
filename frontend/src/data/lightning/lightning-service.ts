import { LEGACY_PAPER, type LegacyPaperRow } from './legacy-paper'
import {
  CURRENT_RULE,
  RESISTANCE_LIMIT,
  buildConflictNote,
  isSpdAbnormal,
  judgeResistance,
  ruleAtDate,
} from './rules'
import { commitState, loadState } from './lightning-store'
import type {
  HistoryEntry,
  LightningRecord,
  LightningState,
  MaintenanceTodo,
  RegisterInput,
  RetestInput,
  TodoKind,
} from './types'

export interface OkResult<T = undefined> {
  ok: true
  message: string
  data?: T
}
export interface GateReject {
  ok: false
  /** 卡在的环节段：1登记 / 2判定 / 3处置 / 4回写。跨段操作一律打回。 */
  blockedStage: 1 | 2 | 3 | 4
  message: string
}
export type ServiceResult<T = undefined> = OkResult<T> | GateReject

export interface ReconcileReport {
  ledgerOpenCount: number
  todoOpenCount: number
  /** 第②段已判不合格、尚未点"挂出复测"的点数：闸门强制必须进入第③段，不能跳过。 */
  awaitingOpenCount: number
  consistent: boolean
  details: { pointCode: string; kinds: TodoKind[] }[]
}

const STAGE_NAME: Record<1 | 2 | 3 | 4, string> = {
  1: '①登记报送',
  2: '②合格判定',
  3: '③挂出复测/处置',
  4: '④结论回写',
}

const REQUIRED_FIELDS = ['pointCode', 'stake', 'cabin', 'inspectDate'] as const

function now(): string {
  return new Date().toISOString()
}

function today(): string {
  return now().slice(0, 10)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 跨段打回的统一出口：写清卡在哪一段、为什么、下一步该做什么。 */
function reject(
  blockedStage: 1 | 2 | 3 | 4,
  message: string,
): GateReject {
  return {
    ok: false,
    blockedStage,
    message: `已打回，卡在${STAGE_NAME[blockedStage]}：${message}`,
  }
}

function requiredMissing(input: RegisterInput): string[] {
  const missing: string[] = []
  for (const field of REQUIRED_FIELDS) {
    if (!String(input[field] ?? '').trim()) missing.push(field)
  }
  if (input.resistance === null || Number.isNaN(input.resistance)) missing.push('resistance')
  return missing
}

const FIELD_LABEL: Record<string, string> = {
  pointCode: '检测点编号',
  stake: '桩号',
  cabin: '所属舱室',
  inspectDate: '防雷检测日期',
  resistance: '接地电阻实测值',
}

function dueFrom(inspectDate: string): string {
  const d = new Date(`${inspectDate.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  d.setUTCDate(d.getUTCDate() + 7)
  return d.toISOString().slice(0, 10)
}

function makeTodo(
  state: LightningState,
  record: LightningRecord,
  kind: TodoKind,
  reason: string,
): MaintenanceTodo {
  state.todoSeq += 1
  return {
    id: state.todoSeq,
    recordId: record.id,
    pointCode: record.pointCode,
    stake: record.stake,
    cabin: record.cabin,
    deviceCode: record.deviceCode,
    owner: record.owner,
    kind,
    reason,
    dueDate: dueFrom(record.inspectDate || today()),
    status: '待办',
    conclusion: '',
    source: record.backfilled ? `老记录补录（${record.source}）` : '廊内防雷接地检测台账',
    createdAt: now(),
    closedAt: '',
    cancelReason: '',
  }
}

/** 某条记录当前挂起的处置种类：始终从台账行推导，保证两边口径一致。
 * 只有「已挂出（第③段）」或「缺项（登记即挂补测）」才计数；
 * 停在第②段刚判不合格、尚未点"挂出复测"的点不算已挂起（由闸门强制必须走到③，不能跳过、不能闭环）。 */
export function openKindsOf(record: LightningRecord): TodoKind[] {
  if (record.status === '已闭环' || record.status === '合格') return []
  const kinds: TodoKind[] = []
  if (record.status === '数据缺项') {
    kinds.push('缺项补测')
    return kinds
  }
  if (record.stage < 3) return kinds
  if (record.verdict === '不合格') kinds.push('接地电阻复测')
  if (isSpdAbnormal(record.spdStatus)) kinds.push('浪涌保护器更换')
  return kinds
}

function makeRecord(state: LightningState, input: RegisterInput, backfilled: boolean, source: string): LightningRecord {
  state.recordSeq += 1
  const missing = requiredMissing(input).map((key) => FIELD_LABEL[key] ?? key)
  return {
    id: state.recordSeq,
    pointCode: input.pointCode.trim(),
    stake: input.stake.trim(),
    cabin: input.cabin.trim(),
    cabinClass: input.cabinClass,
    resistance: input.resistance,
    overRange: input.overRange,
    inspectDate: input.inspectDate,
    spdCode: input.spdCode,
    spdStatus: input.spdStatus,
    deviceCode: input.deviceCode,
    owner: input.owner,
    stage: 1,
    status: missing.length ? '数据缺项' : '待判定',
    verdict: null,
    ruleVersion: '',
    verdictReason: '',
    conflictNote: '',
    traceVerdict: '',
    pendingKinds: missing.length ? ['缺项补测'] : [],
    missingFields: missing,
    source,
    backfilled,
    retestDate: '',
    retestConclusion: '',
    retestLog: [],
    history: [],
    createdAt: now(),
    judgedAt: '',
    closedAt: '',
    note: input.note,
  }
}

/**
 * 第①段：登记报送。
 * 同一检测点（pointCode）重复报送只认最后一版：旧读数进 history 留痕，绝不与新版叠加；
 * 旧版未闭环的待办随覆盖作废，新的待办在第③段重新挂出，始终以台账行为准。
 */
export function registerInspection(input: RegisterInput): ServiceResult<LightningRecord> {
  const state = clone(loadState())

  const identityMissing = ['pointCode', 'stake', 'cabin', 'inspectDate']
    .filter((key) => !String(input[key as keyof RegisterInput] ?? '').trim())
    .map((key) => FIELD_LABEL[key])
  if (identityMissing.length) {
    return reject(1, `登记要素不完整，缺 ${identityMissing.join('、')}，不予入账，请补全后重新报送。`)
  }
  if (input.resistance !== null && (!Number.isFinite(input.resistance) || input.resistance < 0)) {
    return reject(1, `接地电阻必须是不小于 0 的数；超过上限 ${RESISTANCE_LIMIT}Ω 请保留真实读数并勾选超量程。`)
  }

  const existingIndex = state.records.findIndex((row) => row.pointCode === input.pointCode.trim())
  const source = '现场检测报送'
  let record: LightningRecord

  if (existingIndex >= 0) {
    const old = state.records[existingIndex]
    const snap: HistoryEntry = {
      version: old.history.length + 1,
      resistance: old.resistance,
      overRange: old.overRange,
      inspectDate: old.inspectDate,
      spdStatus: old.spdStatus,
      verdict: old.verdict,
      ruleVersion: old.ruleVersion,
      replacedAt: now(),
      replaceReason: '同一检测点重复报送，旧版读数留痕，以本次报送为最后一版，两版不叠加',
    }
    record = makeRecord(state, input, false, source)
    record.id = old.id
    record.history = [...old.history, snap]
    // 旧版挂着的待办按"点位已更新"作废（留痕），新待办等新判定后再挂。
    for (const todo of state.todos) {
      if (todo.recordId === record.id && todo.status === '待办') {
        todo.status = '已作废'
        todo.cancelReason = `检测点 ${record.pointCode} 重新报送（覆盖），旧版待办随旧读数作废`
        todo.closedAt = now()
      }
    }
    state.records[existingIndex] = record
  } else {
    record = makeRecord(state, input, false, source)
    state.records.push(record)
  }

  // 缺项：卡在①段，挂「缺项补测」待办（老记录/新报送同一套处理办法，见 rules.ts 处理说明）。
  if (record.status === '数据缺项') {
    state.todos.push(
      makeTodo(state, record, '缺项补测', `缺项：${record.missingFields.join('、')}；来源：${record.source}`),
    )
  }

  commitState(state)
  const tip = record.status === '数据缺项'
    ? `登记成功但判定必需项缺失，已卡在${STAGE_NAME[1]}并挂「缺项补测」，补齐回写后才能进入判定。`
    : `登记成功，当前在${STAGE_NAME[1]}，下一步进入${STAGE_NAME[2]}。`
  return { ok: true, message: tip, data: clone(record) }
}

/**
 * 第②段：合格判定。电阻按检测点分档、SPD并入同一条；阈值与上限只用登记当时生效的一版。
 * 判定结果冻结写入记录，换版不重算。
 */
export function judgeRecord(id: number): ServiceResult<LightningRecord> {
  const state = clone(loadState())
  const record = state.records.find((row) => row.id === id)
  if (!record) return reject(2, `找不到检测记录 #${id}。`)
  if (record.stage !== 1) {
    return reject(2, `该点已在${STAGE_NAME[record.stage]}，不能重复判定；要改读数请走重新报送覆盖。`)
  }
  if (record.status === '数据缺项') {
    return reject(2, `存在缺项（${record.missingFields.join('、')}），按处理说明须先补测回写，禁止带缺项判定。`)
  }

  const rule = ruleAtDate(record.inspectDate)
  const r = judgeResistance(record.resistance, record.overRange, record.cabinClass, rule)
  const spdBad = isSpdAbnormal(record.spdStatus)
  const spdText = spdBad ? `浪涌保护器「${record.spdStatus}」需更换；` : ''
  const finalVerdict = r.verdict === '合格' && !spdBad ? '合格' : '不合格'

  record.ruleVersion = rule.version
  record.verdict = finalVerdict
  record.verdictReason = `${r.reason}。${spdText}SPD按${record.spdStatus}登记。`
  record.judgedAt = now()
  record.stage = 2
  record.status = finalVerdict === '合格' ? '合格' : '不合格'
  record.conflictNote = buildConflictNote(record)
  const otherNote =
    rule.version !== CURRENT_RULE.version
      ? `（按检测日 ${record.inspectDate} 冻结适用 ${rule.version}；现行 ${CURRENT_RULE.version} 只影响新登记）`
      : ''
  record.traceVerdict = `${record.inspectDate} 检测，${rule.version} 判定：${finalVerdict}${otherNote}`

  commitState(state)
  const next = finalVerdict === '合格'
    ? `判定完成：合格，可直接${STAGE_NAME[4]}闭环，无需复测。`
    : `判定完成：不合格，下一步必须${STAGE_NAME[3]}挂出复测/更换，不能停在判定页。`
  return { ok: true, message: next, data: clone(record) }
}

/**
 * 第③段：挂出复测/处置。只对判定不合格或SPD异常的点开放；
 * 把「接地电阻复测」「浪涌保护器更换」原子写入设备台账保养计划待办。
 */
export function openRetest(id: number): ServiceResult<LightningRecord> {
  const state = clone(loadState())
  const record = state.records.find((row) => row.id === id)
  if (!record) return reject(3, `找不到检测记录 #${id}。`)
  if (record.stage < 2) {
    return reject(3, `该点还在${STAGE_NAME[record.stage]}，未完成判定，不许跨段直接挂复测。`)
  }
  if (record.stage >= 3 && record.status === '复测中') {
    return reject(3, `复测/处置待办已挂出，等待${STAGE_NAME[4]}回写，不要重复挂。`)
  }
  if (record.verdict !== '不合格') {
    return reject(3, `判定为合格的点不挂复测；如确有现场异常请重新报送。`)
  }

  const kinds: TodoKind[] = []
  if (record.verdict === '不合格') kinds.push('接地电阻复测')
  if (isSpdAbnormal(record.spdStatus)) kinds.push('浪涌保护器更换')
  const reasonMap: Record<TodoKind, string> = {
    接地电阻复测: `接地电阻不合格：${record.verdictReason}`,
    浪涌保护器更换: `浪涌保护器 ${record.spdCode || record.stake} 状态「${record.spdStatus}」，须更换`,
    缺项补测: '',
  }
  for (const kind of kinds) {
    // 幂等：同一点同一类已有待办不重复挂。
    const exists = state.todos.some(
      (todo) => todo.recordId === record.id && todo.kind === kind && todo.status === '待办',
    )
    if (!exists) state.todos.push(makeTodo(state, record, kind, reasonMap[kind]))
  }

  record.pendingKinds = kinds
  record.stage = 3
  record.status = '复测中'
  commitState(state)
  return {
    ok: true,
    message: `已挂出 ${kinds.join('、')}，并同步写入设备台账保养计划（${kinds.length} 条待办），请在第④段回写处置结论。`,
    data: clone(record),
  }
}

function closeTodosFor(record: LightningRecord, state: LightningState, conclusion: string): MaintenanceTodo[] {
  const closed: MaintenanceTodo[] = []
  for (const todo of state.todos) {
    if (todo.recordId === record.id && todo.status === '待办') {
      todo.status = '已闭环'
      todo.conclusion = conclusion
      todo.closedAt = now()
      closed.push(todo)
    }
  }
  return closed
}

/**
 * 第④段：复测结论回写。复测按现行 v2 重新判定：
 *  - 复测合格且SPD正常 → 闭环，对应保养计划待办同时闭环（原子双写）；
 *  - 复测仍不合格或SPD仍异常 → 待办继续挂着，台账仍停在第③段，写明卡点，不允许假闭环。
 */
export function writeRetestConclusion(id: number, input: RetestInput): ServiceResult<LightningRecord> {
  const state = clone(loadState())
  const record = state.records.find((row) => row.id === id)
  if (!record) return reject(4, `找不到检测记录 #${id}。`)
  if (record.stage < 3) {
    return reject(4, `该点还在${STAGE_NAME[record.stage]}，复测待办尚未挂出，不能提前回写结论。`)
  }
  if (!input.retestDate) {
    return reject(4, '复测日期必填，否则结论无法追溯。')
  }

  // 复测读数一律按现行版判定；缺读数且未声明仍不合格的，按仍不合格挂起。
  const r = judgeResistance(input.resistance, input.overRange, record.cabinClass, CURRENT_RULE)
  const spdBad = isSpdAbnormal(input.spdStatus)
  const resistanceOk = r.verdict === '合格'
  const pass = input.conclusion === '复测合格' && resistanceOk && !spdBad

  record.retestDate = input.retestDate
  record.retestLog.push({
    at: now(),
    retestDate: input.retestDate,
    resistance: input.resistance,
    overRange: input.overRange,
    spdStatus: input.spdStatus,
    conclusion: pass ? '复测合格' : '复测仍不合格',
    ruleVersion: CURRENT_RULE.version,
    note: input.note || r.reason,
  })

  if (pass) {
    const closed = closeTodosFor(record, state, `${input.retestDate} 复测合格：${r.reason}`)
    record.resistance = input.resistance
    record.overRange = input.overRange
    record.spdStatus = input.spdStatus
    record.verdict = '合格'
    record.verdictReason = `原判定不合格，${input.retestDate} 复测合格（${CURRENT_RULE.version}，冻结原判定留痕）：${r.reason}`
    record.pendingKinds = []
    record.stage = 4
    record.status = '已闭环'
    record.retestConclusion = '复测合格，已闭环'
    record.closedAt = now()
    commitState(state)
    return {
      ok: true,
      message: `复测合格，台账闭环，设备保养计划 ${closed.length} 条待办同步闭环。`,
      data: clone(record),
    }
  }

  // 仍不合格：电阻复测待办保持挂起；SPD仍异常则更换待办也保持；缺项类保持缺项。
  record.retestConclusion = '复测仍不合格，待办继续挂起'
  record.pendingKinds = openKindsOf(record)
  commitState(state)
  return reject(
    4,
    `复测仍不合格（${r.verdict === null ? r.reason : r.reason}${spdBad ? '；SPD仍为「' + input.spdStatus + '」' : ''}），不得闭环，设备保养计划待办继续挂着，限期复测。`,
  )
}

/** 缺项补测回写：补全第①段缺的读数，补测后回到待判定，由第②段重新判。 */
export function fillMissing(
  id: number,
  payload: { resistance: number; overRange: boolean; inspectDate: string; note: string },
): ServiceResult<LightningRecord> {
  const state = clone(loadState())
  const record = state.records.find((row) => row.id === id)
  if (!record) return reject(1, `找不到检测记录 #${id}。`)
  if (record.status !== '数据缺项') {
    return reject(1, '该点当前不是缺项状态，补测入口仅对缺项记录开放。')
  }
  if (!Number.isFinite(payload.resistance) || payload.resistance < 0) {
    return reject(1, '补测的接地电阻必须是不小于0的数。')
  }
  record.resistance = payload.resistance
  record.overRange = payload.overRange
  if (payload.inspectDate) record.inspectDate = payload.inspectDate
  record.missingFields = record.missingFields.filter((field) => field !== FIELD_LABEL.resistance)
  record.note += `｜补测(${today()})：${payload.note || '补齐接地电阻读数'}`
  if (record.missingFields.length === 0) {
    record.status = '待判定'
    record.stage = 1
    record.pendingKinds = []
    for (const todo of state.todos) {
      if (todo.recordId === record.id && todo.kind === '缺项补测' && todo.status === '待办') {
        todo.status = '已闭环'
        todo.conclusion = `${today()} 补测到位，缺项补齐`
        todo.closedAt = now()
      }
    }
  }
  commitState(state)
  return { ok: true, message: '缺项已补齐，缺项补测待办闭环，现进入②合格判定。', data: clone(record) }
}

function recordFromLegacy(state: LightningState, row: LegacyPaperRow): LightningRecord {
  const input: RegisterInput = {
    pointCode: row.pointCode,
    stake: row.stake,
    cabin: row.cabin,
    cabinClass: row.cabinClass,
    resistance: row.resistance,
    overRange: row.overRange,
    inspectDate: row.inspectDate,
    spdCode: row.spdCode,
    spdStatus: row.spdStatus,
    deviceCode: row.deviceCode,
    owner: row.owner,
    note: row.note,
  }
  const record = makeRecord(state, input, true, row.source)
  record.createdAt = `${row.inspectDate}T00:00:00.000Z`
  return record
}

/**
 * 存量回填（一次性）：上线前老记录按业务发生日整批补录。
 * 同点重复报送只认最后一版（旧版留痕）；每条按检测当时的规则版本判定并冻结；
 * 缺项单独标注来源、挂缺项补测；不合格自动挂出复测/更换待办。
 * 整批在一次原子提交里完成（台账+待办同时更新）。
 */
export function backfillLegacy(): ServiceResult<{ imported: number; replaced: number; todos: number }> {
  const state = clone(loadState())
  if (state.backfilled) {
    return reject(2, '存量老记录已按防雷检测日期回填过，该操作只允许一次，不能重复回填。')
  }

  let imported = 0
  let replaced = 0
  const byCode = new Map<string, number>()

  for (const row of LEGACY_PAPER) {
    const record = recordFromLegacy(state, row)
    const existingIdx = byCode.get(record.pointCode)
    if (existingIdx === undefined) {
      state.records.push(record)
      byCode.set(record.pointCode, state.records.length - 1)
      imported += 1
    } else {
      const old = state.records[existingIdx]
      record.id = old.id
      record.history = [
        ...old.history,
        {
          version: old.history.length + 1,
          resistance: old.resistance,
          overRange: old.overRange,
          inspectDate: old.inspectDate,
          spdStatus: old.spdStatus,
          verdict: old.verdict,
          ruleVersion: old.ruleVersion,
          replacedAt: now(),
          replaceReason: `老记录补录：同点重复报送，以${row.source}为最后一版，两版不叠加`,
        },
      ]
      state.records[existingIdx] = record
      replaced += 1
    }
  }

  // 按检测日期逐档回填判定（一次性），并同步挂待办——台账与保养计划同批落盘。
  for (const record of state.records.filter((row) => row.backfilled)) {
    if (record.status === '数据缺项') {
      state.todos.push(
        makeTodo(state, record, '缺项补测', `老记录缺项：${record.missingFields.join('、')}；来源：${record.source}`),
      )
      record.pendingKinds = ['缺项补测']
      continue
    }
    const rule = ruleAtDate(record.inspectDate)
    const r = judgeResistance(record.resistance, record.overRange, record.cabinClass, rule)
    const spdBad = isSpdAbnormal(record.spdStatus)
    const finalVerdict = r.verdict === '合格' && !spdBad ? '合格' : '不合格'
    record.ruleVersion = rule.version
    record.verdict = finalVerdict
    record.verdictReason = `[补录] ${r.reason}。SPD按${record.spdStatus}登记。`
    record.judgedAt = now()
    record.conflictNote = buildConflictNote(record)
    record.traceVerdict = `[补录] ${record.inspectDate} 检测，${rule.version} 判定：${finalVerdict}`

    if (finalVerdict === '合格') {
      record.stage = 4
      record.status = '已闭环'
      record.retestConclusion = '老记录合格，回填即闭环'
      record.closedAt = now()
    } else {
      record.stage = 3
      record.status = '复测中'
      const kinds = openKindsOf(record)
      record.pendingKinds = kinds
      const reasonMap: Record<TodoKind, string> = {
        接地电阻复测: `[补录] 接地电阻不合格：${r.reason}`,
        浪涌保护器更换: `[补录] SPD ${record.spdCode || record.stake} 状态「${record.spdStatus}」，须更换`,
        缺项补测: '',
      }
      for (const kind of kinds) state.todos.push(makeTodo(state, record, kind, reasonMap[kind]))
    }
  }

  state.backfilled = true
  state.backfilledAt = now()
  commitState(state)
  return {
    ok: true,
    message: `存量老记录已整批补录：新入账 ${imported} 点、覆盖重复报送 ${replaced} 版，判定与待办已按检测日期一次性回填并对账。`,
    data: { imported, replaced, todos: state.todos.length },
  }
}

/** 对账：台账侧挂起条数 必须等于 设备保养计划待办侧条数，且逐点种类一致。 */
export function reconcile(): ReconcileReport {
  const state = loadState()
  const details = state.records
    .map((record) => ({ pointCode: record.pointCode, kinds: openKindsOf(record) }))
    .filter((item) => item.kinds.length > 0)
  const ledgerOpenCount = details.reduce((sum, item) => sum + item.kinds.length, 0)
  const todoOpenCount = state.todos.filter((todo) => todo.status === '待办').length
  const awaitingOpenCount = state.records.filter(
    (record) => record.stage === 2 && record.verdict === '不合格',
  ).length
  const consistent = ledgerOpenCount === todoOpenCount
  return { ledgerOpenCount, todoOpenCount, awaitingOpenCount, consistent, details }
}

export function listRecords(): LightningRecord[] {
  return clone(loadState().records)
}

export function listTodos(status: '全部' | '待办' | '已闭环' | '已作废' = '全部'): MaintenanceTodo[] {
  const rows = clone(loadState().todos)
  return status === '全部' ? rows : rows.filter((todo) => todo.status === status)
}

export function stateSnapshot(): LightningState {
  return clone(loadState())
}

export { STAGE_NAME }

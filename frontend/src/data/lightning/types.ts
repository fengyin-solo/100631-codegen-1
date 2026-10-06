/**
 * 廊内防雷与接地检测台账 —— 领域模型。
 * 与通用 EntryRow 分开：这套台账有分段闸门、判定版本冻结、重复报送覆盖、
 * 与设备保养计划原子双写等硬规则，不套用通用模块的自由状态流转。
 */

/** 分档：判定阈值按检测点所属舱室的用电性质分两档，阈值全系统只有一套（见 rules.ts）。 */
export type CabinClass = '强电' | '弱电'

/** 浪涌保护器状态并入同一条接地检测记录，不再单开一本账。 */
export type SpdStatus = '正常' | '劣化' | '失效' | '未装'

export type Verdict = '合格' | '不合格'

/** 环节分段：①登记报送 → ②合格判定 → ③挂出复测/处置 → ④结论回写闭环。只能逐段往下走。 */
export type FlowStage = 1 | 2 | 3 | 4

export type RecordStatus = '待判定' | '数据缺项' | '合格' | '不合格' | '复测中' | '已闭环'

/** 同一点位重复报送时，被覆盖的旧版读数留痕，绝不与新版叠加。 */
export interface HistoryEntry {
  version: number
  resistance: number | null
  overRange: boolean
  inspectDate: string
  spdStatus: SpdStatus
  verdict: Verdict | null
  ruleVersion: string
  replacedAt: string
  replaceReason: string
}

/** 复测/处置的每次回写都留痕，复测仍不合格时待办继续挂着。 */
export interface RetestLogEntry {
  at: string
  retestDate: string
  resistance: number | null
  overRange: boolean
  spdStatus: SpdStatus
  conclusion: '复测合格' | '复测仍不合格'
  ruleVersion: string
  note: string
}

export interface LightningRecord {
  id: number
  /** 接地检测点编号，同编号重复报送只认最后一版（幂等键）。 */
  pointCode: string
  /** 桩号 */
  stake: string
  /** 所属舱室 */
  cabin: string
  cabinClass: CabinClass
  /** 接地电阻实测值 Ω；超上限或老记录缺项时允许为 null，由 overRange/missingFields 区分。 */
  resistance: number | null
  /** 实测值超出取值上限（含表计超量程）：值原样留痕，按超限判不合格。 */
  overRange: boolean
  /** 防雷检测日期（业务发生日），存量按这一天套用当时生效的判定版本。 */
  inspectDate: string
  /** 浪涌保护器（SPD）同栏登记 */
  spdCode: string
  spdStatus: SpdStatus
  /** 关联设备编号：回写设备台账保养计划时用。 */
  deviceCode: string
  owner: string

  stage: FlowStage
  status: RecordStatus
  /** 判定结论冻结值：一旦入账，换版不改判，沿用登记当时的取值。 */
  verdict: Verdict | null
  /** 冻结的判定规则版本，如 v1 / v2。 */
  ruleVersion: string
  verdictReason: string
  /** 新旧两版判定冲突时，以哪一版为准的说明；另一版结论只作留痕。 */
  conflictNote: string
  traceVerdict: string

  /** 当前挂起的处置事项种类，与设备保养计划待办逐条对应（对账用）。 */
  pendingKinds: TodoKind[]
  missingFields: string[]
  /** 数据来源，缺项/纸质补录在此单独标注。 */
  source: string
  backfilled: boolean

  retestDate: string
  retestConclusion: string
  retestLog: RetestLogEntry[]
  history: HistoryEntry[]

  createdAt: string
  judgedAt: string
  closedAt: string
  note: string
}

export type TodoKind = '接地电阻复测' | '浪涌保护器更换' | '缺项补测'
export type TodoStatus = '待办' | '已闭环' | '已作废'

/** 另一个入口的待办：设备台账「保养计划」。与检测台账同一次提交里双写。 */
export interface MaintenanceTodo {
  id: number
  recordId: number
  pointCode: string
  stake: string
  cabin: string
  deviceCode: string
  owner: string
  kind: TodoKind
  reason: string
  dueDate: string
  status: TodoStatus
  conclusion: string
  source: string
  createdAt: string
  closedAt: string
  cancelReason: string
}

export interface LightningState {
  records: LightningRecord[]
  todos: MaintenanceTodo[]
  /** 上线前老记录整批补录只允许一次。 */
  backfilled: boolean
  backfilledAt: string
  recordSeq: number
  todoSeq: number
}

export interface RegisterInput {
  pointCode: string
  stake: string
  cabin: string
  cabinClass: CabinClass
  resistance: number | null
  overRange: boolean
  inspectDate: string
  spdCode: string
  spdStatus: SpdStatus
  deviceCode: string
  owner: string
  note: string
}

export interface RetestInput {
  retestDate: string
  resistance: number | null
  overRange: boolean
  spdStatus: SpdStatus
  conclusion: '复测合格' | '复测仍不合格'
  note: string
}

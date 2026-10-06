<template>
  <section class="page lgt-page">
    <header class="page-head">
      <div>
        <h2>廊内防雷与接地检测台账</h2>
        <p class="page-desc">
          每个接地检测点登记桩号、所属舱室、接地电阻实测值与防雷检测日期；浪涌保护器（SPD）状态并入同一条记录。
          环节一段一段走，跨段一律打回；台账与设备保养计划待办原子双写、条数一致。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="resetAll">清空演示数据</button>
      </div>
    </header>

    <!-- 分段流水线：①登记报送 → ②合格判定 → ③挂出复测/处置 → ④结论回写 -->
    <ol class="stage-bar">
      <li v-for="s in stages" :key="s.no" class="stage-item" :class="{ cur: true }">
        <span class="stage-no">{{ ['①','②','③','④'][s.no - 1] }}</span>
        <span class="stage-name">{{ s.name }}</span>
        <span class="stage-tip">{{ s.tip }}</span>
      </li>
    </ol>

    <!-- 对账条：两边条数一致才显示绿色 -->
    <div class="reconcile-bar" :class="report.consistent ? 'ok' : 'bad'">
      <strong>台账 / 保养计划 对账：</strong>
      检测台账挂起 {{ report.ledgerOpenCount }} 条 ＝ 设备保养计划待办 {{ report.todoOpenCount }} 条
      <span class="reconcile-flag">{{ report.consistent ? '一致 ✓' : '不一致 ✗（禁止继续，请核对）' }}</span>
      <span v-if="report.awaitingOpenCount" class="awaiting">另有 {{ report.awaitingOpenCount }} 点已判不合格停在第②段，必须点「③挂复测/处置」，不得跳过</span>
      <button class="link" type="button" @click="refresh">重新对账</button>
    </div>

    <p v-if="feedback" class="feedback" :class="feedbackOk ? 'fb-ok' : 'fb-bad'">{{ feedback }}</p>

    <!-- 存量回填：一次性 -->
    <div class="backfill-card" v-if="!snapshot.backfilled">
      <div>
        <strong>上线前老记录整批补录</strong>
        <p class="page-desc">
          检测队记录纸共 {{ paperCount }} 行（含同点重复报送、缺项、超量程、SPD异常）。
          按业务发生日（防雷检测日期）整批补录并一次性套用当时判定版本；缺项保持空白、单独标注来源并挂「缺项补测」，不臆造读数。
          该操作只允许一次。
        </p>
      </div>
      <button class="btn primary" type="button" @click="doBackfill">按防雷检测日期整批补录（一次）</button>
    </div>
    <div class="backfill-card done" v-else>
      存量老记录已于 {{ formatTime(snapshot.backfilledAt) }} 整批补录并回填判定，重复报送只保留最后一版。
    </div>

    <div class="stat-row">
      <article class="stat-card"><span class="stat-label">检测点（末版口径）</span><strong class="stat-value">{{ records.length }}</strong></article>
      <article class="stat-card"><span class="stat-label">合格/闭环</span><strong class="stat-value">{{ countClosed }}</strong></article>
      <article class="stat-card"><span class="stat-label">待判定/缺项</span><strong class="stat-value">{{ countPending }}</strong></article>
      <article class="stat-card"><span class="stat-label">复测/处置中</span><strong class="stat-value">{{ countRetest }}</strong></article>
      <article class="stat-card"><span class="stat-label">挂起待办（两侧同源）</span><strong class="stat-value">{{ report.todoOpenCount }}</strong></article>
    </div>

    <!-- 登记 / 重新报送（同一检测点只认最后一版） -->
    <details class="form-card" :open="records.length === 0">
      <summary>登记检测报送（同检测点再次提交＝覆盖为最后一版，旧版留痕不叠加）</summary>
      <form class="reg-form" @submit.prevent="submitRegister">
        <label><span>检测点编号 *</span><input v-model="form.pointCode" placeholder="如 LGT-K1+200" /></label>
        <label><span>桩号 *</span><input v-model="form.stake" placeholder="如 K1+200" /></label>
        <label><span>所属舱室 *</span><input v-model="form.cabin" placeholder="如 电力舱A" /></label>
        <label><span>舱室分档 *</span>
          <select v-model="form.cabinClass"><option>强电</option><option>弱电</option></select>
        </label>
        <label><span>接地电阻实测值 Ω</span>
          <input v-model="form.resistanceText" :disabled="form.overRange" placeholder="读数；超量程勾选右侧" />
        </label>
        <label class="check"><input type="checkbox" v-model="form.overRange" @change="onOverRange" /> 超取值上限/{{ RESISTANCE_LIMIT }}Ω（表计超量程）</label>
        <label><span>防雷检测日期 *</span><input type="date" v-model="form.inspectDate" /></label>
        <label><span>SPD编号</span><input v-model="form.spdCode" placeholder="如 SPD-K1200" /></label>
        <label><span>浪涌保护器状态</span>
          <select v-model="form.spdStatus"><option>正常</option><option>劣化</option><option>失效</option><option>未装</option></select>
        </label>
        <label><span>关联设备编号</span><input v-model="form.deviceCode" placeholder="回写保养计划用，如 DEVI-LGT-01" /></label>
        <label><span>设备负责人</span><input v-model="form.owner" /></label>
        <label class="wide"><span>备注</span><input v-model="form.note" /></label>
        <div class="form-foot">
          <button class="btn primary" type="submit">提交登记报送（进入第①段）</button>
          <span class="page-desc">判定只在第②段进行；提交后不会自动判合格。</span>
        </div>
      </form>
    </details>

    <form class="filter-bar" @submit.prevent="refresh">
      <label class="filter-item"><span>关键字（桩号/舱室/编号）</span>
        <input v-model="filter.keyword" placeholder="检索" />
      </label>
      <label class="filter-item"><span>状态</span>
        <select v-model="filter.status">
          <option value="">全部</option>
          <option>待判定</option><option>数据缺项</option><option>合格</option>
          <option>不合格</option><option>复测中</option><option>已闭环</option>
        </select>
      </label>
      <label class="filter-item"><span>环节段</span>
        <select v-model="filter.stage">
          <option value="">全部</option><option value="1">①登记</option><option value="2">②判定</option>
          <option value="3">③处置</option><option value="4">④闭环</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
    </form>

    <table class="data-table lgt-table">
      <thead>
        <tr>
          <th>检测点/桩号</th><th>所属舱室(分档)</th><th>接地电阻Ω</th><th>检测日期</th>
          <th>SPD状态</th><th>判定(冻结版本)</th><th>环节/状态</th><th>挂起待办</th><th>来源/缺项</th><th>逐段操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in filtered" :key="row.id">
          <tr :class="{ missing: row.status === '数据缺项' }">
            <td>
              <button class="link" type="button" @click="toggle(row.id)">{{ row.pointCode }}</button>
              <div class="sub">{{ row.stake }}</div>
              <div class="sub" v-if="row.history.length">已覆盖 {{ row.history.length }} 版</div>
            </td>
            <td>{{ row.cabin }}<div class="sub">{{ row.cabinClass }}档</div></td>
            <td>
              <span v-if="row.resistance === null" class="warn">缺项</span>
              <span v-else :class="{ warn: row.overRange || row.verdict === '不合格' }">
                {{ row.resistance }}{{ row.overRange ? '（超限）' : '' }}
              </span>
            </td>
            <td>{{ row.inspectDate || '—' }}</td>
            <td :class="{ warn: spdBad(row.spdStatus) }">{{ row.spdStatus }}</td>
            <td>
              <span v-if="row.verdict">{{ row.verdict }}</span><span v-else>未判定</span>
              <div class="sub">{{ row.ruleVersion || '—' }}</div>
              <div class="sub" v-if="row.backfilled">补录</div>
            </td>
            <td>{{ stageLabel(row.stage) }}<div class="sub">{{ row.status }}</div></td>
            <td>
              <span v-for="k in row.pendingKinds" :key="k" class="tag">{{ k }}</span>
              <span v-if="!row.pendingKinds.length" class="sub">—</span>
            </td>
            <td class="src">{{ row.source }}<div class="sub" v-if="row.missingFields.length">缺：{{ row.missingFields.join('、') }}</div></td>
            <td class="row-actions vertical">
              <button class="link" type="button" @click="doJudge(row.id)" :disabled="row.stage !== 1 || row.status === '数据缺项'">②判定</button>
              <button class="link" type="button" @click="doOpenRetest(row.id)" :disabled="row.stage !== 2 || row.verdict !== '不合格'">③挂复测/处置</button>
              <button class="link" type="button" @click="openRetestForm(row.id)" :disabled="row.stage !== 3">④回写结论</button>
              <button class="link" type="button" @click="openFillForm(row.id)" :disabled="row.status !== '数据缺项'">①补测缺项</button>
            </td>
          </tr>
          <tr v-if="expanded === row.id" class="detail-row">
            <td colspan="10">
              <div class="detail-grid">
                <div><b>判定依据：</b>{{ row.verdictReason || '尚未判定' }}</div>
                <div v-if="row.conflictNote"><b>版本冲突准据：</b>{{ row.conflictNote }}</div>
                <div><b>留痕：</b>{{ row.traceVerdict || '—' }}</div>
                <div><b>复测结论：</b>{{ row.retestConclusion || '暂无' }}</div>
                <div><b>关联设备：</b>{{ row.deviceCode || '—' }}（负责人 {{ row.owner || '—' }}）</div>
              </div>
              <table class="hist-table" v-if="row.history.length || row.retestLog.length">
                <thead>
                  <tr><th>时间</th><th>类型</th><th>电阻Ω</th><th>日期</th><th>SPD</th><th>当时结论/版本</th><th>说明</th></tr>
                </thead>
                <tbody>
                  <tr v-for="h in row.history" :key="'h' + h.version">
                    <td>{{ formatTime(h.replacedAt) }}</td><td>被覆盖旧版 v{{ h.version }}</td>
                    <td>{{ h.resistance === null ? '缺项' : h.resistance }}{{ h.overRange ? '（超限）' : '' }}</td>
                    <td>{{ h.inspectDate }}</td><td>{{ h.spdStatus }}</td>
                    <td>{{ h.verdict || '—' }} / {{ h.ruleVersion || '—' }}</td>
                    <td>{{ h.replaceReason }}</td>
                  </tr>
                  <tr v-for="(l, i) in row.retestLog" :key="'r' + i">
                    <td>{{ formatTime(l.at) }}</td><td>{{ l.conclusion }}</td>
                    <td>{{ l.resistance === null ? '缺项' : l.resistance }}{{ l.overRange ? '（超限）' : '' }}</td>
                    <td>{{ l.retestDate }}</td><td>{{ l.spdStatus }}</td>
                    <td>按 {{ l.ruleVersion }}</td><td>{{ l.note }}</td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </template>
        <tr v-if="!filtered.length">
          <td colspan="10" class="empty-state">暂无检测记录，请先整批补录老记录或登记新报送。</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>判定阈值唯一一套：强电舱 ≤4Ω、弱电舱 ≤10Ω；接地电阻取值上限 {{ RESISTANCE_LIMIT }}Ω（超量程照超限判不合格）。规则版本可换，已入账结论冻结不重算。</span>
    </footer>

    <!-- 第④段：复测结论回写 -->
    <div v-if="retestForm" class="modal-mask" @click.self="retestForm = null">
      <div class="modal">
        <h3>回写复测/处置结论（第④段）· {{ retestForm.pointCode }}</h3>
        <p class="page-desc">复测读数按现行 {{ CURRENT_RULE.version }} 判定。任一项不达标都不能闭环，保养计划待办继续挂着。</p>
        <label class="m-label"><span>复测日期 *</span><input type="date" v-model="retestForm.retestDate" /></label>
        <label class="m-label"><span>复测电阻 Ω</span><input v-model="retestForm.resistanceText" :disabled="retestForm.overRange" /></label>
        <label class="m-label check"><input type="checkbox" v-model="retestForm.overRange" /> 超量程</label>
        <label class="m-label"><span>SPD处置后状态</span>
          <select v-model="retestForm.spdStatus"><option>正常</option><option>劣化</option><option>失效</option><option>未装</option></select>
        </label>
        <label class="m-label"><span>复测结论</span>
          <select v-model="retestForm.conclusion"><option>复测合格</option><option>复测仍不合格</option></select>
        </label>
        <label class="m-label"><span>处置说明</span><input v-model="retestForm.note" /></label>
        <div class="modal-actions">
          <button class="btn" type="button" @click="retestForm = null">取消</button>
          <button class="btn primary" type="button" @click="submitRetest">回写并同步保养计划</button>
        </div>
      </div>
    </div>

    <!-- 缺项补测 -->
    <div v-if="fillForm" class="modal-mask" @click.self="fillForm = null">
      <div class="modal">
        <h3>缺项补测（第①段补齐）· {{ fillForm.pointCode }}</h3>
        <label class="m-label"><span>补测接地电阻 Ω *</span><input v-model="fillForm.resistanceText" :disabled="fillForm.overRange" /></label>
        <label class="m-label check"><input type="checkbox" v-model="fillForm.overRange" /> 超量程</label>
        <label class="m-label"><span>检测日期</span><input type="date" v-model="fillForm.inspectDate" /></label>
        <label class="m-label"><span>说明</span><input v-model="fillForm.note" /></label>
        <div class="modal-actions">
          <button class="btn" type="button" @click="fillForm = null">取消</button>
          <button class="btn primary" type="button" @click="submitFill">补齐回写</button>
        </div>
      </div>
    </div>

    <!-- 处理说明 -->
    <details class="form-card">
      <summary>处理说明：阈值版本、取值上限、缺项处理、冲突准据、分段与双写口径</summary>
      <ul class="notes">
        <li>判定阈值与取值范围全系统收敛成一套：强电舱接地电阻 ≤4Ω，弱电（含综合）舱 ≤10Ω；取值上限唯一 {{ RESISTANCE_LIMIT }}Ω。超过上限（含表计超量程）原值留痕，照超限判不合格并挂复测，不拿上限值替代真实读数。</li>
        <li>SPD（浪涌保护器）状态并入同一条检测记录：正常不另挂待办；劣化/失效/未装 判需更换，挂「浪涌保护器更换」并写入设备保养计划。</li>
        <li>同一检测点重复报送只认最后一版：以检测点编号为幂等键，旧版读数进入版本留痕，两次读数绝不叠加成一条；旧版未闭环待办随覆盖作废，新待办按新判定重挂。</li>
        <li>规则换版只影响新登记：已入账记录冻结登记当时的规则版本与结论，不重算、不翻案。存量检测点按防雷检测日期回填一次（一次性按钮）。新旧两版冲突时以登记当时生效版本为准，另一版仅留痕（见每条记录的"版本冲突准据"）。</li>
        <li>缺项处理办法：一律不臆造、不填默认值；缺"接地电阻实测值/防雷检测日期"等判定必需项即判「数据缺项」，卡在第①段不予判定，自动挂「缺项补测」到设备保养计划，补测回写后才放行。纸质老记录缺项单独标注纸面来源。</li>
        <li>分段闸门：①登记报送 → ②合格判定 → ③挂出复测/处置 → ④结论回写，只能逐段推进；任何跨段操作打回，并提示卡在哪一段。</li>
        <li>台账与设备保养计划待办在同一次提交内原子双写；顶部对账条实时核对，两侧挂起条数必须一致，不一致即停止后续操作。处置结论回写后两侧对应项同时闭环。</li>
      </ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import { LEGACY_PAPER } from '@/data/lightning/legacy-paper'
import {
  CURRENT_RULE,
  RESISTANCE_LIMIT,
  isSpdAbnormal,
} from '@/data/lightning/rules'
import { resetState } from '@/data/lightning/lightning-store'
import {
  stateSnapshot,
  STAGE_NAME,
  backfillLegacy,
  fillMissing,
  judgeRecord,
  listRecords,
  openRetest,
  reconcile,
  registerInspection,
  writeRetestConclusion,
  type ReconcileReport,
  type ServiceResult,
} from '@/data/lightning/lightning-service'
import type { CabinClass, LightningRecord, SpdStatus } from '@/data/lightning/types'

const stages = [
  { no: 1 as const, name: '登记报送', tip: '桩号/舱室/电阻/日期/SPD' },
  { no: 2 as const, name: '合格判定', tip: '按分档+登记当时版本' },
  { no: 3 as const, name: '复测/处置', tip: '写入保养计划待办' },
  { no: 4 as const, name: '结论回写', tip: '两侧同步闭环' },
]

const records = ref<LightningRecord[]>([])
const snapshot = ref(stateSnapshot())
const report = ref<ReconcileReport>({ ledgerOpenCount: 0, todoOpenCount: 0, awaitingOpenCount: 0, consistent: true, details: [] })
const feedback = ref('')
const feedbackOk = ref(true)
const expanded = ref<number | null>(null)
const paperCount = LEGACY_PAPER.length

const filter = reactive({ keyword: '', status: '', stage: '' })

function emptyForm() {
  return {
    pointCode: '', stake: '', cabin: '', cabinClass: '强电' as CabinClass,
    resistanceText: '', overRange: false, inspectDate: '',
    spdCode: '', spdStatus: '正常' as SpdStatus,
    deviceCode: '', owner: '', note: '',
  }
}
const form = reactive(emptyForm())

const retestForm = ref<{
  id: number; pointCode: string; retestDate: string; resistanceText: string;
  overRange: boolean; spdStatus: SpdStatus; conclusion: '复测合格' | '复测仍不合格'; note: string
} | null>(null)

const fillForm = ref<{
  id: number; pointCode: string; resistanceText: string; overRange: boolean;
  inspectDate: string; note: string
} | null>(null)

const filtered = computed(() => {
  const kw = filter.keyword.trim()
  return records.value.filter((row) => {
    if (filter.status && row.status !== filter.status) return false
    if (filter.stage && row.stage !== Number(filter.stage)) return false
    if (kw) {
      const blob = `${row.pointCode} ${row.stake} ${row.cabin} ${row.deviceCode}`
      if (!blob.includes(kw)) return false
    }
    return true
  })
})

const countClosed = computed(() => records.value.filter((r) => r.status === '已闭环' || r.status === '合格').length)
const countPending = computed(() => records.value.filter((r) => r.status === '待判定' || r.status === '数据缺项').length)
const countRetest = computed(() => records.value.filter((r) => r.status === '复测中' || r.status === '不合格').length)

function spdBad(s: SpdStatus) { return isSpdAbnormal(s) }
function stageLabel(s: number) { return STAGE_NAME[(s as 1 | 2 | 3 | 4)] }
function formatTime(iso: string) { return iso ? iso.replace('T', ' ').slice(0, 16) : '—' }
function toggle(id: number) { expanded.value = expanded.value === id ? null : id }

function showResult<T>(res: ServiceResult<T>) {
  feedbackOk.value = res.ok
  feedback.value = res.message
  refresh()
}

function refresh() {
  records.value = listRecords()
  snapshot.value = stateSnapshot()
  report.value = reconcile()
}

function onOverRange() {
  if (form.overRange) form.resistanceText = ''
}

function parseResistance(text: string, overRange: boolean): number | null {
  if (overRange) return RESISTANCE_LIMIT
  if (text.trim() === '') return null
  const n = Number(text)
  return Number.isFinite(n) ? n : NaN
}

function submitRegister() {
  const resistance = parseResistance(form.resistanceText, form.overRange)
  const res = registerInspection({
    pointCode: form.pointCode, stake: form.stake, cabin: form.cabin, cabinClass: form.cabinClass,
    resistance: Number.isNaN(resistance) ? null : resistance,
    overRange: form.overRange, inspectDate: form.inspectDate,
    spdCode: form.spdCode, spdStatus: form.spdStatus,
    deviceCode: form.deviceCode, owner: form.owner, note: form.note,
  })
  if (res.ok) Object.assign(form, emptyForm())
  showResult(res)
}

function doJudge(id: number) { showResult(judgeRecord(id)) }
function doOpenRetest(id: number) { showResult(openRetest(id)) }

function doBackfill() { showResult(backfillLegacy()) }

function openRetestForm(id: number) {
  const row = records.value.find((r) => r.id === id)
  if (!row) return
  retestForm.value = {
    id, pointCode: row.pointCode, retestDate: '', resistanceText: '',
    overRange: false, spdStatus: row.spdStatus === '正常' ? '正常' : '正常',
    conclusion: '复测合格', note: '',
  }
}

function submitRetest() {
  if (!retestForm.value) return
  const f = retestForm.value
  const resistance = parseResistance(f.resistanceText, f.overRange)
  const res = writeRetestConclusion(f.id, {
    retestDate: f.retestDate,
    resistance: Number.isNaN(resistance) ? null : resistance,
    overRange: f.overRange, spdStatus: f.spdStatus,
    conclusion: f.conclusion, note: f.note,
  })
  if (res.ok) retestForm.value = null
  showResult(res)
}

function openFillForm(id: number) {
  const row = records.value.find((r) => r.id === id)
  if (!row) return
  fillForm.value = { id, pointCode: row.pointCode, resistanceText: '', overRange: false, inspectDate: row.inspectDate, note: '' }
}

function submitFill() {
  if (!fillForm.value) return
  const f = fillForm.value
  const n = Number(f.resistanceText)
  const res = fillMissing(f.id, {
    resistance: Number.isFinite(n) ? n : NaN,
    overRange: f.overRange, inspectDate: f.inspectDate, note: f.note,
  })
  if (res.ok) fillForm.value = null
  showResult(res)
}

function resetAll() {
  resetState()
  feedback.value = '已清空防雷台账演示数据，可重新整批补录。'
  feedbackOk.value = true
  refresh()
}

refresh()
</script>

<style scoped>
.lgt-page { max-width: 1500px; }
.stage-bar { display: flex; gap: 0; list-style: none; padding: 0; margin: 0 0 12px; counter-reset: s; }
.stage-item { flex: 1; background: #fff; border: 1px solid var(--border); border-left: 4px solid var(--brand); border-radius: 6px; padding: 8px 12px; margin-right: 8px; }
.stage-no { font-weight: 700; color: var(--brand); margin-right: 6px; }
.stage-name { font-weight: 600; font-size: 13px; }
.stage-tip { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
.reconcile-bar { border-radius: 6px; padding: 8px 12px; font-size: 13px; margin-bottom: 10px; }
.reconcile-bar.ok { background: #ecfdf3; border: 1px solid #75e0a7; color: #067647; }
.reconcile-bar.bad { background: #fef3f2; border: 1px solid #fda29b; color: #b42318; }
.reconcile-flag { font-weight: 700; margin: 0 8px; }
.awaiting { background: #fff1e8; border: 1px solid #f5a978; color: #b93815; border-radius: 999px; padding: 1px 10px; margin-right: 8px; }
.feedback { padding: 8px 12px; border-radius: 6px; font-size: 13px; margin: 6px 0; white-space: pre-wrap; }
.fb-ok { background: #ecfdf3; border: 1px solid #75e0a7; color: #067647; }
.fb-bad { background: #fef3f2; border: 1px solid #fda29b; color: #b42318; }
.backfill-card { display: flex; justify-content: space-between; align-items: center; gap: 16px; background: #fff8eb; border: 1px solid #f2d39b; border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
.backfill-card.done { background: #eef4ff; border-color: #a4c2f4; }
.form-card { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
.form-card summary { cursor: pointer; font-weight: 600; }
.reg-form { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 14px; margin-top: 12px; }
.reg-form label span, .m-label span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
.reg-form input, .reg-form select, .m-label input, .m-label select { width: 100%; padding: 5px 8px; border: 1px solid var(--border); border-radius: 5px; }
.reg-form .wide { grid-column: span 3; }
.reg-form .check, .m-label.check { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.reg-form .check input, .m-label.check input { width: auto; }
.form-foot { grid-column: span 4; display: flex; align-items: center; gap: 14px; }
.lgt-table .sub { color: var(--muted); font-size: 12px; }
.lgt-table .warn { color: #b42318; font-weight: 700; }
.lgt-table tr.missing { background: #fff8eb; }
.row-actions.vertical { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.row-actions button:disabled { color: #aab4c2; cursor: not-allowed; }
.tag { display: inline-block; background: #fef3c7; border: 1px solid #f2d39b; border-radius: 999px; padding: 1px 8px; font-size: 12px; margin: 1px 2px 1px 0; }
.src { font-size: 12px; max-width: 200px; }
.detail-row td { background: #f8fafc; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; font-size: 13px; margin-bottom: 8px; }
.hist-table { width: 100%; font-size: 12px; }
.hist-table th, .hist-table td { border: 1px solid var(--border); padding: 4px 8px; }
.modal-mask { position: fixed; inset: 0; background: rgba(16, 24, 40, 0.45); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { background: #fff; border-radius: 10px; padding: 20px; width: 520px; max-width: 92vw; }
.m-label { display: block; margin-bottom: 10px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }
.notes { font-size: 13px; line-height: 1.9; color: #334155; margin: 10px 0 0; padding-left: 18px; }
</style>

<template>
  <section class="page" data-module="device">
    <header class="page-head">
      <div>
        <h2>设备台账管理管理</h2>
        <p class="page-desc">维护管廊设备，围绕设备编号、设备名称、设备型号、所属舱室做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记管廊设备</button>
        <button class="btn" type="button" @click="exportRows">导出设备台账管理清单</button>
      </div>
    </header>

    <!-- 防雷接地检测台账回写进来的保养计划：另一个入口，与检测台账同源、条数一致 -->
    <div class="plan-card">
      <div class="plan-head">
        <div>
          <strong>保养计划待办 · 廊内防雷与接地检测回写</strong>
          <p class="page-desc">
            判定不合格的接地检测点在检测侧挂出复测后，待办原子回写到本清单，设备负责人在此即可看到并回写处置结论；两侧条数实时对账，禁止各算各的。
          </p>
        </div>
        <div class="plan-side">
          <span class="plan-count" :class="{ bad: !report.consistent }">待办 {{ report.todoOpenCount }} ＝ 台账挂起 {{ report.ledgerOpenCount }}</span>
          <RouterLink class="btn" to="/lightning">前往检测台账</RouterLink>
          <button class="btn ghost" type="button" @click="reloadPlan">刷新对账</button>
        </div>
      </div>
      <p v-if="!report.consistent" class="plan-bad">两侧条数不一致，已停止后续操作，请回检测台账核对。</p>
      <p v-if="report.awaitingOpenCount" class="plan-warn">另有 {{ report.awaitingOpenCount }} 个检测点已判不合格但尚未在检测台账挂出复测，请通知检测人员完成第③段，待办才会回写到本清单。</p>

      <div class="plan-tabs">
        <button v-for="t in tabs" :key="t" class="tab" :class="{ on: todoTab === t }" type="button" @click="todoTab = t">
          {{ t }}（{{ countOf(t) }}）
        </button>
      </div>

      <table class="data-table plan-table">
        <thead>
          <tr>
            <th>设备编号</th><th>检测点/桩号</th><th>所属舱室</th><th>负责人</th>
            <th>待办事项</th><th>挂起原因</th><th>期限</th><th>来源</th><th>状态/结论</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="todo in shownTodos" :key="todo.id">
            <td>{{ todo.deviceCode || '—' }}</td>
            <td>{{ todo.pointCode }}<div class="sub">{{ todo.stake }}</div></td>
            <td>{{ todo.cabin }}</td>
            <td>{{ todo.owner || '—' }}</td>
            <td><span class="tag">{{ todo.kind }}</span></td>
            <td class="reason">{{ todo.reason }}</td>
            <td>{{ todo.dueDate || '—' }}</td>
            <td class="sub">{{ todo.source }}</td>
            <td>
              {{ todo.status }}
              <div class="sub" v-if="todo.conclusion">{{ todo.conclusion }}</div>
              <div class="sub" v-if="todo.cancelReason">作废：{{ todo.cancelReason }}</div>
            </td>
            <td class="row-actions">
              <button
                v-if="todo.kind === '缺项补测' && todo.status === '待办'"
                class="link" type="button" @click="openFill(todo)"
              >回写补测</button>
              <button
                v-else-if="todo.status === '待办'"
                class="link" type="button" @click="openConclusion(todo)"
              >回写处置结论</button>
              <RouterLink v-else class="link" to="/lightning">查看台账</RouterLink>
            </td>
          </tr>
          <tr v-if="!shownTodos.length">
            <td colspan="10" class="empty-state">暂无保养计划待办。检测台账判定不合格的点会在这里出现。</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无设备台账管理数据，可先登记管廊设备</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条设备台账管理记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 处置结论回写：第④段，同样受分段闸门约束，与台账原子双写 -->
    <div v-if="conclusionTarget" class="modal-mask" @click.self="conclusionTarget = null">
      <div class="modal">
        <h3>回写处置结论 · {{ conclusionTarget.pointCode }}（{{ conclusionTarget.kind }}）</h3>
        <p class="page-desc">回写会同时更新检测台账与本保养计划（原子双写）。复测不达标不能闭环，待办继续挂着。</p>
        <label class="m-label"><span>复测日期 *</span><input type="date" v-model="conclusion.retestDate" /></label>
        <label class="m-label"><span>复测接地电阻 Ω</span><input v-model="conclusion.resistanceText" :disabled="conclusion.overRange" /></label>
        <label class="m-label check"><input type="checkbox" v-model="conclusion.overRange" /> 超量程（超{{ RESISTANCE_LIMIT }}Ω）</label>
        <label class="m-label"><span>SPD处置后状态</span>
          <select v-model="conclusion.spdStatus"><option>正常</option><option>劣化</option><option>失效</option><option>未装</option></select>
        </label>
        <label class="m-label"><span>复测结论</span>
          <select v-model="conclusion.conclusion"><option>复测合格</option><option>复测仍不合格</option></select>
        </label>
        <label class="m-label"><span>处置说明</span><input v-model="conclusion.note" /></label>
        <p v-if="planFeedback" class="error-text">{{ planFeedback }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="conclusionTarget = null">取消</button>
          <button class="btn primary" type="button" @click="submitConclusion">回写并同步两侧</button>
        </div>
      </div>
    </div>

    <!-- 缺项补测回写 -->
    <div v-if="fillTarget" class="modal-mask" @click.self="fillTarget = null">
      <div class="modal">
        <h3>缺项补测 · {{ fillTarget.pointCode }}</h3>
        <label class="m-label"><span>补测接地电阻 Ω *</span><input v-model="fillData.resistanceText" :disabled="fillData.overRange" /></label>
        <label class="m-label check"><input type="checkbox" v-model="fillData.overRange" /> 超量程</label>
        <label class="m-label"><span>检测日期</span><input type="date" v-model="fillData.inspectDate" /></label>
        <label class="m-label"><span>说明</span><input v-model="fillData.note" /></label>
        <p v-if="planFeedback" class="error-text">{{ planFeedback }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="fillTarget = null">取消</button>
          <button class="btn primary" type="button" @click="submitFill">补齐回写</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import {
  fillMissing,
  listTodos,
  reconcile,
  writeRetestConclusion,
  type ReconcileReport,
} from '@/data/lightning/lightning-service'
import type { MaintenanceTodo, SpdStatus } from '@/data/lightning/types'
import { RESISTANCE_LIMIT } from '@/data/lightning/rules'

const meta = moduleMeta('device')
const columns = ["设备编号", "设备名称", "设备型号", "所属舱室", "投运日期", "保养周期", "上次保养日", "设备状态"]
const actions = ["登记运行", "完成保养", "报废设备"]
const statuses = ["待保养", "运行中", "已保养", "已报废"]
const statsConfig = [
  { label: "运行中设备", match: "运行中" },
  { label: "待保养设备", match: "待保养" },
  { label: "已报废设备", match: "已报废" },
]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const stats = ref<{ label: string; value: number }[]>(statsConfig.map((item) => ({ label: item.label, value: 0 })))
watch(rows, (next) => {
  stats.value = statsConfig.map((item) => ({
    label: item.label,
    value: next.filter((row) => String(row.status) === item.match).length,
  }))
}, { immediate: true })
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// —— 防雷接地回写的保养计划 ——
const todos = ref<MaintenanceTodo[]>([])
const report = ref<ReconcileReport>({ ledgerOpenCount: 0, todoOpenCount: 0, awaitingOpenCount: 0, consistent: true, details: [] })
const todoTab = ref<'全部' | '待办' | '已闭环' | '已作废'>('待办')
const tabs = ['待办', '已闭环', '已作废', '全部'] as const
const planFeedback = ref('')

const shownTodos = computed(() =>
  todoTab.value === '全部' ? todos.value : todos.value.filter((t) => t.status === todoTab.value),
)
function countOf(t: string) {
  return t === '全部' ? todos.value.length : todos.value.filter((x) => x.status === t).length
}

const conclusionTarget = ref<MaintenanceTodo | null>(null)
const conclusion = reactive({
  retestDate: '', resistanceText: '', overRange: false,
  spdStatus: '正常' as SpdStatus, conclusion: '复测合格' as '复测合格' | '复测仍不合格', note: '',
})
const fillTarget = ref<MaintenanceTodo | null>(null)
const fillData = reactive({ resistanceText: '', overRange: false, inspectDate: '', note: '' })

function openConclusion(todo: MaintenanceTodo) {
  planFeedback.value = ''
  conclusionTarget.value = todo
  Object.assign(conclusion, {
    retestDate: '', resistanceText: '', overRange: false,
    spdStatus: '正常', conclusion: '复测合格', note: '',
  })
}

function submitConclusion() {
  if (!conclusionTarget.value) return
  const target = conclusionTarget.value
  const n = Number(conclusion.resistanceText)
  const res = writeRetestConclusion(target.recordId, {
    retestDate: conclusion.retestDate,
    resistance: !conclusion.overRange && conclusion.resistanceText.trim() === ''
      ? null
      : (conclusion.overRange ? RESISTANCE_LIMIT : n),
    overRange: conclusion.overRange,
    spdStatus: conclusion.spdStatus,
    conclusion: conclusion.conclusion,
    note: conclusion.note,
  })
  planFeedback.value = res.ok ? '' : res.message
  if (res.ok) {
    conclusionTarget.value = null
    reloadPlan()
  }
}

function openFill(todo: MaintenanceTodo) {
  planFeedback.value = ''
  fillTarget.value = todo
  Object.assign(fillData, { resistanceText: '', overRange: false, inspectDate: '', note: '' })
}

function submitFill() {
  if (!fillTarget.value) return
  const n = Number(fillData.resistanceText)
  const res = fillMissing(fillTarget.value.recordId, {
    resistance: Number.isFinite(n) ? n : NaN,
    overRange: fillData.overRange,
    inspectDate: fillData.inspectDate,
    note: fillData.note,
  })
  planFeedback.value = res.ok ? '' : res.message
  if (res.ok) {
    fillTarget.value = null
    reloadPlan()
  }
}

function reloadPlan() {
  todos.value = listTodos('全部')
  report.value = reconcile()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '管廊设备登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '设备台账管理列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadPlan()
})
</script>

<style scoped>
.plan-card { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; }
.plan-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.plan-side { display: flex; align-items: center; gap: 10px; white-space: nowrap; }
.plan-count { background: #eef4ff; border: 1px solid #a4c2f4; color: #1f4fb0; border-radius: 999px; padding: 4px 12px; font-size: 13px; font-weight: 600; }
.plan-count.bad { background: #fef3f2; border-color: #fda29b; color: #b42318; }
.plan-bad { color: #b42318; font-size: 13px; margin: 8px 0; }
.plan-warn { color: #b93815; background: #fff1e8; border: 1px solid #f5a978; border-radius: 6px; padding: 6px 10px; font-size: 13px; margin: 8px 0; }
.plan-tabs { display: flex; gap: 6px; margin: 10px 0; }
.tab { border: 1px solid var(--border); background: #f6f8fb; border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 13px; }
.tab.on { background: var(--brand); color: #fff; border-color: var(--brand); }
.plan-table .sub { color: var(--muted); font-size: 12px; }
.plan-table .reason { max-width: 260px; font-size: 12px; }
.tag { display: inline-block; background: #fef3c7; border: 1px solid #f2d39b; border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.modal-mask { position: fixed; inset: 0; background: rgba(16, 24, 40, 0.45); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { background: #fff; border-radius: 10px; padding: 20px; width: 480px; max-width: 92vw; }
.m-label { display: block; margin-bottom: 10px; }
.m-label span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
.m-label input, .m-label select { width: 100%; padding: 5px 8px; border: 1px solid var(--border); border-radius: 5px; }
.m-label.check { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.m-label.check input { width: auto; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }
</style>

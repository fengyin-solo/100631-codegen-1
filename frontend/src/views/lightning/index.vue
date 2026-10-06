<template>
  <section class="page" data-module="lightning">
    <header class="page-head">
      <div>
        <h2>廊内防雷接地检测</h2>
        <p class="page-desc">
          接地检测点台账：登记桩号、所属舱室、接地电阻实测值与防雷检测日期，浪涌保护器状态并入同一条记录；
          判定规则与取值上限只有一套，重复报送只认最后一版。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showForm = !showForm">
          {{ showForm ? '收起登记' : '登记/重报检测点' }}
        </button>
        <button class="btn" type="button" @click="runBackfill">整批补录老记录</button>
        <button class="btn" type="button" @click="exportRows">导出台账清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="consistency" :class="{ broken: !consistency.consistent }">
      复测待办台账侧 {{ consistency.ledgerOpenRetest }} 条 · 设备台账保养计划侧 {{ consistency.deviceOpenTodo }} 条 ·
      {{ consistency.consistent ? '两边条数一致' : '两边条数不一致，请检查联动' }}
    </p>

    <details class="rule-notes">
      <summary>判定规则与处理说明（唯一一套，点开查看）</summary>
      <ul>
        <li v-for="rule in ruleVersions" :key="rule.version">
          {{ rule.version }}（{{ rule.effectiveFrom }} 起{{ rule.effectiveTo ? `至 ${rule.effectiveTo}` : '，现行' }}）：
          Ⅰ档 ≤ {{ rule.gradeLimits['Ⅰ档'] }}Ω，Ⅱ档 ≤ {{ rule.gradeLimits['Ⅱ档'] }}Ω，取值上限 {{ rule.hardLimit }}Ω，超出上限一律判超限。
        </li>
        <li>浪涌保护器劣化、失效直接判不合格；状态缺失按缺项处理。</li>
        <li>同一检测点重复报送只认最后一版，旧版进留痕，两次读数不叠加。</li>
        <li>新旧两版判定冲突时以登记时适用的版本为准，另一版只作留痕。</li>
        <li>缺项处理：不估数、不沿用邻点；实测值缺失记「缺测」并挂复测，浪涌保护器状态缺失记「未登记」随复测补登，来源统一标注「检测队纸质记录补录」。</li>
        <li>环节只能一段一段推进：待判定 → 已判定 → 合格归档 / 挂出复测 → 复测中 → 已闭环，跨环节操作一律打回。</li>
      </ul>
    </details>

    <form v-if="showForm" class="create-form" @submit.prevent="submitForm">
      <label class="filter-item">
        <span>检测点编号</span>
        <input v-model="form.检测点编号" placeholder="如 LP-0005" />
      </label>
      <label class="filter-item">
        <span>桩号</span>
        <input v-model="form.桩号" placeholder="如 K1+300" />
      </label>
      <label class="filter-item">
        <span>所属舱室</span>
        <input v-model="form.所属舱室" placeholder="如 电力舱" />
      </label>
      <label class="filter-item">
        <span>检测点分档</span>
        <select v-model="form.检测点分档">
          <option value="Ⅰ档">Ⅰ档（引下线/接地干线）</option>
          <option value="Ⅱ档">Ⅱ档（设备与浪涌保护器接地）</option>
        </select>
      </label>
      <label class="filter-item">
        <span>接地电阻实测值（Ω）</span>
        <input v-model="form.接地电阻实测值" placeholder="如 0.9" />
      </label>
      <label class="filter-item">
        <span>防雷检测日期</span>
        <input v-model="form.防雷检测日期" type="date" />
      </label>
      <label class="filter-item">
        <span>浪涌保护器状态</span>
        <select v-model="form.浪涌保护器状态">
          <option v-for="state in spdStates" :key="state" :value="state">{{ state }}</option>
        </select>
      </label>
      <button class="btn primary" type="submit">报送登记</button>
      <span class="form-hint">同一检测点编号重复报送只认最后一版，旧版自动留痕</span>
    </form>

    <div v-if="backfillLines.length" class="backfill-result">
      <strong>补录结果</strong>
      <ul>
        <li v-for="(line, index) in backfillLines" :key="index">{{ line }}</li>
      </ul>
    </div>

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
          <th>报送版本</th>
          <th>留痕</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>第{{ row['报送版本'] ?? 1 }}版</td>
          <td>
            <button v-if="traceCount(row) > 0" class="link" type="button" @click="selectRow(row)">
              {{ traceCount(row) }} 条
            </button>
            <span v-else>—</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in rowActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="selectRow(row)">详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无接地检测点，可先登记或整批补录老记录</td>
        </tr>
      </tbody>
    </table>

    <aside v-if="selected" class="detail-panel">
      <header class="detail-head">
        <strong>检测点 {{ selected['检测点编号'] }}（{{ selected['桩号'] }} · {{ selected['所属舱室'] }}）</strong>
        <button class="link" type="button" @click="selected = null">收起</button>
      </header>
      <p v-if="selected['判定说明']">判定说明：{{ selected['判定说明'] }}</p>
      <p v-if="selected['留痕结论']" class="trace-note">版本冲突留痕：{{ selected['留痕结论'] }}</p>
      <p v-if="selected['缺项说明']" class="trace-note">缺项说明：{{ selected['缺项说明'] }}</p>
      <p v-if="selected['补录来源']">补录来源：{{ selected['补录来源'] }}（批次 {{ selected['补录批次'] }}）</p>
      <p>复测次数：{{ selected['复测次数'] ?? 0 }}</p>
      <div v-if="traceOfSelected.length">
        <strong>历史版本留痕（只读，不参与判定）</strong>
        <table class="data-table">
          <thead>
            <tr><th>留痕时间</th><th>来源</th><th>报送版本</th><th>实测值</th><th>检测日期</th><th>浪涌保护器</th><th>判定版本</th><th>当时结论</th></tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in traceOfSelected" :key="index">
              <td>{{ item['留痕时间'] }}</td>
              <td>{{ item['来源'] }}</td>
              <td>第{{ item['报送版本'] }}版</td>
              <td>{{ item['接地电阻实测值'] }}</td>
              <td>{{ item['防雷检测日期'] }}</td>
              <td>{{ item['浪涌保护器状态'] }}</td>
              <td>{{ item['判定标准版本'] }}</td>
              <td>{{ item['判定结论'] }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <form v-if="String(selected.status) === '复测中'" class="create-form" @submit.prevent="submitRetest">
        <label class="filter-item">
          <span>复测实测值（Ω）</span>
          <input v-model="retestForm.reading" placeholder="如 0.9" />
        </label>
        <label class="filter-item">
          <span>复测日期</span>
          <input v-model="retestForm.date" type="date" />
        </label>
        <label class="filter-item">
          <span>浪涌保护器状态</span>
          <select v-model="retestForm.spd">
            <option v-for="state in spdStates" :key="state" :value="state">{{ state }}</option>
          </select>
        </label>
        <button class="btn primary" type="submit">登记复测结论</button>
        <span class="form-hint">结论同步回写设备台账保养计划，两边同时更新</span>
      </form>
    </aside>

    <footer class="page-foot">
      <span>共 {{ total }} 条接地检测点记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries } from '@/api/local-service'
import {
  archiveQualified,
  backfillLegacyRows,
  closeRetest,
  lightningTrace,
  lightningTraceCount,
  openRetest,
  submitJudgement,
  submitReading,
  todoConsistency,
} from '@/api/lightning-service'
import { RULE_VERSIONS, SPD_STATES } from '@/data/lightning-rules'
import type { EntryRow } from '@/data/types'

const columns = ["检测点编号", "桩号", "所属舱室", "检测点分档", "接地电阻实测值", "防雷检测日期", "浪涌保护器状态", "判定标准版本", "判定结论"]
const filterFields = columns.slice(0, 3)
const ruleVersions = RULE_VERSIONS
const spdStates = SPD_STATES

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const showForm = ref(false)
const backfillLines = ref<string[]>([])
const selected = ref<EntryRow | null>(null)
const consistency = ref(todoConsistency())

const emptyForm = {
  检测点编号: '',
  桩号: '',
  所属舱室: '',
  检测点分档: 'Ⅰ档',
  接地电阻实测值: '',
  防雷检测日期: '',
  浪涌保护器状态: '正常',
}
const form = ref({ ...emptyForm })
const retestForm = ref({ reading: '', date: new Date().toISOString().slice(0, 10), spd: '正常' })

const stats = computed(() => [
  { label: '检测点总数', value: rows.value.length },
  { label: '判定合格', value: rows.value.filter((row) => row['判定结论'] === '合格').length },
  { label: '复测中', value: rows.value.filter((row) => row.status === '复测中').length },
  { label: '超限检测点', value: rows.value.filter((row) => row['判定结论'] === '超限').length },
])

const traceOfSelected = computed(() => (selected.value ? lightningTrace(selected.value) : []))

function traceCount(row: EntryRow): number {
  return lightningTraceCount(row)
}

// 按环节给出当前可执行的动作，跨环节的操作在服务端一样会被打回。
function rowActions(row: EntryRow): string[] {
  const status = String(row.status)
  if (status === '待判定') return ['提交判定']
  if (status === '已判定') {
    return row['判定结论'] === '合格' ? ['合格归档'] : ['挂出复测']
  }
  if (status === '复测中') return ['登记复测结论']
  return []
}

function runAction(action: string, row: EntryRow) {
  message.value = ''
  let result
  if (action === '提交判定') {
    result = submitJudgement(Number(row.id))
  } else if (action === '合格归档') {
    result = archiveQualified(Number(row.id))
  } else if (action === '挂出复测') {
    result = openRetest(Number(row.id))
  } else if (action === '登记复测结论') {
    selectRow(row)
    return
  } else {
    return
  }
  messageOk.value = result.ok
  message.value = result.message
  reload()
}

function selectRow(row: EntryRow) {
  selected.value = row
  retestForm.value = { reading: '', date: new Date().toISOString().slice(0, 10), spd: String(row['浪涌保护器状态'] ?? '正常') }
}

function submitForm() {
  message.value = ''
  const result = submitReading(form.value)
  messageOk.value = result.ok
  message.value = result.message
  if (result.ok) {
    form.value = { ...emptyForm }
    showForm.value = false
  }
  reload()
}

function submitRetest() {
  if (!selected.value) return
  message.value = ''
  const result = closeRetest(Number(selected.value.id), retestForm.value.reading, retestForm.value.date, retestForm.value.spd)
  messageOk.value = result.ok
  message.value = result.message
  reload()
  if (result.ok) {
    selected.value = null
  }
}

function runBackfill() {
  message.value = ''
  const result = backfillLegacyRows()
  messageOk.value = result.ok
  message.value = result.message
  backfillLines.value = result.lines
  reload()
}

function exportRows() {
  downloadEntries('lightning')
}

function resetFilters() {
  filters.value = {}
  reload()
}

function reload() {
  try {
    const payload = listEntries('lightning', filters.value)
    rows.value = payload.items
    total.value = payload.total
    consistency.value = todoConsistency()
    if (selected.value) {
      selected.value = payload.items.find((row) => row.id === selected.value?.id) ?? null
    }
  } catch (error) {
    messageOk.value = false
    message.value = error instanceof Error ? error.message : '防雷接地检测台账读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.page-actions {
  display: flex;
  gap: 8px;
}
.consistency {
  background: #e8f5e9;
  border: 1px solid #a5d6a7;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
}
.consistency.broken {
  background: #fdecea;
  border-color: #f5c6c0;
  color: #b42318;
}
.rule-notes {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--muted);
}
.rule-notes ul {
  margin: 8px 0 4px;
  padding-left: 18px;
}
.create-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.form-hint {
  font-size: 12px;
  color: var(--muted);
}
.backfill-result {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  font-size: 12px;
}
.detail-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-top: 12px;
  font-size: 13px;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.trace-note {
  color: #b42318;
}
.ok-text {
  color: #067647;
}
</style>

import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 测绘控制点废弃后，结论要落到安全巡查台账；两个模块的 key 和动作名先记在这里。
const SURVEY_KEY = 'survey'
const SAFETY_KEY = 'safety'
const SURVEY_DEPRECATE_ACTION = '登记废弃'
const SAFETY_DEPRECATE_CATEGORY = '控制点废弃'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 测绘控制点只能顺次推进：待布设 → 可使用 → 待校核 → 已废弃；已废弃是终点，不许倒着回。
  if (key === SURVEY_KEY) {
    const order = meta.statuses
    const lastStatus = order[order.length - 1]
    if (current === lastStatus) {
      return { ok: false, message: `${meta.entity}已是「${lastStatus}」，状态只能顺次推进，不能倒着回` }
    }
    const expected = order[order.indexOf(current) + 1]
    if (target !== expected) {
      return {
        ok: false,
        message: `${meta.entity}只能顺次推进（${order.join(' → ')}），当前「${current}」不能直接到「${target}」`,
      }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  if (key === SURVEY_KEY && action === SURVEY_DEPRECATE_ACTION) {
    recordSurveyDeprecate(updated)
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 控制点废弃的结论落进安全巡查台账：同一个点位只记一次，重复废弃不新增记录。
// 只登记结论，控制等级等历史字段沿用点位原值，不在这次废弃里重判。
function recordSurveyDeprecate(point: EntryRow): void {
  const pointNo = String(point['点位编号'] ?? point.id)
  const rows = listRows(SAFETY_KEY)
  const recorded = rows.some(
    (row) =>
      String(row['巡查类别']) === SAFETY_DEPRECATE_CATEGORY && String(row['巡查区域']) === pointNo,
  )
  if (recorded) {
    return
  }
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const conclusion: EntryRow = {
    id,
    status: '已上报',
    pending: false,
    abnormal: false,
    巡查编号: `SAFE-${String(id).padStart(4, '0')}`,
    巡查区域: pointNo,
    巡查类别: SAFETY_DEPRECATE_CATEGORY,
    隐患描述: `测绘控制点 ${pointNo} 已登记废弃，现场停止使用`,
    整改措施: `点位 ${pointNo} 废弃结论已落台账，后续测量不得再引用该点`,
    巡查人: '值班管理员',
    巡查日期: new Date().toISOString().slice(0, 10),
    巡查状态: '已上报',
  }
  saveRows(SAFETY_KEY, [...rows, conclusion])
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 清单和台账走同一条读取路径，两处看到的点位编号和条数完全一致。
  for (const row of listEntries(key).items) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

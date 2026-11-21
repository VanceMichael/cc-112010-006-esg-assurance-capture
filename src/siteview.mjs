import { replacedBy, withdrawalState } from './review.mjs'

// 资料来路标识：常规 / 披露时已存在但本次漏取（补录）/ 基准日后新增
function provenance(store, publishedAt, firstSeen, asOfMs) {
  if (asOfMs != null && publishedAt && Date.parse(publishedAt) > asOfMs) return '后来新增'
  const runIndex = store.runs.findIndex(run => run.at === firstSeen)
  const previous = runIndex > 0 ? store.runs[runIndex - 1] : null
  if (previous && publishedAt && Date.parse(publishedAt) < Date.parse(previous.at)) return '披露时已存在但本次漏取'
  return '常规'
}

const link = (store, path, anchor) => `${store.origin}${path}${anchor ? `#${anchor}` : ''}`

// 评审员查一个场址：企业声明、机构覆盖、尚未领齐的来源位置分列，均可点回来源
export function siteView(store, siteId, asOfMs = null) {
  const now = Date.parse(store.runs.at(-1)?.at ?? new Date().toISOString())
  const replaced = replacedBy(store, Number.MAX_SAFE_INTEGER)

  const identity = (store.assets?.list ?? []).filter(a => a.site === siteId)

  const claims = []
  for (const [id, doc] of Object.entries(store.docs)) {
    if (doc.kind !== 'report') continue
    for (const [anchor, section] of Object.entries(doc.anchors)) {
      if (section.site !== siteId) continue
      const ref = `${id}#${anchor}`
      claims.push({
        ref, owner: section.company, metric: section.metric, unit: section.unit,
        value: section.value, text: section.text,
        publishedAt: doc.publishedAt, firstSeen: doc.firstSeen,
        status: replaced.has(ref) ? `已被 ${replaced.get(ref).target} 取代（${replaced.get(ref).notice}）` : '现行',
        provenance: provenance(store, doc.publishedAt, doc.firstSeen, asOfMs),
        visibleAtBaseline: asOfMs == null || (doc.publishedAt && Date.parse(doc.publishedAt) <= asOfMs),
        url: link(store, doc.url, anchor)
      })
    }
  }

  const coverage = []
  for (const [id, assurance] of Object.entries(store.assurance)) {
    for (const section of assurance.sections ?? []) {
      if (section.site !== siteId) continue
      const state = withdrawalState(store, id, section, now)
      coverage.push({
        ref: `${id}#${section.anchor}`, owner: section.owner, period: section.period,
        metric: section.metric, text: section.text,
        issuedAt: assurance.issuedAt, firstSeen: assurance.firstSeen,
        status: state.state === 'withdrawn' ? `已撤回（${state.effective} 生效，${state.notice}）`
          : state.state === 'notice-pending' ? `撤回预告未领齐（${state.notice}）` : '有效',
        provenance: provenance(store, assurance.issuedAt, assurance.firstSeen, asOfMs),
        visibleAtBaseline: asOfMs == null || (assurance.issuedAt && Date.parse(assurance.issuedAt) <= asOfMs),
        url: link(store, assurance.url, section.anchor)
      })
    }
  }

  // 尚未领齐：撤回预告的正式文件位置、更正公告延用但领不回的正文位置
  const pending = []
  for (const notice of Object.values(store.notices)) {
    if (notice.formal) continue
    const target = store.assurance[notice.withdraws]
    const involves = !target || (target.sections ?? []).some(s => s.site === siteId)
    if (involves) {
      pending.push({
        kind: '撤回预告未领齐', ref: notice.id, withdraws: notice.withdraws,
        noticeAt: notice.noticeAt, url: link(store, notice.url)
      })
    }
  }
  for (const gap of store.gaps) {
    if (gap.resolvedAt) continue
    const docId = gap.target?.split('#')[0]
    const involves = Object.values(store.docs[docId]?.anchors ?? {}).some(a => a.site === siteId) ||
      Object.values(store.docs[gap.edge?.old]?.anchors ?? {}).some(a => a.site === siteId)
    if (involves) {
      pending.push({
        kind: '延用内容缺口', ref: gap.target, notice: gap.notice,
        firstSeen: gap.firstSeen, url: store.docs[docId]?.url ? link(store, store.docs[docId].url, gap.target.split('#')[1]) : null
      })
    }
  }

  return { site: siteId, identity, claims, coverage, pending }
}

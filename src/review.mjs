// 按评审基准日求值：全部判断只依据“来源标明的发布时间 <= 基准日”的文书。
// 本次首次取得时间只用于标识漏取补录，不用于基准日可见性——早已发布但漏采的文件可补齐该日候选。

export function parseBaseline(input) {
  if (typeof input === 'number') return input
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return Date.parse(`${input}T23:59:59.999+08:00`)
  const ms = Date.parse(input)
  if (Number.isNaN(ms)) throw new Error(`无法解析评审基准日：${input}`)
  return ms
}

// 披露文书族：更正公告把新旧披露编号连成一族（如 D1 ↔ D2）
export function docFamilies(store) {
  const parent = new Map()
  const find = x => {
    if (!parent.has(x)) parent.set(x, x)
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)
    let node = x
    while (parent.get(node) !== node) {
      const next = parent.get(node)
      parent.set(node, root)
      node = next
    }
    return root
  }
  for (const correction of Object.values(store.corrections)) {
    for (const edge of correction.edges) {
      const a = find(edge.old), b = find(edge.targetDoc)
      if (a !== b) parent.set(a, b)
    }
  }
  const familyOf = id => {
    const root = find(id)
    return new Set([...parent.keys()].filter(k => find(k) === root).concat([root, id]))
  }
  return { find, familyOf }
}

// 基准日可见的“替换”关系：旧锚点 → 新锚点
export function replacedBy(store, asOfMs) {
  const replaced = new Map()
  for (const [noticeId, correction] of Object.entries(store.corrections)) {
    if (!correction.publishedAt || Date.parse(correction.publishedAt) > asOfMs) continue
    for (const edge of correction.edges) {
      if (edge.action !== 'replace') continue
      replaced.set(`${edge.old}#${edge.anchor}`, {
        target: `${edge.targetDoc}#${edge.targetAnchor}`, notice: noticeId, at: correction.publishedAt
      })
    }
  }
  return replaced
}

function effectiveYears(store) {
  const { familyOf } = docFamilies(store)
  const years = {}
  for (const [id, doc] of Object.entries(store.docs)) {
    if (doc.year) { years[id] = doc.year; continue }
    for (const member of familyOf(id)) {
      if (store.docs[member]?.year) { years[id] = store.docs[member].year; break }
    }
    years[id] ??= null
  }
  return years
}

// 基准日时的现行逐段披露数字：被替换的锚点退出，延用的锚点保留；合计段没有场址，天然进不了场址口径
export function currentFigures(store, asOfMs) {
  const replaced = replacedBy(store, asOfMs)
  const years = effectiveYears(store)
  const figures = []
  for (const [id, doc] of Object.entries(store.docs)) {
    if (doc.kind !== 'report') continue
    if (!doc.publishedAt || Date.parse(doc.publishedAt) > asOfMs) continue
    for (const [anchor, section] of Object.entries(doc.anchors)) {
      const ref = `${id}#${anchor}`
      if (replaced.has(ref)) continue
      figures.push({
        ref, docId: id, anchor,
        site: section.site, owner: section.company, metric: section.metric,
        unit: section.unit, value: section.value, text: section.text,
        year: years[id] ?? null, publishedAt: doc.publishedAt
      })
    }
  }
  return figures
}

// 正式撤回只覆盖其写明的期间/条目/场址；未写明的字段不限制，其余明确覆盖的部分继续可用
function scopeMatches(scope, section) {
  return ['site', 'owner', 'period', 'metric'].every(key =>
    scope[key] == null || String(scope[key]) === String(section[key]))
}

// 某份机构文件对某段的覆盖在基准日的状态：有效 / 已撤回（生效日<=基准日）/ 预告未领齐
export function withdrawalState(store, assuranceId, section, asOfMs) {
  let pending = null
  for (const notice of Object.values(store.notices)) {
    if (notice.withdraws !== assuranceId) continue
    if (notice.formal) {
      for (const scope of notice.formal.scopes) {
        if (scope.effective && Date.parse(scope.effective) <= asOfMs && scopeMatches(scope, section)) {
          return { state: 'withdrawn', effective: scope.effective, notice: notice.id }
        }
      }
    } else if (notice.noticeAt && Date.parse(notice.noticeAt) <= asOfMs) {
      pending = notice
    }
  }
  if (pending) return { state: 'notice-pending', notice: pending.id, noticeAt: pending.noticeAt }
  return { state: 'active' }
}

function unresolvedGaps(store, asOfMs) {
  return store.gaps.filter(gap => {
    if (gap.resolvedAt) return false
    const notice = store.corrections[gap.notice]
    return !notice?.publishedAt || Date.parse(notice.publishedAt) <= asOfMs
  })
}

export const STATUS = { met: '满足', unmet: '不满足', pending: '证据待齐', hold: '送回核对' }

// 单条采购门槛在基准日的求值
export function evaluateRequirement(store, requirement, asOfMs) {
  const gaps = unresolvedGaps(store, asOfMs)
  const figures = currentFigures(store, asOfMs).filter(figure =>
    figure.site === requirement.site &&
    figure.owner === requirement.owner &&
    figure.metric === requirement.metric &&
    (requirement.year == null || figure.year == null || Number(figure.year) === Number(requirement.year)))
  figures.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
  const figure = figures[0] ?? null
  const result = {
    requirement, status: 'pending', reasons: [], figure,
    figures: figures.length > 1 ? figures : undefined, assurance: null, gaps: []
  }

  // 延用内容领不回：缺口留给评审员，不按旧内容放行
  const figureGap = figure ? gaps.find(gap => gap.target === figure.ref) : null
  const relatedGaps = gaps.filter(gap => {
    const targetDoc = store.docs[gap.target?.split('#')[0]]
    const oldDoc = store.docs[gap.edge?.old]
    return [targetDoc, oldDoc].some(doc => doc && Object.values(doc.anchors ?? {})
      .some(a => a.site === requirement.site && a.company === requirement.owner))
  })
  result.gaps = relatedGaps

  if (!figure) {
    result.reasons.push('基准日前指定来源没有该场址+组织范围+指标口径的现行披露数字（合计与同名场址不可替代）')
    return result
  }
  if (figureGap) {
    result.reasons.push(`更正公告${figureGap.notice}延用的 ${figureGap.target} 本次领不回，缺口留待评审员核对`)
    return result
  }
  if (figure.value == null) {
    result.reasons.push('披露段未取到数值')
    return result
  }

  // 机构覆盖：范围逐项对齐（组织/场址/期间/口径），部分范围鉴证不能按报告整体已审验处理
  const active = [], noticed = [], withdrawn = []
  if (requirement.assurance) {
    const { familyOf } = docFamilies(store)
    const family = familyOf(figure.docId)
    for (const [id, assurance] of Object.entries(store.assurance)) {
      if (!assurance.issuedAt || Date.parse(assurance.issuedAt) > asOfMs) continue
      for (const section of assurance.sections ?? []) {
        if (section.site === requirement.site && section.owner === requirement.owner &&
            String(section.period) === String(requirement.year) && section.metric === requirement.metric &&
            (!section.disclosure || family.has(section.disclosure))) {
          const candidate = { id, section, issuedAt: assurance.issuedAt, url: assurance.url }
          const state = withdrawalState(store, id, section, asOfMs)
          if (state.state === 'withdrawn') withdrawn.push({ ...candidate, ...state })
          else if (state.state === 'notice-pending') noticed.push({ ...candidate, ...state })
          else active.push(candidate)
        }
      }
    }
  }
  result.withdrawn = withdrawn.length ? withdrawn : undefined

  if (requirement.atMost != null && figure.value > requirement.atMost) {
    result.status = 'unmet'
    result.reasons.push(`现行披露 ${figure.value}${figure.unit ?? ''} 超过门槛 ${requirement.atMost}${requirement.unit ?? ''}`)
    return result
  }
  if (noticed.length && !active.length) {
    // 撤回预告涉及的范围尚未领齐：依赖该证明的门槛送回核对，暂停发新结论
    result.status = 'hold'
    result.hold = noticed.map(n => ({ assurance: n.id, notice: n.notice, noticeAt: n.noticeAt }))
    result.reasons.push(`依赖的鉴证 ${noticed.map(n => n.id).join('、')} 有撤回预告且正式文件未领齐`)
    return result
  }
  if (requirement.assurance && !active.length) {
    result.reasons.push(withdrawn.length
      ? `鉴证 ${withdrawn.map(w => `${w.id}（${w.effective} 起撤回）`).join('、')} 在基准日前已失效`
      : '基准日前没有覆盖该范围的鉴证文件')
    return result
  }
  result.status = 'met'
  result.assurance = active[0] ?? null
  result.evidence = [figure.ref, ...(result.assurance ? [`${result.assurance.id}#${result.assurance.section.anchor}`] : [])]
  return result
}

export function reviewAll(store, asOfMs) {
  const requirements = store.requirements?.list ?? []
  return requirements.map(requirement => evaluateRequirement(store, requirement, asOfMs))
}

// 决定作出之后发生的更正：用于决定书“需要复核的变化”
export function correctionChanges(store, ref, sinceMs) {
  const changes = []
  for (const [noticeId, correction] of Object.entries(store.corrections)) {
    if (!correction.publishedAt || Date.parse(correction.publishedAt) <= sinceMs) continue
    for (const edge of correction.edges) {
      if (`${edge.old}#${edge.anchor}` !== ref) continue
      if (edge.action === 'replace') {
        const target = store.docs[edge.targetDoc]?.anchors?.[edge.targetAnchor]
        changes.push({
          type: 'replaced', notice: noticeId, at: correction.publishedAt,
          target: `${edge.targetDoc}#${edge.targetAnchor}`,
          targetSummary: target ? { metric: target.metric, unit: target.unit, value: target.value, text: target.text } : null
        })
      } else {
        changes.push({ type: 'carried', notice: noticeId, at: correction.publishedAt })
      }
    }
  }
  return changes
}

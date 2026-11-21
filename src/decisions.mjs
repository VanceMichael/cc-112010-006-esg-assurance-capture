import { evaluateRequirement, correctionChanges, withdrawalState } from './review.mjs'

// 发出采购结论：全部门槛在基准时点“满足”才允许；证据内容随决定冻结
export function issueDecision(store, criteriaIds, on) {
  const asOfMs = Date.parse(on)
  const requirements = store.requirements?.list ?? []
  const evals = criteriaIds.map(id => {
    const requirement = requirements.find(r => r.id === id)
    return requirement
      ? { id, requirement, result: evaluateRequirement(store, requirement, asOfMs) }
      : { id, error: '采购门槛不存在' }
  })
  if (evals.some(e => e.error || e.result.status !== 'met')) return { ok: false, evals }

  const evidence = []
  for (const { result } of evals) {
    const figure = result.figure
    const figureDoc = store.docs[figure.docId]
    evidence.push({
      ref: figure.ref, kind: 'disclosure', url: figureDoc?.url,
      digest: figureDoc?.digest ?? null,
      summary: { site: figure.site, owner: figure.owner, metric: figure.metric, unit: figure.unit, value: figure.value, text: figure.text },
      publishedAt: figure.publishedAt, retrievedAt: figureDoc?.firstSeen ?? null
    })
    if (result.assurance) {
      const { id, section } = result.assurance
      const assurance = store.assurance[id]
      evidence.push({
        ref: `${id}#${section.anchor}`, kind: 'assurance', url: assurance?.url,
        digest: assurance?.digest ?? null,
        summary: { owner: section.owner, site: section.site, period: section.period, metric: section.metric, text: section.text },
        publishedAt: assurance?.issuedAt ?? null, retrievedAt: assurance?.firstSeen ?? null
      })
    }
  }
  const id = `L${Object.keys(store.localDecisions).length + 1}`
  const decision = { id, criteria: criteriaIds, on, evidence, verdict: 'issued' }
  store.localDecisions[id] = decision
  return { ok: true, decision }
}

// 打开决定书：当时实际采用的证据 + 之后发生、需要复核的变化。
// 后来的更正、鉴证延期、撤回或范围收缩不反改当时的决定；但“按现有依据能否再发同样决定”必须如实给出。
export function decisionView(store, id, nowMs) {
  const local = store.localDecisions[id]
  const fromSource = store.issued[id]
  if (!local && !fromSource) return null
  const on = local?.on ?? fromSource.on
  const criteria = local?.criteria ?? fromSource.criteria ?? []
  const refs = local ? local.evidence.map(e => e.ref) : fromSource.sourceRefs
  const frozen = ref => local?.evidence?.find(e => e.ref === ref) ?? null
  const onMs = Date.parse(on)
  const now = nowMs ?? Date.parse(store.runs.at(-1)?.at ?? on)

  const evidence = refs.map(ref => describeEvidence(store, ref, frozen(ref), onMs))
  const reevaluation = criteria.map(cid => {
    const requirement = store.requirements?.list.find(r => r.id === cid)
    if (!requirement) return { id: cid, status: 'unknown' }
    const result = evaluateRequirement(store, requirement, now)
    return { id: cid, status: result.status, reasons: result.reasons }
  })
  return {
    id, on, criteria, origin: local ? 'local' : 'source',
    evidence, reevaluation,
    canReissue: reevaluation.every(r => r.status === 'met'),
    note: '原决定维持不变；以上变化仅提示复核，不反改当时结论'
  }
}

function describeEvidence(store, ref, frozen, decisionOnMs) {
  const [docId, anchor] = ref.split('#')
  if (store.docs[docId]) {
    const doc = store.docs[docId]
    const current = doc.anchors?.[anchor] ?? null
    return {
      ref, kind: 'disclosure', url: doc.url,
      frozen: frozen?.summary ?? (current ? { metric: current.metric, unit: current.unit, value: current.value, text: current.text } : null),
      publishedAt: doc.publishedAt, retrievedAt: doc.firstSeen,
      changes: correctionChanges(store, ref, decisionOnMs)
    }
  }
  if (store.assurance[docId]) {
    const assurance = store.assurance[docId]
    const section = assurance.sections?.find(s => s.anchor === anchor) ?? null
    const changes = []
    if (section) {
      const final = withdrawalState(store, docId, section, Number.MAX_SAFE_INTEGER)
      if (final.state === 'withdrawn') changes.push({ type: 'withdrawn', effective: final.effective, notice: final.notice })
      if (final.state === 'notice-pending') changes.push({ type: 'notice-pending', notice: final.notice, noticeAt: final.noticeAt })
    }
    return {
      ref, kind: 'assurance', url: assurance.url,
      frozen: frozen?.summary ?? (section ? { owner: section.owner, site: section.site, period: section.period, metric: section.metric, text: section.text } : null),
      publishedAt: assurance.issuedAt, retrievedAt: assurance.firstSeen,
      changes
    }
  }
  return { ref, kind: 'unknown', frozen: frozen?.summary ?? null, changes: [{ type: 'missing', note: '证据不在库中，无法核对' }] }
}

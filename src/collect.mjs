import { createHash } from 'node:crypto'
import {
  parseExchangeCatalog, parseDocPage, parseVerifierCatalog, parseAssurancePage,
  docRefFromHref, lastNumber
} from './parse.mjs'

const digestOf = text => createHash('sha256').update(text).digest('hex')

// 一轮披露证据采集。now 由调用方给出（测试可固定），来源标明的时间与首次取得时间分开记录。
// 索引里不再列出某文件不等于它已撤回：库中已有条目只增不删，撤回只能凭机构正式文件认定。
export async function collect(origin, store, { now, fetchImpl = fetch } = {}) {
  const run = { id: store.runs.length + 1, at: now, step: null, found: { docs: [], assurance: [], notices: [] }, failures: [] }
  store.origin = origin

  const get = async path => {
    try {
      const res = await fetchImpl(new URL(path, origin), { signal: AbortSignal.timeout(5000) })
      return { status: res.status, text: res.status === 204 ? '' : await res.text() }
    } catch (error) {
      return { status: 0, text: '', error: String(error) }
    }
  }

  const ready = await get('/ready')
  if (ready.status === 200) run.step = JSON.parse(ready.text).step

  const rememberDoc = (id, patch) => {
    const existing = store.docs[id]
    const doc = {
      kind: 'report', title: null, year: null, url: null, publishedAt: null, publishedAtSource: null,
      anchors: {}, claims: [], history: [], ...existing, ...patch, id
    }
    if (existing?.digest && patch.digest && existing.digest !== patch.digest) {
      doc.history = [...(existing.history ?? []), { digest: existing.digest, replacedAt: now }]
    }
    doc.firstSeen = existing?.firstSeen ?? now
    doc.lastSeen = now
    store.docs[id] = doc
    if (!run.found.docs.includes(id)) run.found.docs.push(id)
    return doc
  }

  const fetchDoc = async (id, path, meta = {}) => {
    const res = await get(path)
    if (res.status !== 200) {
      run.failures.push({ url: path, status: res.status })
      return null
    }
    const parsed = parseDocPage(res.text)
    const anchors = {}
    for (const s of parsed.sections) {
      anchors[s.anchor] = {
        company: s.company, site: s.site, metric: s.metric, unit: s.unit,
        value: lastNumber(s.text), text: s.text
      }
    }
    const doc = rememberDoc(id, {
      kind: parsed.edges.length ? 'correction' : 'report',
      url: path,
      digest: digestOf(res.text),
      anchors, claims: parsed.claims,
      ...(meta.publishedAt && !store.docs[id]?.publishedAt
        ? { publishedAt: meta.publishedAt, publishedAtSource: meta.publishedAtSource ?? null } : {}),
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.year ? { year: meta.year } : {})
    })
    return { doc, parsed }
  }

  // —— 交易所目录：按披露编号追领正文与更正公告 ——
  const exchange = await get('/exchange')
  if (exchange.status !== 200) {
    run.failures.push({ url: '/exchange', status: exchange.status })
  } else {
    for (const entry of parseExchangeCatalog(exchange.text)) {
      const year = entry.title?.match(/(\d{4})/)?.[1] ?? null
      const got = await fetchDoc(entry.id, docRefFromHref(entry.href).path,
        { publishedAt: entry.publishedAt, publishedAtSource: '/exchange', title: entry.title, year })
      if (!got) continue
      if (!got.parsed.edges.length) continue
      // 更正公告：沿公告明确“替换 / 延用”的正文定位领取证据
      const edges = []
      for (const edge of got.parsed.edges) {
        const target = docRefFromHref(edge.href)
        const record = {
          old: edge.old, anchor: edge.anchor, action: edge.action,
          targetDoc: target.id, targetAnchor: target.anchor, retrieved: false
        }
        if (edge.action === 'replace') {
          // 替换：领取新文书（发布时间沿更正公告，身份是独立披露编号）
          const repl = await fetchDoc(target.id, target.path,
            { publishedAt: entry.publishedAt, publishedAtSource: entry.id })
          record.retrieved = Boolean(repl?.doc.anchors?.[target.anchor])
        } else {
          // 延用：回到旧版披露身份核对锚点仍在；领不回就把缺口留给评审员
          const carried = await fetchDoc(target.id, target.path, {})
          record.retrieved = Boolean(carried?.doc.anchors?.[target.anchor])
        }
        if (!record.retrieved) {
          const targetRef = `${target.id}#${target.anchor}`
          if (!store.gaps.some(gap => !gap.resolvedAt && gap.target === targetRef && gap.notice === entry.id)) {
            store.gaps.push({
              notice: entry.id, edge: { old: edge.old, anchor: edge.anchor, action: edge.action },
              target: targetRef, reason: '更正公告指向的正文领不回或锚点缺失',
              firstSeen: now, run: run.id
            })
          }
        } else {
          // 本轮已能领回：此前留下的缺口消除
          const targetRef = `${target.id}#${target.anchor}`
          for (const gap of store.gaps) {
            if (!gap.resolvedAt && gap.target === targetRef) gap.resolvedAt = now
          }
        }
        edges.push(record)
      }
      store.corrections[entry.id] = {
        publishedAt: entry.publishedAt, firstSeen: store.corrections[entry.id]?.firstSeen ?? now, edges
      }
    }
  }

  // —— 鉴证机构分栏目录：含 rel=next 继续页；单个详情打不开不影响其他项 ——
  const seenCatalogs = new Set()
  let catalogPath = '/verifier'
  while (catalogPath && !seenCatalogs.has(catalogPath)) {
    seenCatalogs.add(catalogPath)
    const catalog = await get(catalogPath)
    if (catalog.status !== 200) {
      run.failures.push({ url: catalogPath, status: catalog.status })
      break
    }
    const { entries, notices, next } = parseVerifierCatalog(catalog.text)
    for (const entry of entries) {
      const path = docRefFromHref(entry.href).path
      const res = await get(path)
      if (res.status !== 200) {
        run.failures.push({ url: path, status: res.status })
        continue
      }
      const existing = store.assurance[entry.id]
      store.assurance[entry.id] = {
        ...existing,
        id: entry.id,
        url: path,
        // 目录后几轮可能不再标发布时间：保留首次见到的，不因索引缺项推翻已取得的证明
        issuedAt: existing?.issuedAt ?? entry.issued,
        issuedAtSource: existing?.issuedAtSource ?? (entry.issued ? catalogPath : null),
        sections: parseAssurancePage(res.text),
        digest: digestOf(res.text),
        firstSeen: existing?.firstSeen ?? now,
        lastSeen: now
      }
      if (!run.found.assurance.includes(entry.id)) run.found.assurance.push(entry.id)
    }
    for (const notice of notices) {
      const id = docRefFromHref(notice.href).id
      const path = docRefFromHref(notice.href).path
      const existing = store.notices[id]
      const record = {
        ...existing,
        id, url: path,
        withdraws: notice.withdraws ?? existing?.withdraws ?? null,
        noticeAt: notice.noticeAt ?? existing?.noticeAt ?? null,
        firstSeen: existing?.firstSeen ?? now,
        formal: existing?.formal ?? null
      }
      // 预告本身不能当撤回依据：只有领回写明覆盖范围与生效时间的正式文件才调整资格
      const formal = await get(path)
      if (formal.status === 200) {
        const sections = parseAssurancePage(formal.text)
        record.formal = {
          retrievedAt: now,
          digest: digestOf(formal.text),
          scopes: sections.map(s => ({
            anchor: s.anchor, withdraws: s.withdraws ?? record.withdraws,
            site: s.site, owner: s.owner, period: s.period, metric: s.metric,
            effective: s.effective
          }))
        }
        if (record.formal.scopes.some(s => !s.effective)) {
          run.failures.push({ url: path, status: formal.status, note: '正式撤回文件缺生效时间，仍按预告未领齐处理' })
          record.formal = null
        }
      } else {
        run.failures.push({ url: path, status: formal.status, note: '撤回正式文件暂未开放' })
      }
      store.notices[id] = record
      if (!run.found.notices.includes(id)) run.found.notices.push(id)
    }
    catalogPath = next
  }

  // —— 组织与场址标识、采购门槛、来源侧已发决定 ——
  const assets = await get('/assets')
  if (assets.status === 200) store.assets = { at: now, list: JSON.parse(assets.text) }
  const requirements = await get('/requirements')
  if (requirements.status === 200) store.requirements = { at: now, list: JSON.parse(requirements.text) }
  const issued = await get('/issued')
  if (issued.status === 200) {
    for (const decision of JSON.parse(issued.text)) {
      store.issued[decision.id] = { ...decision, firstSeen: store.issued[decision.id]?.firstSeen ?? now }
    }
  }

  store.runs.push(run)
  return run
}

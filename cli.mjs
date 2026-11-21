#!/usr/bin/env node
import { collect } from './src/collect.mjs'
import { loadStore, saveStore } from './src/store.mjs'
import { parseBaseline, reviewAll, STATUS } from './src/review.mjs'
import { issueDecision, decisionView } from './src/decisions.mjs'
import { siteView } from './src/siteview.mjs'

const args = process.argv.slice(2)
const command = args[0]
const flags = {}
const positionals = []
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) { flags[args[i].slice(2)] = args[i + 1]; i++ }
  else positionals.push(args[i])
}
const option = (name, fallback) => flags[name] ?? fallback
const storePath = option('store', 'data/store.json')
const origin = option('origin', 'http://127.0.0.1:4173')

const print = (...lines) => console.log(lines.join('\n'))
const fmtFigure = f => `${f.ref}：${f.owner}/${f.site} ${f.metric}=${f.value}${f.unit ?? ''}（发布 ${f.publishedAt}）`

async function main() {
  if (command === 'collect') {
    const store = await loadStore(storePath)
    const now = option('at', new Date().toISOString())
    const run = await collect(origin, store, { now })
    await saveStore(storePath, store)
    print(`第 ${run.id} 轮采集完成（来源发布序号 ${run.step ?? '?'}，采集时间 ${now}）`,
      `  文书：${run.found.docs.join('、') || '无'}　鉴证：${run.found.assurance.join('、') || '无'}　预告：${run.found.notices.join('、') || '无'}`,
      ...(run.failures.length ? ['  未能领取：', ...run.failures.map(f => `    ${f.url} → ${f.status}${f.note ? `（${f.note}）` : ''}`)] : []))
    return
  }

  const store = await loadStore(storePath)

  if (command === 'review') {
    const asOf = option('as-of', null)
    if (!asOf) throw new Error('review 需要 --as-of <评审基准日>')
    const asOfMs = parseBaseline(asOf)
    const lines = [`评审基准日：${asOf}`]
    for (const result of reviewAll(store, asOfMs)) {
      const req = result.requirement
      lines.push(`\n[${STATUS[result.status]}] ${req.id}：${req.owner}/${req.site} ${req.year} ${req.metric} ≤ ${req.atMost}${req.unit}${req.assurance ? '（需鉴证）' : ''}`)
      if (result.figure) lines.push(`  披露：${fmtFigure(result.figure)}`)
      if (result.assurance) lines.push(`  鉴证：${result.assurance.id}#${result.assurance.section.anchor}（发布 ${result.assurance.issuedAt}）`)
      for (const reason of result.reasons) lines.push(`  ${reason}`)
      for (const gap of result.gaps) lines.push(`  缺口：${gap.notice} 延用 ${gap.target} 未领回（${gap.firstSeen} 起）`)
      for (const hold of result.hold ?? []) lines.push(`  暂停发新结论：${hold.assurance} 的撤回预告 ${hold.notice}（${hold.noticeAt}）正式文件未领齐`)
    }
    print(...lines)
    return
  }

  if (command === 'issue') {
    const on = option('on', new Date().toISOString())
    const ids = positionals
    if (!ids.length) throw new Error('issue 需要至少一个门槛编号，如：node cli.mjs issue T1 --on 2026-03-12T12:00+08:00')
    const outcome = issueDecision(store, ids, on)
    if (!outcome.ok) {
      const lines = ['不满足发出条件：']
      for (const e of outcome.evals) lines.push(`  ${e.id}：${e.error ?? STATUS[e.result.status]}${e.result?.reasons?.length ? `（${e.result.reasons.join('；')}）` : ''}`)
      print(...lines)
      process.exitCode = 1
      return
    }
    await saveStore(storePath, store)
    print(`已发出决定 ${outcome.decision.id}（${on}），冻结证据：`,
      ...outcome.decision.evidence.map(e => `  ${e.ref}（发布 ${e.publishedAt}，取得 ${e.retrievedAt}）`))
    return
  }

  if (command === 'decision') {
    const id = positionals[0]
    const view = decisionView(store, id)
    if (!view) throw new Error(`没有决定 ${id}`)
    const lines = [
      `决定 ${view.id}（${view.origin === 'source' ? '来源侧已发' : '本系统发出'}，${view.on}）—— ${view.note}`,
      `门槛：${view.criteria.join('、')}`,
      '当时采用的证据：'
    ]
    for (const e of view.evidence) {
      lines.push(`  ${e.ref}${e.url ? `（${store.origin}${e.url}#${e.ref.split('#')[1]}）` : ''}`)
      if (e.frozen) lines.push(`    内容：${JSON.stringify(e.frozen)}`)
      lines.push(`    发布 ${e.publishedAt ?? '?'}　首次取得 ${e.retrievedAt ?? '?'}`)
      for (const change of e.changes) {
        if (change.type === 'replaced') lines.push(`    变化：${change.at} 被 ${change.target} 取代（${change.notice}）${change.targetSummary ? `，现为 ${change.targetSummary.metric}=${change.targetSummary.value}${change.targetSummary.unit ?? ''}` : '，新正文未领回'}`)
        if (change.type === 'carried') lines.push(`    变化：${change.at} 经 ${change.notice} 确认延用`)
        if (change.type === 'withdrawn') lines.push(`    变化：${change.effective} 起撤回（${change.notice}）`)
        if (change.type === 'notice-pending') lines.push(`    变化：撤回预告 ${change.notice}（${change.noticeAt}）正式文件未领齐`)
        if (change.type === 'missing') lines.push(`    变化：${change.note}`)
      }
    }
    lines.push('按现有依据复核：')
    for (const r of view.reevaluation) lines.push(`  ${r.id}：${STATUS[r.status] ?? r.status}${r.reasons?.length ? `（${r.reasons.join('；')}）` : ''}`)
    lines.push(view.canReissue ? '现有依据仍可发出同样决定。' : '现有依据不再支持发出同样决定（原决定不因此改变）。')
    print(...lines)
    return
  }

  if (command === 'site') {
    const id = positionals[0]
    const asOf = option('as-of', null)
    const view = siteView(store, id, asOf ? parseBaseline(asOf) : null)
    const lines = [`场址 ${id}${asOf ? `（基准日 ${asOf}）` : ''}`]
    if (view.identity.length) {
      lines.push('标识关系：')
      for (const a of view.identity) lines.push(`  ${a.label}　属 ${a.owner}${a.from ? `（自 ${a.from}）` : ''}${a.through ? `（至 ${a.through}）` : ''}`)
    }
    lines.push('企业声明：')
    for (const c of view.claims) lines.push(`  ${c.ref}：${c.owner} ${c.metric}=${c.value}${c.unit ?? ''}｜${c.status}｜${c.provenance}｜发布 ${c.publishedAt}｜取得 ${c.firstSeen}\n    ${c.url}`)
    lines.push('机构覆盖：')
    for (const c of view.coverage) lines.push(`  ${c.ref}：${c.owner} ${c.period} ${c.metric}｜${c.status}｜${c.provenance}｜发布 ${c.issuedAt}｜取得 ${c.firstSeen}\n    ${c.url}`)
    if (view.pending.length) {
      lines.push('尚未领齐：')
      for (const p of view.pending) lines.push(`  ${p.kind}：${p.ref}${p.url ? `\n    ${p.url}` : ''}`)
    }
    print(...lines)
    return
  }

  print(`用法：
  node cli.mjs collect [--origin URL] [--at 时间] [--store 路径]
  node cli.mjs review --as-of 基准日 [--store 路径]
  node cli.mjs issue <门槛…> --on 时间 [--store 路径]
  node cli.mjs decision <决定号> [--store 路径]
  node cli.mjs site <场址号> [--as-of 基准日] [--store 路径]`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })

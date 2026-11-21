import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { makeSource } from '../source.mjs'
import { collect } from '../src/collect.mjs'
import { emptyStore } from '../src/store.mjs'

async function openSource(t) {
  const server = makeSource()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    async view(step) {
      const res = await fetch(`${origin}/replay`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step })
      })
      assert.equal(res.status, 200)
    }
  }
}

test('四轮发布逐轮采集：身份归并、更正链、补列分页、撤回预告与正式文件', async t => {
  const { origin, view } = await openSource(t)
  const store = emptyStore()

  // 第 0 次发布：初始披露
  await view(0)
  const run1 = await collect(origin, store, { now: '2026-03-15T09:00+08:00' })
  assert.equal(run1.step, 0)
  assert.equal(store.docs.D1.kind, 'report')
  assert.equal(store.docs.D1.year, '2025')
  assert.equal(store.docs.D1.anchors.p5.value, 830)
  assert.equal(store.docs.D1.anchors.p5.site, 'S-01')
  assert.equal(store.docs.D1.anchors.p15.site, null, '集团合计不属于任何场址')
  assert.equal(store.assurance.A1.issuedAt, '2026-03-07T10:00+08:00')
  assert.equal(store.assurance.A1.sections[0].metric, 'water-new')
  assert.equal(store.requirements.list.length, 2)
  assert.equal(store.issued.Q1.on, '2026-03-12T12:00+08:00')

  // 第 1 次发布：更正公告 + 机构补列（rel=next）
  await view(1)
  await collect(origin, store, { now: '2026-04-21T12:00+08:00' })
  const edges = store.corrections.N2.edges
  assert.deepEqual(edges.map(e => [e.action, `${e.old}#${e.anchor}`, `${e.targetDoc}#${e.targetAnchor}`, e.retrieved]), [
    ['replace', 'D1#p5', 'D2#p5', true],
    ['carry', 'D1#p8', 'D1#p8', true]
  ])
  assert.equal(store.docs.D2.anchors.p5.metric, 'water-mixed', '更正后口径变化要按文书如实记录')
  assert.equal(store.docs.D2.anchors.p5.value, 860)
  assert.equal(store.docs.D2.publishedAt, '2026-04-21T10:00+08:00', '替换件发布时间沿更正公告')
  assert.deepEqual(store.docs.D2.claims, ['A1'], '新正文挂的旧审验函只记为企业自称')
  assert.equal(store.assurance.A4.issuedAt, '2026-03-09T12:00+08:00', '补列文件按目录标明的实际发布时间')
  assert.equal(store.assurance.A4.firstSeen, '2026-04-21T12:00+08:00', '首次取得时间另记')
  assert.equal(store.assurance.A1.issuedAt, '2026-03-07T10:00+08:00', '目录后一轮未标发布时间不推翻已取得的')
  assert.equal(store.gaps.length, 0)

  // 第 2 次发布：撤回预告，正式文件 503；A4 从索引消失不等于撤回
  await view(2)
  const run3 = await collect(origin, store, { now: '2026-04-26T12:00+08:00' })
  assert.equal(store.notices.W4.withdraws, 'A4')
  assert.equal(store.notices.W4.noticeAt, '2026-04-26T11:00+08:00')
  assert.equal(store.notices.W4.formal, null, '正式文件未开放时不能按预告调整资格')
  assert.ok(run3.failures.some(f => f.url === '/assurance/W4' && f.status === 503))
  assert.ok(store.assurance.A4, '索引不再展示 A4 不推定撤回')
  assert.equal(store.assurance.A4.sections[0].site, 'S-02')

  // 第 3 次发布：正式撤回文件写明范围与生效时间
  await view(3)
  await collect(origin, store, { now: '2026-04-29T09:00+08:00' })
  const scopes = store.notices.W4.formal.scopes
  assert.equal(scopes.length, 1)
  assert.equal(scopes[0].effective, '2026-04-28T00:00+08:00')
  assert.equal(scopes[0].site, 'S-02')
  assert.equal(scopes[0].owner, 'S')
  assert.equal(scopes[0].metric, 'water-total')
  assert.equal(scopes[0].withdraws, 'A4')
  assert.equal(store.notices.W4.formal.retrievedAt, '2026-04-29T09:00+08:00')
})

import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { makeSource } from '../source.mjs'
import { collect } from '../src/collect.mjs'
import { emptyStore } from '../src/store.mjs'
import { parseBaseline, evaluateRequirement, reviewAll } from '../src/review.mjs'
import { issueDecision, decisionView } from '../src/decisions.mjs'
import { siteView } from '../src/siteview.mjs'

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

const byId = (store, id) => store.requirements.list.find(r => r.id === id)
const statusOf = (store, id, asOf) => evaluateRequirement(store, byId(store, id), parseBaseline(asOf)).status

test('评审基准日时间线：待齐、补录、更正、预告、正式撤回', async t => {
  const { origin, view } = await openSource(t)
  const store = emptyStore()

  await view(0)
  await collect(origin, store, { now: '2026-03-15T09:00+08:00' })
  assert.equal(statusOf(store, 'T1', '2026-03-12'), 'met')
  assert.equal(statusOf(store, 'T2', '2026-03-12'), 'pending', '当天指定来源还没有 T2 的鉴证文件')

  await view(1)
  await collect(origin, store, { now: '2026-04-21T12:00+08:00' })
  assert.equal(statusOf(store, 'T2', '2026-03-12'), 'met', 'A4 早已发布（03-09）但漏采，补齐该日候选')
  assert.equal(statusOf(store, 'T1', '2026-04-22'), 'pending', '更正后 water-new 口径没有现行数字')
  const t1 = evaluateRequirement(store, byId(store, 'T1'), parseBaseline('2026-04-22'))
  assert.equal(t1.figure, null, 'D2#p5 是 water-mixed，不能替 water-new；旧审验函链接不为新数字背书')
  assert.equal(statusOf(store, 'T2', '2026-04-22'), 'met')

  const issued = issueDecision(store, ['T2'], '2026-04-22T10:00+08:00')
  assert.equal(issued.ok, true)
  assert.deepEqual(issued.decision.evidence.map(e => e.ref), ['D1#p8', 'A4#p4'])
  const refused = issueDecision(store, ['T1'], '2026-04-22T10:00+08:00')
  assert.equal(refused.ok, false)

  const q1 = decisionView(store, 'Q1')
  const q1Figure = q1.evidence.find(e => e.ref === 'D1#p5')
  assert.equal(q1Figure.frozen.value, 830, '决定书能看到当时实际采用的数字')
  assert.equal(q1Figure.changes[0].type, 'replaced')
  assert.equal(q1Figure.changes[0].targetSummary.metric, 'water-mixed')
  assert.equal(q1.canReissue, false, '更正后不再支持用现有依据发出同样决定')

  await view(2)
  await collect(origin, store, { now: '2026-04-26T12:00+08:00' })
  assert.equal(statusOf(store, 'T2', '2026-04-27'), 'hold', '撤回预告涉及的范围未领齐，送回核对')
  assert.equal(statusOf(store, 'T2', '2026-04-25'), 'met', '预告目录时间之前不受影响')
  assert.equal(statusOf(store, 'T2', '2026-04-01'), 'met', '索引不再展示 A4 不推定撤回')
  assert.notEqual(statusOf(store, 'T1', '2026-04-27'), 'hold', '未涉及的场址继续正常评审')
  const held = issueDecision(store, ['T2'], '2026-04-27T10:00+08:00')
  assert.equal(held.ok, false, '预告未领齐时暂停发新结论')

  await view(3)
  await collect(origin, store, { now: '2026-04-29T09:00+08:00' })
  assert.equal(statusOf(store, 'T2', '2026-04-27'), 'met', '正式文件生效日前覆盖仍有效')
  assert.equal(statusOf(store, 'T2', '2026-04-28'), 'pending', '生效日起该范围不再是已证实')
  const t2 = evaluateRequirement(store, byId(store, 'T2'), parseBaseline('2026-04-28'))
  assert.match(t2.reasons[0], /撤回/)

  const l1 = decisionView(store, 'L1')
  const l1Assurance = l1.evidence.find(e => e.ref === 'A4#p4')
  assert.deepEqual(l1Assurance.changes.map(c => c.type), ['withdrawn'])
  assert.equal(l1Assurance.changes[0].effective, '2026-04-28T00:00+08:00')
  assert.equal(l1.canReissue, false)
  assert.match(l1.note, /不反改/, '后来的撤回不反改当时作出的决定')

  const site2 = siteView(store, 'S-02')
  assert.deepEqual(site2.claims.map(c => c.ref), ['D1#p8'])
  assert.equal(site2.coverage[0].status, '已撤回（2026-04-28T00:00+08:00 生效，W4）')
  assert.equal(site2.coverage[0].provenance, '披露时已存在但本次漏取')
  assert.equal(site2.pending.length, 0, '正式文件已领回，不再挂起')

  const site1 = siteView(store, 'S-01', parseBaseline('2026-03-12'))
  const d2 = site1.claims.find(c => c.ref === 'D2#p5')
  assert.equal(d2.provenance, '后来新增')
  const d1p5 = site1.claims.find(c => c.ref === 'D1#p5')
  assert.match(d1p5.status, /已被 D2#p5 取代/)
  assert.deepEqual(site1.identity.map(a => a.owner), ['G', 'S'], '同名场址按标识关系分列归属')
})

test('合计与逐场址不可替换，部分范围鉴证不算整体已审验', () => {
  const store = emptyStore()
  store.origin = 'http://local'
  store.runs.push({ id: 1, at: '2026-03-10T00:00+08:00' })
  store.docs.G1 = {
    kind: 'report', year: '2025', publishedAt: '2026-03-01T10:00+08:00', firstSeen: '2026-03-10T00:00+08:00',
    anchors: {
      total: { company: 'G', site: null, metric: 'water-total', unit: 'm3', value: 5000, text: '集团合计 5000' },
      s1: { company: 'G', site: 'S-01', metric: 'water-total', unit: 'm3', value: 900, text: '场址总用水 900' },
      n1: { company: 'G', site: 'S-01', metric: 'water-new', unit: 'm3', value: 700, text: '场址新水 700' },
      n2: { company: 'G', site: 'S-02', metric: 'water-new', unit: 'm3', value: 800, text: '场址新水 800' }
    }
  }
  store.assurance.P1 = {
    issuedAt: '2026-03-05T10:00+08:00', firstSeen: '2026-03-10T00:00+08:00', url: '/assurance/P1',
    sections: [
      { anchor: 'p1', owner: 'G', disclosure: 'G1', site: 'S-01', period: '2025', metric: 'water-new' },
      { anchor: 'p2', owner: 'G', disclosure: 'G1', site: 'S-02', period: '2025', metric: 'water-new' }
    ]
  }
  const req = patch => ({ id: 'R', site: 'S-01', owner: 'G', year: 2025, metric: 'water-total', atMost: 1000, unit: 'm3', assurance: false, ...patch })
  const asOf = parseBaseline('2026-03-20')

  assert.equal(evaluateRequirement(store, req({}), asOf).status, 'met')
  assert.equal(evaluateRequirement(store, req({ site: 'S-02', atMost: 6000 }), asOf).status, 'pending',
    '集团合计 5000 不能顶替 S-02 的场址数字')
  assert.equal(evaluateRequirement(store, req({ assurance: true }), asOf).status, 'pending',
    'P1 只覆盖 water-new，不能按报告整体已审验处理')
  assert.equal(evaluateRequirement(store, req({ metric: 'water-new', assurance: true }), asOf).status, 'met',
    '明确覆盖的范围可以作数')
})

test('正式撤回只覆盖部分场址时，其余明确覆盖的部分继续可用', () => {
  const store = emptyStore()
  store.origin = 'http://local'
  store.runs.push({ id: 1, at: '2026-03-10T00:00+08:00' })
  store.docs.G1 = {
    kind: 'report', year: '2025', publishedAt: '2026-03-01T10:00+08:00', firstSeen: '2026-03-10T00:00+08:00',
    anchors: {
      n1: { company: 'G', site: 'S-01', metric: 'water-new', unit: 'm3', value: 700, text: '场址新水 700' },
      n2: { company: 'G', site: 'S-02', metric: 'water-new', unit: 'm3', value: 800, text: '场址新水 800' }
    }
  }
  store.assurance.A9 = {
    issuedAt: '2026-03-05T10:00+08:00', firstSeen: '2026-03-10T00:00+08:00', url: '/assurance/A9',
    sections: [
      { anchor: 'p1', owner: 'G', disclosure: 'G1', site: 'S-01', period: '2025', metric: 'water-new' },
      { anchor: 'p2', owner: 'G', disclosure: 'G1', site: 'S-02', period: '2025', metric: 'water-new' }
    ]
  }
  store.notices.W9 = {
    id: 'W9', withdraws: 'A9', noticeAt: '2026-04-26T11:00+08:00', firstSeen: '2026-04-26T12:00+08:00',
    formal: { retrievedAt: '2026-04-29T09:00+08:00', scopes: [{ anchor: 'p1', withdraws: 'A9', site: 'S-01', owner: null, period: null, metric: null, effective: '2026-05-01T00:00+08:00' }] }
  }
  const req = patch => ({ id: 'R', site: 'S-01', owner: 'G', year: 2025, metric: 'water-new', atMost: 1000, unit: 'm3', assurance: true, ...patch })
  const asOf = parseBaseline('2026-05-02')
  assert.equal(evaluateRequirement(store, req({}), asOf).status, 'pending', 'S-01 的覆盖已按生效日撤回')
  assert.equal(evaluateRequirement(store, req({ site: 'S-02' }), asOf).status, 'met', '撤回未涉及 S-02，继续可用')
})

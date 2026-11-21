import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { collect } from '../src/collect.mjs'
import { emptyStore } from '../src/store.mjs'
import { parseBaseline, evaluateRequirement } from '../src/review.mjs'

// 夹具：更正公告的延用锚点在正文里不存在（缺口），机构目录里一个详情 404（其余继续可读）
function fixture(t) {
  let step = 0
  const pages = {
    '/exchange': [
      '<a data-doc="D9" datetime="2026-03-01T10:00+08:00" href="/docs/D9">某企 2025</a>',
      '<a data-doc="D9" datetime="2026-03-01T10:00+08:00" href="/docs/D9">某企 2025</a><a data-doc="N9" datetime="2026-04-02T10:00+08:00" href="/docs/N9">更正公告</a>'
    ],
    '/docs/D9': ['<section id="p1" data-company="G" data-site="S-01" data-metric="water-new" data-unit="m3">场址新水 100</section>'],
    '/docs/N9': [null, '<a data-old="D9" data-anchor="p1" data-action="replace" href="/docs/D10#p1">换口径</a><a data-old="D9" data-anchor="p2" data-action="carry" href="/docs/D9#p2">延用 p2</a>'],
    '/docs/D10': [null, '<section id="p1" data-company="G" data-site="S-01" data-metric="water-mixed" data-unit="m3">场址混合水 130</section>'],
    '/verifier': ['<a data-id="A8" data-issued="2026-03-05T10:00+08:00" href="/assurance/A8">鉴证八</a><a data-id="A9" data-issued="2026-03-06T10:00+08:00" href="/assurance/A9">鉴证九</a>'],
    '/assurance/A8': ['<section id="p1" data-owner="G" data-disclosure="D9" data-site="S-01" data-period="2025" data-metric="water-new">覆盖新水</section>'],
    '/assurance/A9': [],
    '/assets': [JSON.stringify([])],
    '/requirements': [JSON.stringify([{ id: 'T9', site: 'S-01', year: 2025, owner: 'G', metric: 'water-new', atMost: 150, unit: 'm3', assurance: true }])],
    '/issued': [JSON.stringify([])]
  }
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    const versions = pages[path]
    const body = versions?.[Math.min(step, versions.length - 1)]
    if (body == null) {
      res.writeHead(404).end('{}')
      return
    }
    res.writeHead(200, { 'content-type': path === '/assets' || path === '/requirements' || path === '/issued' ? 'application/json' : 'text/html' }).end(body)
  })
  server.listen(0, '127.0.0.1')
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return { server, setStep: value => { step = value } }
}

test('延用内容领不回时缺口留给评审员；单个详情打不开不影响其他项', async t => {
  const { server, setStep } = fixture(t)
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const store = emptyStore()

  const run1 = await collect(origin, store, { now: '2026-03-10T00:00+08:00' })
  assert.ok(store.assurance.A8, 'A9 打不开不影响 A8 入册')
  assert.ok(run1.failures.some(f => f.url === '/assurance/A9' && f.status === 404))
  const req = store.requirements.list[0]
  assert.equal(evaluateRequirement(store, req, parseBaseline('2026-03-10')).status, 'met')

  setStep(1)
  await collect(origin, store, { now: '2026-04-03T00:00+08:00' })
  const gaps = store.gaps.filter(g => !g.resolvedAt)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].target, 'D9#p2')
  assert.equal(gaps[0].notice, 'N9')

  const result = evaluateRequirement(store, req, parseBaseline('2026-04-03'))
  assert.equal(result.status, 'pending', '更正后 water-new 没有现行数字')
  assert.equal(result.gaps.length, 1, '缺口随门槛呈给评审员')
  assert.equal(result.gaps[0].target, 'D9#p2')

  // 再采一轮：缺口不重复登记
  await collect(origin, store, { now: '2026-04-04T00:00+08:00' })
  assert.equal(store.gaps.filter(g => !g.resolvedAt).length, 1)
})

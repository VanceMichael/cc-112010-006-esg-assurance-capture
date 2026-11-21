import { load } from 'cheerio'

// 取文本里最后一个数字作为披露数值（如 “柳溪厂区取用新水 830” → 830）
export function lastNumber(text) {
  const matches = String(text).match(/-?\d+(?:\.\d+)?/g)
  return matches ? Number(matches[matches.length - 1]) : null
}

// 文书地址 → { path, id, anchor }，例如 /docs/D2#p5
export function docRefFromHref(href) {
  const url = new URL(href, 'http://local')
  const id = url.pathname.split('/').pop()
  return { path: url.pathname, id, anchor: url.hash ? url.hash.slice(1) : null }
}

// 交易所目录：披露编号、地址、目录上标明的发布时间
export function parseExchangeCatalog(html) {
  const $ = load(html)
  return $('a[data-doc]').toArray().map(a => ({
    id: $(a).attr('data-doc'),
    href: $(a).attr('href'),
    publishedAt: $(a).attr('datetime') ?? null,
    title: $(a).text().trim()
  }))
}

function parseSections($) {
  return $('section[id]').toArray().map(s => ({
    anchor: $(s).attr('id'),
    company: $(s).attr('data-company') ?? null,
    owner: $(s).attr('data-owner') ?? null,
    site: $(s).attr('data-site') ?? null,
    metric: $(s).attr('data-metric') ?? null,
    unit: $(s).attr('data-unit') ?? null,
    period: $(s).attr('data-period') ?? null,
    disclosure: $(s).attr('data-disclosure') ?? null,
    effective: $(s).attr('data-effective') ?? null,
    withdraws: $(s).attr('data-withdraws') ?? null,
    text: $(s).text().trim()
  }))
}

// 披露文书页：更正边（replace/carry）、正文段落、正文里挂的审验函链接（仅企业自称，不等于机构覆盖）
export function parseDocPage(html) {
  const $ = load(html)
  const edges = $('a[data-old][data-action]').toArray().map(a => ({
    old: $(a).attr('data-old'),
    anchor: $(a).attr('data-anchor'),
    action: $(a).attr('data-action'),
    href: $(a).attr('href')
  }))
  const claims = [...new Set($('a[href]').toArray()
    .map(a => $(a).attr('href'))
    .filter(h => h && h.startsWith('/assurance/'))
    .map(h => docRefFromHref(h).id))]
  return { edges, sections: parseSections($), claims }
}

// 鉴证机构分栏目录：文件条目、撤回预告、rel=next 继续页
export function parseVerifierCatalog(html) {
  const $ = load(html)
  const entries = $('a[data-id]').toArray().map(a => ({
    id: $(a).attr('data-id'),
    issued: $(a).attr('data-issued') ?? null,
    href: $(a).attr('href')
  }))
  const notices = $('a[data-event="notice"]').toArray().map(a => ({
    withdraws: $(a).attr('data-withdraws') ?? null,
    noticeAt: $(a).attr('datetime') ?? null,
    href: $(a).attr('href')
  }))
  const next = $('a[rel="next"]').attr('href') ?? null
  return { entries, notices, next }
}

// 机构文件页：覆盖范围（组织/披露/场址/期间/口径）或正式撤回（withdraws + effective）
export function parseAssurancePage(html) {
  return parseSections(load(html))
}

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

// 证据库：所有内容按“文书身份（披露编号/机构文件号 + 锚点）”归并，
// 绝不按标题或下载文件名去重；每个条目同时保留来源标明的时间与本次首次取得时间。
export function emptyStore() {
  return {
    version: 1,
    origin: null,
    runs: [],          // 采集轮次 { id, at, step, found, failures }
    docs: {},          // 披露文书 D*/N*：{ kind, title, year, publishedAt, firstSeen, lastSeen, digest, anchors, claims }
    corrections: {},   // 更正公告 id → { publishedAt, edges: [{ old, anchor, action, targetDoc, targetAnchor, retrieved }] }
    assurance: {},     // 机构文件 A*：{ issuedAt, firstSeen, lastSeen, digest, sections }
    notices: {},       // 撤回预告 W*：{ withdraws, noticeAt, firstSeen, formal | null }
    assets: null,      // 组织与场址标识关系 { at, list }
    requirements: null,
    issued: {},        // 来源侧已发采购决定（只读汇入）
    localDecisions: {},// 本系统发出的决定（冻结当时证据）
    gaps: []           // 延用内容领不回等缺口，留给评审员
  }
}

export async function loadStore(path) {
  try {
    return { ...emptyStore(), ...JSON.parse(await readFile(path, 'utf8')) }
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStore()
    throw error
  }
}

export async function saveStore(path, store) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(store, null, 2) + '\n')
}

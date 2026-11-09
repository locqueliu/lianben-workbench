/**
 * refine-fs.mjs — M3 炼本（director）prompt 资产的只读文件访问工具。
 *
 * 只做「读」与「路径发现」，不写任何文件；所有错误带可定位的 code。
 * 供 prompts/director.mjs 使用；Host 直接 import prompts/director.mjs，不需要本文件单独导出契约。
 */

import { readFile, readdir } from 'node:fs/promises'
import { readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

function contextError(kind, filePath, detail) {
  const err = new Error(`${kind}: ${filePath}${detail ? ` (${detail})` : ''}`)
  err.code = kind
  err.filePath = filePath
  return err
}

/** 读取 UTF-8 文本（去 BOM，统一换行）。缺失/不可读抛 E_CONTEXT_FILE。 */
export async function readTextFile(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8')
    return normalizeText(raw)
  } catch (err) {
    throw contextError('E_CONTEXT_FILE', filePath, err && err.message ? err.message : String(err))
  }
}

/** 读取并解析 JSON。缺失/非法 JSON 抛 E_CONTEXT_JSON。 */
export async function readJsonFile(filePath) {
  const text = await readTextFile(filePath)
  try {
    return JSON.parse(text)
  } catch (err) {
    throw contextError('E_CONTEXT_JSON', filePath, err && err.message ? err.message : String(err))
  }
}

/** 可选文本：不存在返回 null；存在但读失败抛错（避免把损坏的上下文静默吞掉）。 */
export async function readOptionalText(filePath) {
  if (!existsSync(filePath)) return null
  return readTextFile(filePath)
}

/** 可选 JSON：不存在返回 null；存在但非法抛错。 */
export async function readOptionalJson(filePath) {
  if (!existsSync(filePath)) return null
  return readJsonFile(filePath)
}

/**
 * 列出目录下的 *.md（按文件名排序）。目录不存在返回 []。
 * 用于 engine/rules/炼本细则/ 这类「整目录逐字注入」的规则资产。
 */
export async function listMarkdownFiles(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map((name) => path.join(dir, name))
}

/** 同步读文本；用于 buildDirectorPrompt（同步契约）读取可选 optimized 记录。 */
export function readTextFileSync(filePath) {
  try {
    return normalizeText(readFileSync(filePath, 'utf8'))
  } catch (err) {
    throw contextError('E_CONTEXT_FILE', filePath, err && err.message ? err.message : String(err))
  }
}

/** 同步可选读：不存在返回 null。 */
export function tryReadTextFileSync(filePath) {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return null
    return normalizeText(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

export function isFile(filePath) {
  try {
    return existsSync(filePath) && statSync(filePath).isFile()
  } catch {
    return false
  }
}

export function joinPath(...parts) {
  return path.join(...parts)
}

/** 去 BOM、CRLF→LF、去掉行尾空白（不改行内文字与空行数量）。 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
}

#!/usr/bin/env node
/* usage-report.mjs — usage.jsonl 用量趋势分析工具（零 npm 依赖，Node ≥18）
 *
 * 用法：
 *   node zen-gateway/usage-report.mjs [--file <路径>] [--days N] [--key NAME]
 *                                     [--endpoint chat|messages|responses] [--json]
 *
 * 默认文件：~/.local/share/zen-gateway/usage.jsonl（与 gateway.mjs 的 USAGE_FILE 同路径）
 * 功能：汇总 / 按 key 明细 / 按日趋势（ASCII 柱状图）/ --key --endpoint 筛选 / --json 机器可读
 * 只读输入文件，绝不写入。
 *
 * 语义约定（与 gateway.mjs appendUsage 字段一致）：
 *   - ok=true  ：最终响应 2xx；ok=false ：最终响应非 2xx
 *   - rotated=true：本次请求触发了轮换（记录的是重试后的新 key 与状态）
 *   - ts 为 ISO 字符串，按 UTC 归日（避免时区偏移把同一天拆到两天）
 *   - 坏行（非 JSON / 缺必需字段 / 时间不可解析）跳过并计入 bad_lines，不中断
 *   - 空行跳过，不计入 bad_lines（文件末尾换行不属于坏数据）
 *   - --days 仅影响按日趋势窗口；汇总 / 按 key 明细基于全文件（可配合 --key/--endpoint 缩小范围）
 *
 * 退出码：0 正常；1 文件不存在或为空；2 参数错误。
 */
import { existsSync, statSync, createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import os from "node:os"
import path from "node:path"

const DEFAULT_FILE = path.join(os.homedir(), ".local", "share", "zen-gateway", "usage.jsonl")
const KNOWN_ENDPOINTS = ["chat", "messages", "responses"]
const DEFAULT_DAYS = 7
const MAX_BAR = 30 // 柱状图最长条数（字符）

const HELP = `用法: node zen-gateway/usage-report.mjs [选项]
选项:
  --file <路径>     usage.jsonl 路径覆盖（默认 ~/.local/share/zen-gateway/usage.jsonl）
  --days <N>        按日趋势窗口天数（默认 ${DEFAULT_DAYS}，仅影响趋势部分）
  --key <NAME>      只统计指定 key（精确匹配）
  --endpoint <EP>   只统计指定端点（chat | messages | responses）
  --json            输出机器可读 JSON
  --help            显示本帮助`

/** 解析命令行参数 → { file, days, key, endpoint, json }；参数非法抛错（由 main 捕获输出 exit 2） */
function parseArgs(argv) {
  const opts = { file: null, days: DEFAULT_DAYS, key: null, endpoint: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`参数 ${a} 缺少取值`)
      return argv[++i]
    }
    if (a === "--help" || a === "-h") {
      console.log(HELP)
      process.exit(0)
    } else if (a === "--file") {
      opts.file = next()
    } else if (a === "--days") {
      const raw = next()
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 1) throw new Error(`--days 需为正整数，收到: ${raw}`)
      opts.days = n
    } else if (a === "--key") {
      opts.key = next()
    } else if (a === "--endpoint") {
      opts.endpoint = next()
    } else if (a === "--json") {
      opts.json = true
    } else {
      throw new Error(`未知参数: ${a}`)
    }
  }
  return opts
}

/** ISO 日期 → UTC 日期键 "YYYY-MM-DD"（ts 经 Date 归一，兼容带时区偏移的 ISO） */
function utcDateKey(iso) {
  return iso.toISOString().slice(0, 10)
}

/** 生成近 N 天（含今天）的 UTC 日期键数组，升序 */
function windowDays(days, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    out.push(utcDateKey(new Date(today.getTime() - i * 86400000)))
  }
  return out
}

/** 简单 ASCII 柱状图：条长 = round(v / max * MAX_BAR)，max<=0 时为空条 */
function bar(v, max) {
  if (max <= 0 || v <= 0) return ""
  const len = Math.max(1, Math.round((v / max) * MAX_BAR))
  return "#".repeat(len)
}

/** 以 JSON 形式输出并退出 */
function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n")
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`❌ 参数错误: ${err.message}`)
    console.error(HELP)
    process.exit(2)
  }

  const file = opts.file || DEFAULT_FILE
  if (!existsSync(file)) {
    console.error(`❌ 文件不存在: ${file}`)
    console.error(`   提示: 可先用 --file 指定其他路径，或确认网关已产生用量数据（ZEN_USAGE_FILE 可覆盖默认路径）。`)
    process.exit(1)
  }
  if (statSync(file).size === 0) {
    console.error(`❌ 文件为空: ${file}`)
    process.exit(1)
  }

  // 参数合法性提示（非致命，仅警告）
  if (opts.endpoint && !KNOWN_ENDPOINTS.includes(opts.endpoint)) {
    console.warn(`⚠️  注意: --endpoint ${opts.endpoint} 不在已知端点 ${KNOWN_ENDPOINTS.join("/")} 内，结果可能为空。`)
  }

  // 统计容器
  const summary = { total: 0, ok: 0, fail: 0, rotations: 0, badLines: 0 }
  const perKey = new Map() // name → {total, ok, fail, rotated, lastTs}
  const perDay = new Map() // "YYYY-MM-DD" → {total, ok, rotated}

  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
      const t = line.trim()
      if (!t) continue // 空行跳过
      let rec
      try {
        rec = JSON.parse(t)
      } catch {
        summary.badLines++
        continue
      }
      if (!rec || typeof rec !== "object" || typeof rec.key !== "string" || typeof rec.ts !== "string") {
        summary.badLines++
        continue
      }
      // 筛选
      if (opts.key && rec.key !== opts.key) continue
      if (opts.endpoint && rec.endpoint !== opts.endpoint) continue
      // 时间解析（非法时间计入坏行）
      const d = new Date(rec.ts)
      if (Number.isNaN(d.getTime())) {
        summary.badLines++
        continue
      }
      const ok = rec.ok === true
      const rotated = rec.rotated === true
      summary.total++
      if (ok) summary.ok++
      else summary.fail++
      if (rotated) summary.rotations++

      let k = perKey.get(rec.key)
      if (!k) {
        k = { total: 0, ok: 0, fail: 0, rotated: 0, lastTs: "" }
        perKey.set(rec.key, k)
      }
      k.total++
      if (ok) k.ok++
      else k.fail++
      if (rotated) k.rotated++
      if (rec.ts > k.lastTs) k.lastTs = rec.ts // ISO 字符串字典序即时间序

      const day = utcDateKey(d)
      let dd = perDay.get(day)
      if (!dd) {
        dd = { total: 0, ok: 0, rotated: 0 }
        perDay.set(day, dd)
      }
      dd.total++
      if (ok) dd.ok++
      if (rotated) dd.rotated++
  }

  const successRate = summary.total > 0 ? (summary.ok / summary.total) * 100 : 0
  const genAt = new Date().toISOString()
  const daysArr = windowDays(opts.days)

  // ---- 输出 ----
  if (opts.json) {
    const byKey = {}
    for (const [name, k] of [...perKey.entries()].sort((a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1))) {
      byKey[name] = {
        total: k.total, ok: k.ok, fail: k.fail, rotated: k.rotated,
        last_ts: k.lastTs || null,
      }
    }
    const byDay = daysArr.map((day) => {
      const dd = perDay.get(day) || { total: 0, ok: 0, rotated: 0 }
      return { date: day, total: dd.total, ok: dd.ok, rotated: dd.rotated }
    })
    emitJson({
      file,
      generated_at: genAt,
      window: {
        days: opts.days,
        start_utc: daysArr[0] + "T00:00:00.000Z",
        end_utc: daysArr[daysArr.length - 1] + "T23:59:59.999Z",
      },
      filters: { key: opts.key, endpoint: opts.endpoint },
      summary: {
        total: summary.total,
        ok: summary.ok,
        fail: summary.fail,
        success_rate: Number(successRate.toFixed(1)),
        rotations: summary.rotations,
        unique_keys: perKey.size,
        bad_lines: summary.badLines,
      },
      by_key: byKey,
      by_day: byDay,
    })
    process.exit(0)
  }

  // ---- 文本输出 ----
  console.log("===== usage.jsonl 用量趋势报告 =====")
  console.log(`文件      : ${file}`)
  console.log(`生成时间  : ${genAt} (UTC)`)
  console.log(`筛选      : key=${opts.key || "全部"}  endpoint=${opts.endpoint || "全部"}  days=${opts.days}`)
  console.log("")
  console.log("── 汇总 ──")
  console.log(`总请求数  : ${summary.total}`)
  console.log(`成功      : ${summary.ok}`)
  console.log(`失败      : ${summary.fail}`)
  console.log(`成功率    : ${summary.total > 0 ? successRate.toFixed(1) + "%" : "N/A"}`)
  console.log(`轮换次数  : ${summary.rotations}`)
  console.log(`去重 key  : ${perKey.size}`)
  console.log(`坏行数    : ${summary.badLines}`)
  if (summary.total === 0) {
    console.log("\n⚠️  未解析到任何有效记录（文件可能全是坏行，或筛选条件无匹配）。")
  }
  console.log("")
  console.log("── 按 key 明细 ──")
  console.log(`${"key".padEnd(10)}${"请求".padStart(6)}${"成功".padStart(6)}${"失败".padStart(6)}${"轮换".padStart(6)}  最近使用(UTC)`)
  const sortedKeys = [...perKey.entries()].sort((a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1))
  for (const [name, k] of sortedKeys) {
    console.log(
      `${name.padEnd(10)}${String(k.total).padStart(6)}${String(k.ok).padStart(6)}${String(k.fail).padStart(6)}${String(k.rotated).padStart(6)}  ${k.lastTs || "-"}`
    )
  }
  console.log("")
  console.log(`── 按日趋势（近 ${opts.days} 天，UTC 归日）──`)
  console.log(`${"日期".padEnd(12)}${"请求".padStart(6)}${"成功".padStart(6)}${"轮换".padStart(6)}  柱状图(请求)`)
  const maxTotal = Math.max(1, ...daysArr.map((day) => (perDay.get(day) || { total: 0 }).total))
  for (const day of daysArr) {
    const dd = perDay.get(day) || { total: 0, ok: 0, rotated: 0 }
    const b = bar(dd.total, maxTotal)
    console.log(
      `${day.padEnd(12)}${String(dd.total).padStart(6)}${String(dd.ok).padStart(6)}${String(dd.rotated).padStart(6)}  |${b.padEnd(MAX_BAR)}  ${dd.total}`
    )
  }
}

await main()
/**
 * Deliberate, default-deny MCP loading for remote DA surfaces (public issue
 * #1553, @MatiasBarboza).
 *
 * The SDK's `settingSources` option does NOT cover MCP config — an SDK session
 * gets zero MCP servers unless `mcpServers` is passed explicitly, so remote
 * channels (iMessage, Siri) silently lost every MCP-backed capability and the
 * model confabulated plausible-but-wrong explanations for the failures.
 *
 * The fix is deliberately NOT "load everything": remote channels process
 * externally influenced text, so granting the full desktop MCP set would widen
 * the prompt-injection blast radius. Default remains zero servers; each server
 * is opted in by name via LIFEOS_REMOTE_MCP_ALLOWLIST (comma-separated names
 * matching ~/.claude.json `mcpServers` keys). What changes unconditionally is
 * honesty: the channel prompt now states exactly which MCP servers are loaded,
 * so the model reports "unavailable on this surface" instead of inventing a
 * cause.
 *
 * mcp2cli preference: an allowlisted name with a baked mcp2cli profile
 * (`mcp2cli bake list`) is NEVER loaded as a native `mcpServers` entry — native
 * loading dumps the server's full tool schema into context on first reference,
 * which is exactly the compaction cost mcp2cli exists to avoid. Instead the
 * channel prompt tells the model to call `mcp2cli @<name> ...` via Bash, which
 * these remote-channel sessions already have (preset: "claude_code" tools).
 * Only allowlisted names WITHOUT a baked profile fall back to native loading.
 */

import { readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { execFileSync } from "child_process"

export interface RemoteMcpResolution {
  mcpServers: Record<string, unknown>
  bakedProfiles: string[]
}

/** Parses `mcp2cli bake list`'s table output into profile names. Empty on any failure (binary missing, no profiles baked, etc.) — native loading is the fallback. */
function listBakedMcp2cliProfiles(): string[] {
  try {
    const out = execFileSync("mcp2cli", ["bake", "list"], { encoding: "utf8", timeout: 3000 })
    return out
      .split("\n")
      .slice(2) // header row + "---" separator
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name): name is string => !!name)
  } catch {
    return []
  }
}

export function loadRemoteMcpServers(): RemoteMcpResolution {
  const allow = (process.env.LIFEOS_REMOTE_MCP_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (allow.length === 0) return { mcpServers: {}, bakedProfiles: [] }

  const baked = new Set(listBakedMcp2cliProfiles())
  const bakedProfiles = allow.filter((name) => baked.has(name))
  const needsNativeLoad = allow.filter((name) => !baked.has(name))

  let mcpServers: Record<string, unknown> = {}
  if (needsNativeLoad.length > 0) {
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as {
        mcpServers?: Record<string, unknown>
      }
      const all = cfg?.mcpServers ?? {}
      mcpServers = Object.fromEntries(Object.entries(all).filter(([name]) => needsNativeLoad.includes(name)))
    } catch {
      mcpServers = {}
    }
  }
  return { mcpServers, bakedProfiles }
}

export function mcpStatusPromptLine(loadedNames: string[], bakedProfiles: string[] = []): string {
  if (loadedNames.length === 0 && bakedProfiles.length === 0) {
    return `No MCP servers are loaded on this channel (remote surfaces are MCP-off by default; servers are opted in via LIFEOS_REMOTE_MCP_ALLOWLIST). If asked for an MCP-backed capability, say it is unavailable on this surface — do not guess at other causes.`
  }
  const parts: string[] = []
  if (loadedNames.length > 0) {
    parts.push(`MCP servers loaded natively on this channel: ${loadedNames.join(", ")}.`)
  }
  if (bakedProfiles.length > 0) {
    parts.push(
      `Also available via mcp2cli — call \`mcp2cli @<name> ...\` through Bash instead of a native MCP tool: ${bakedProfiles.join(", ")}.`
    )
  }
  parts.push(`Any OTHER MCP-backed capability is NOT available here — say so plainly if asked.`)
  return parts.join(" ")
}

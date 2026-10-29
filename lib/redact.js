/**
 * Configurable secret/path redaction applied to every exported string.
 *
 * Ordering matters: redaction runs on the raw text before markdown escaping and
 * fencing, so redacted output can never break document structure.
 */

const SECRET_RULES = [
  {
    name: 'api-key-sk',
    pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
    replacement: 'sk-***REDACTED***',
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: 'gh***_REDACTED***',
  },
  {
    name: 'gitlab-token',
    pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
    replacement: 'glpat-***REDACTED***',
  },
  {
    name: 'slack-token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: 'xox-***REDACTED***',
  },
  {
    name: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: 'AKIA***REDACTED***',
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '***JWT-REDACTED***',
  },
  {
    name: 'authorization-header',
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: '$1 ***REDACTED***',
  },
  {
    name: 'credential-pair',
    pattern:
      /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|pwd)\b(\s*[:=]\s*)(["']?)([^\s"',;&)]{6,})/gi,
    replacement: '$1$2$3***REDACTED***',
  },
  {
    name: 'url-userinfo',
    pattern: /(\/\/)[^/\s:@]{2,}:[^/\s@]{2,}@/g,
    replacement: '$1***:***@',
  },
]

function compilePathRules(paths) {
  const rules = []
  const seen = new Set()
  for (const { value, label } of paths) {
    if (!value || value.length < 3) continue
    // Literal string replacement handles Windows and POSIX separators without
    // any regex-escaping pitfalls.
    for (const needle of new Set([value, value.replace(/\\/g, '/')])) {
      const key = needle.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      rules.push({ needle, needleLower: key, label })
    }
  }
  return rules
}

function applyPathRules(text, rules, tally) {
  let output = text
  for (const rule of rules) {
    let cursor = 0
    let result = ''
    let matched = false
    const lower = output.toLowerCase()
    while (cursor < output.length) {
      const index = lower.indexOf(rule.needleLower, cursor)
      if (index === -1) {
        result += output.slice(cursor)
        break
      }
      result += output.slice(cursor, index) + rule.label
      cursor = index + rule.needle.length
      matched = true
    }
    if (matched) {
      tally(`path:${rule.label}`)
      output = result
    }
  }
  return output
}

export function createRedactor(options = {}) {
  const enabled = options.enabled !== false
  const counts = new Map()
  const home = options.home
  const cwd = options.cwd

  const pathRules = enabled
    ? compilePathRules(
        [
          home ? { value: home, label: '~' } : null,
          cwd && cwd !== home ? { value: cwd, label: '<workspace>' } : null,
        ].filter(Boolean),
      )
    : []

  function tally(name) {
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  function redact(input) {
    const text = typeof input === 'string' ? input : String(input ?? '')
    if (!enabled || text.length === 0) return text

    let output = applyPathRules(text, pathRules, tally)
    for (const rule of SECRET_RULES) {
      output = output.replace(rule.pattern, (...args) => {
        tally(rule.name)
        return typeof rule.replacement === 'function' ? rule.replacement(...args) : rule.replacement
      })
    }
    return output
  }

  function report() {
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
    return {
      enabled,
      total,
      byRule: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])),
    }
  }

  return { redact, report, enabled }
}

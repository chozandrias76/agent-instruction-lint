import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { access } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'
import { parseGitDiff } from '../src/diff.js'
import { compareFindings, lintRepository } from '../src/index.js'
import { readInlineMarkdownLinks, readInlineMarkdownReferences, readMarkdownPathReferences, readMarkdownStructure, resolveMarkdownLink } from '../src/markdown.js'
import { extractAddedCitationEntryBlocks, runCite001, runCite002, runCite003, runCite004, runCite005 } from '../src/rules/citation.js'
import { runPhrase001 } from '../src/rules/phrase.js'
import { runBoot001, runBoot002, runTopo001, runTopo002, runTopo003 } from '../src/rules/topology.js'
import type { AgentInstructionLintConfig } from '../src/types.js'

async function makeRepo(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'agent-instruction-lint-'))
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(value, null, 2))
}

describe('markdown helpers', () => {
  it('parses heading ancestry and code-block ranges from one markdown structure read', async () => {
    const repoRoot = await makeRepo()
    const filePath = path.join(repoRoot, 'guide.md')
    await writeFile(filePath, '# Guide\n\nSection\n=======\n\n```md\nStart with README.md.\n```\n\n    Indented code\n')

    const structure = await readMarkdownStructure(filePath)
    expect(structure.headings.map((heading) => heading.text)).toEqual(['Guide', 'Section'])
    expect(structure.codeRanges).toHaveLength(2)
  })

  it('extracts inline markdown references with parser-backed link and image handling', () => {
    const references = readInlineMarkdownReferences('Read [guide](README.md "operator guide"), ![proof](./artifacts/proof.png), and `docs/reference.md`.')
    expect(references.links).toEqual(['README.md', './artifacts/proof.png'])
    expect(references.codeSpans).toEqual(['docs/reference.md'])
  })

  it('captures inline markdown link columns from parser positions', () => {
    const links = readInlineMarkdownLinks('Read [guide](README.md) and ![proof](./artifacts/proof.png).')
    expect(links).toEqual([
      { url: 'README.md', line: 1, column: 6 },
      { url: './artifacts/proof.png', line: 1, column: 29 }
    ])
  })

  it('resolves reference-style markdown links and images through local definitions', () => {
    const links = readInlineMarkdownLinks([
      'Read [guide][readme] and ![proof][image].',
      '',
      '[readme]: README.md',
      '[image]: ./artifacts/proof.png'
    ].join('\n'))

    expect(links).toEqual([
      { url: 'README.md', line: 1, column: 6 },
      { url: './artifacts/proof.png', line: 1, column: 26 }
    ])
  })

  it('can exclude images when only hyperlink-style references should count', () => {
    const links = readInlineMarkdownLinks('Read [guide](README.md) and ![proof](./artifacts/proof.png).', {
      includeImages: false
    })

    expect(links).toEqual([
      { url: 'README.md', line: 1, column: 6 }
    ])
  })

  it('resolves collapsed and shortcut reference-style markdown links through local definitions', () => {
    const links = readInlineMarkdownLinks([
      'Read [guide][] and [manual].',
      '',
      '[guide]: README.md',
      '[manual]: docs/manual.md'
    ].join('\n'))

    expect(links).toEqual([
      { url: 'README.md', line: 1, column: 6 },
      { url: 'docs/manual.md', line: 1, column: 20 }
    ])
  })

  it('normalizes markdown path references for links, code spans, and bare path tokens', () => {
    const references = readMarkdownPathReferences(
      'Read [guide](../README.md#intro), `docs/reference.md`, and notes about docs/guide.md.',
      'states/klaatu.md'
    )

    expect([...references]).toEqual(expect.arrayContaining([
      '../README.md',
      'README.md',
      'README.md',
      'docs/reference.md',
      'reference.md',
      'states/docs/reference.md',
      'docs/guide.md',
      'guide.md',
      'states/docs/guide.md'
    ]))
  })

  it('normalizes file:// and ~/ markdown path references as local paths', () => {
    const references = readMarkdownPathReferences(
      'Read [guide](file:///tmp/guide.md) and [home](~/guide.md).',
      'states/klaatu.md'
    )

    expect([...references]).toEqual(expect.arrayContaining([
      '/tmp/guide.md',
      'guide.md',
      path.join(os.homedir(), 'guide.md')
    ]))
  })

  it('detects bare absolute, home-relative, and file:// markdown path tokens', () => {
    const references = readMarkdownPathReferences(
      'Read /tmp/guide.md, ~/guide.md, and file:///tmp/linked.md.',
      'states/klaatu.md'
    )

    expect([...references]).toEqual(expect.arrayContaining([
      '/tmp/guide.md',
      path.join(os.homedir(), 'guide.md'),
      '/tmp/linked.md'
    ]))
  })

  it('detects bare markdown path tokens with percent-encoding and ignorable query/fragment suffixes', () => {
    const references = readMarkdownPathReferences(
      'Read ./docs/My%20Guide.md?raw=1#intro and /tmp/Other%20Guide.md#present.',
      'states/klaatu.md'
    )

    expect([...references]).toEqual(expect.arrayContaining([
      'docs/My Guide.md',
      'states/docs/My Guide.md',
      '/tmp/Other Guide.md'
    ]))
  })

  it('detects markdown path references with uppercase .MD extensions', () => {
    const references = readMarkdownPathReferences(
      'Read ./docs/Guide.MD, `/tmp/Proof.MD`, and [manual](./docs/Manual.MD).',
      'states/klaatu.md'
    )

    expect([...references]).toEqual(expect.arrayContaining([
      'docs/Guide.MD',
      'states/docs/Guide.MD',
      '/tmp/Proof.MD',
      'docs/Manual.MD',
      'states/docs/Manual.MD'
    ]))
  })

  it('can exclude image-only markdown path references from path extraction', () => {
    const references = readMarkdownPathReferences(
      'Read ![guide](./docs/guide.md) and [manual](./docs/manual.md).',
      'states/klaatu.md',
      { includeImages: false }
    )

    expect([...references]).toEqual(expect.arrayContaining([
      'docs/manual.md',
      'states/docs/manual.md'
    ]))
    expect([...references]).not.toEqual(expect.arrayContaining([
      'docs/guide.md',
      'states/docs/guide.md'
    ]))
  })

  it('resolves absolute filesystem paths without rebasing them to repo root', () => {
    const resolved = resolveMarkdownLink('/repo/README.md', '/tmp/proof.txt', '/repo')
    expect(resolved.targetFile).toBe('/tmp/proof.txt')
  })

  it('expands home-directory markdown links that start with ~/', () => {
    const resolved = resolveMarkdownLink('/repo/README.md', '~/proof.txt', '/repo')
    expect(resolved.targetFile).toBe(path.join(os.homedir(), 'proof.txt'))
  })

  it('resolves file:// urls as local filesystem paths', () => {
    const resolved = resolveMarkdownLink('/repo/README.md', 'file:///tmp/proof.txt', '/repo')
    expect(resolved.targetFile).toBe('/tmp/proof.txt')
  })

  it('decodes percent-encoded local markdown paths before resolving them', () => {
    const resolved = resolveMarkdownLink('/repo/README.md', './docs/My%20Guide.md', '/repo')
    expect(resolved.targetFile).toBe('/repo/docs/My Guide.md')
  })

  it('leaves malformed percent-encoding in fragments untouched instead of throwing', () => {
    const resolved = resolveMarkdownLink('/repo/README.md', './docs/reference.md#bad%ZZslug', '/repo')
    expect(resolved.fragment).toBe('bad%ZZslug')
  })
})

describe('compareFindings', () => {
  it('treats two undefined line values as equal and falls back to rule ordering', () => {
    const findings = [
      {
        ruleId: 'ZZZ999',
        severity: 'error' as const,
        filePath: 'README.md',
        message: 'later',
        evidence: 'b'
      },
      {
        ruleId: 'AAA001',
        severity: 'error' as const,
        filePath: 'README.md',
        message: 'earlier',
        evidence: 'a'
      }
    ]

    expect([...findings].sort(compareFindings).map((finding) => finding.ruleId)).toEqual([
      'AAA001',
      'ZZZ999'
    ])
  })

  it('orders same-line findings by column before rule id', () => {
    const findings = [
      {
        ruleId: 'ZZZ999',
        severity: 'error' as const,
        filePath: 'README.md',
        line: 4,
        column: 9,
        message: 'later',
        evidence: 'b'
      },
      {
        ruleId: 'AAA001',
        severity: 'error' as const,
        filePath: 'README.md',
        line: 4,
        column: 3,
        message: 'earlier',
        evidence: 'a'
      }
    ]

    expect([...findings].sort(compareFindings).map((finding) => finding.column)).toEqual([3, 9])
  })
})

describe('parseGitDiff', () => {
  it('tracks added and removed line numbers from unified diff hunks', () => {
    const diff = parseGitDiff([
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -4,2 +4,3 @@',
      ' context',
      '-old line',
      '+new line',
      '+extra line'
    ].join('\n'))

    expect(diff.get('README.md')?.removedLines).toEqual([{ text: 'old line', line: 5 }])
    expect(diff.get('README.md')?.addedLines).toEqual([
      { text: 'new line', line: 5 },
      { text: 'extra line', line: 6 }
    ])
  })

  it('merges repeated diff sections for the same file instead of overwriting earlier hunks', () => {
    const diff = parseGitDiff([
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '-first old',
      '+first new',
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -10 +10 @@',
      '-second old',
      '+second new'
    ].join('\n'))

    expect(diff.get('README.md')?.removedLines).toEqual([
      { text: 'first old', line: 1 },
      { text: 'second old', line: 10 }
    ])
    expect(diff.get('README.md')?.addedLines).toEqual([
      { text: 'first new', line: 1 },
      { text: 'second new', line: 10 }
    ])
  })

  it('parses diff headers for files whose paths contain spaces', () => {
    const diff = parseGitDiff([
      'diff --git a/docs/My Guide.md b/docs/My Guide.md',
      '--- a/docs/My Guide.md',
      '+++ b/docs/My Guide.md',
      '@@ -0,0 +1 @@',
      '+Do not pause'
    ].join('\n'))

    expect(diff.get('docs/My Guide.md')?.addedLines).toEqual([
      { text: 'Do not pause', line: 1 }
    ])
  })
})

describe('loadConfig', () => {
  it('loads a valid config file', async () => {
    const repoRoot = await makeRepo()
    await writeJson(path.join(repoRoot, 'agent-instruction-lint.json'), {
      instructionModel: { name: 'codex-like' },
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    })

    const config = await loadConfig(repoRoot)
    expect(config.instructionModel?.name).toBe('codex-like')
    expect(config.citation?.log).toBe('gort.citations.md')
  })

  it('accepts standard $schema metadata in config files', async () => {
    const repoRoot = await makeRepo()
    await writeJson(path.join(repoRoot, 'agent-instruction-lint.json'), {
      $schema: './agent-instruction-lint.schema.json',
      roles: {
        supportingDocs: ['README.md']
      }
    })

    const config = await loadConfig(repoRoot)
    expect(config.$schema).toBe('./agent-instruction-lint.schema.json')
    expect(config.roles?.supportingDocs).toEqual(['README.md'])
  })

  it('reports a clear error when the config file is missing', async () => {
    const repoRoot = await makeRepo()

    await expect(loadConfig(repoRoot)).rejects.toThrow(
      `Config file not found: ${path.join(repoRoot, 'agent-instruction-lint.json')}`
    )
  })

  it('reports a clear error when the config file contains invalid json', async () => {
    const repoRoot = await makeRepo()
    await writeFile(path.join(repoRoot, 'agent-instruction-lint.json'), '{\n  invalid\n')

    await expect(loadConfig(repoRoot)).rejects.toThrow(
      `Invalid JSON in config at ${path.join(repoRoot, 'agent-instruction-lint.json')}`
    )
  })
})

describe('LINK001', () => {
  it('flags missing local file links', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      instructionModel: { name: 'codex-like' },
      roles: { supportingDocs: ['README.md'] }
    }

    await writeJson(path.join(repoRoot, 'agent-instruction-lint.json'), config)
    await writeFile(
      path.join(repoRoot, 'README.md'),
      '# Test\n\nSee [missing](./docs/missing.md).\n'
    )

    const findings = await lintRepository({ repoRoot })
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'LINK001', filePath: 'README.md', line: 3, column: 5 })
      ])
    )
  })

  it('sorts findings within a file by line before rule id when lintRepository aggregates results', async () => {
    const repoRoot = await makeRepo()
    await writeJson(path.join(repoRoot, 'agent-instruction-lint.json'), {
      roles: { supportingDocs: ['README.md'] },
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md',
        entryDocs: ['README.md']
      }
    })
    await writeFile(path.join(repoRoot, 'README.md'), 'See [missing](./docs/missing.md).\n')

    const findings = await lintRepository({ repoRoot, diffText: '' })
    expect(findings.filter((finding) => finding.filePath === 'README.md').map((finding) => finding.ruleId)).toEqual([
      'LINK001',
      'CITE005'
    ])
  })

  it('flags missing heading fragments', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      instructionModel: { name: 'codex-like' },
      roles: { supportingDocs: ['README.md', 'docs/reference.md'] }
    }

    await writeJson(path.join(repoRoot, 'agent-instruction-lint.json'), config)
    await mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await writeFile(path.join(repoRoot, 'README.md'), 'See [ref](./docs/reference.md#missing-heading).\n')
    await writeFile(path.join(repoRoot, 'docs/reference.md'), '# Present Heading\n')

    const findings = await lintRepository({ repoRoot })
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'LINK001', filePath: 'README.md', line: 1, column: 5 })
      ])
    )
  })

  it('flags malformed fragment encodings as unresolved fragments instead of crashing', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      instructionModel: { name: 'codex-like' },
      roles: { supportingDocs: ['README.md', 'docs/reference.md'] }
    }

    await writeJson(path.join(repoRoot, 'agent-instruction-lint.json'), config)
    await mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await writeFile(path.join(repoRoot, 'README.md'), 'See [ref](./docs/reference.md#bad%ZZslug).\n')
    await writeFile(path.join(repoRoot, 'docs/reference.md'), '# Present Heading\n')

    const findings = await lintRepository({ repoRoot })
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'LINK001', filePath: 'README.md', line: 1, column: 5 })
      ])
    )
  })

  it('flags missing local markdown image targets', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      instructionModel: { name: 'codex-like' },
      roles: { supportingDocs: ['README.md'] }
    }

    await writeJson(path.join(repoRoot, 'agent-instruction-lint.json'), config)
    await writeFile(path.join(repoRoot, 'README.md'), '![proof](./artifacts/proof.png)\n')

    const findings = await lintRepository({ repoRoot })
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'LINK001', filePath: 'README.md', line: 1, column: 1 })
      ])
    )
  })

  it('accepts existing absolute filesystem links without rebasing them to repo root', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      instructionModel: { name: 'codex-like' },
      roles: { supportingDocs: ['README.md'] }
    }
    const proofDir = await makeRepo()
    const proofPath = path.join(proofDir, 'proof.txt')

    await writeJson(path.join(repoRoot, 'agent-instruction-lint.json'), config)
    await writeFile(proofPath, 'ok\n')
    await access(proofPath)
    await writeFile(path.join(repoRoot, 'README.md'), `[proof](${proofPath})\n`)

    const findings = await lintRepository({ repoRoot })
    expect(findings.filter((finding) => finding.ruleId === 'LINK001')).toHaveLength(0)
  })

  it('accepts existing file:// local links', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      instructionModel: { name: 'codex-like' },
      roles: { supportingDocs: ['README.md'] }
    }
    const proofDir = await makeRepo()
    const proofPath = path.join(proofDir, 'proof.txt')
    const proofUrl = `file://${proofPath}`

    await writeJson(path.join(repoRoot, 'agent-instruction-lint.json'), config)
    await writeFile(proofPath, 'ok\n')
    await writeFile(path.join(repoRoot, 'README.md'), `[proof](${proofUrl})\n`)

    const findings = await lintRepository({ repoRoot })
    expect(findings.filter((finding) => finding.ruleId === 'LINK001')).toHaveLength(0)
  })

  it('accepts percent-encoded local markdown links that resolve to existing files', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      instructionModel: { name: 'codex-like' },
      roles: { supportingDocs: ['README.md', 'docs/My Guide.md'] }
    }

    await writeJson(path.join(repoRoot, 'agent-instruction-lint.json'), config)
    await mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await writeFile(path.join(repoRoot, 'docs/My Guide.md'), '# Present\n')
    await writeFile(path.join(repoRoot, 'README.md'), '[guide](./docs/My%20Guide.md)\n')

    const findings = await lintRepository({ repoRoot })
    expect(findings.filter((finding) => finding.ruleId === 'LINK001')).toHaveLength(0)
  })

  it('accepts local markdown links whose query string should be ignored for file resolution', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      instructionModel: { name: 'codex-like' },
      roles: { supportingDocs: ['README.md', 'docs/reference.md'] }
    }

    await writeJson(path.join(repoRoot, 'agent-instruction-lint.json'), config)
    await mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await writeFile(path.join(repoRoot, 'docs/reference.md'), '# Present\n')
    await writeFile(path.join(repoRoot, 'README.md'), '[ref](./docs/reference.md?raw=1#present)\n')

    const findings = await lintRepository({ repoRoot })
    expect(findings.filter((finding) => finding.ruleId === 'LINK001')).toHaveLength(0)
  })

  it('resolves reference-style local markdown links through definitions', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      instructionModel: { name: 'codex-like' },
      roles: { supportingDocs: ['README.md', 'docs/reference.md'] }
    }

    await writeJson(path.join(repoRoot, 'agent-instruction-lint.json'), config)
    await mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await writeFile(path.join(repoRoot, 'README.md'), [
      'See [reference][guide].',
      '',
      '[guide]: ./docs/reference.md'
    ].join('\n'))
    await writeFile(path.join(repoRoot, 'docs/reference.md'), '# Present\n')

    const findings = await lintRepository({ repoRoot })
    expect(findings.filter((finding) => finding.ruleId === 'LINK001')).toHaveLength(0)
  })
})

describe('CITE001', () => {
  it('flags missing citation-log updates for behavioral diffs', () => {
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    const diffText = [
      'diff --git a/gort.md b/gort.md',
      '--- a/gort.md',
      '+++ b/gort.md',
      '@@ -1 +1 @@',
      '-Do not pause',
      '+Do not pause and always continue'
    ].join('\n')

    const findings = runCite001(config, diffText)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('CITE001')
    expect(findings[0]?.line).toBe(1)
  })

  it('does not flag when the citation log also changes', () => {
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    const diffText = [
      'diff --git a/gort.md b/gort.md',
      '--- a/gort.md',
      '+++ b/gort.md',
      '@@ -1 +1 @@',
      '-Do not pause',
      '+Do not pause and always continue',
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1 @@',
      '+## 2026-04-16 — update'
    ].join('\n')

    expect(runCite001(config, diffText)).toHaveLength(0)
  })

  it('uses removed-line positions when the behavioral change only appears in removals', () => {
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    const diffText = [
      'diff --git a/gort.md b/gort.md',
      '--- a/gort.md',
      '+++ b/gort.md',
      '@@ -12,2 +12 @@',
      '-Do not pause',
      '-Background note',
      '+Background note'
    ].join('\n')

    const findings = runCite001(config, diffText)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('CITE001')
    expect(findings[0]?.line).toBe(12)
    expect(findings[0]?.evidence).toBe('Do not pause')
  })
})

describe('CITE002', () => {
  it('requires changed protected files to be named in the citation entry', () => {
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md', 'states/*.md'],
        log: 'gort.citations.md'
      }
    }

    const diffText = [
      'diff --git a/gort.md b/gort.md',
      '--- a/gort.md',
      '+++ b/gort.md',
      '@@ -1 +1 @@',
      '+Do not pause and always continue',
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,3 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Updated files: [`./states/klaatu.md`](./states/klaatu.md)'
    ].join('\n')

    const findings = runCite002(config, diffText)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('CITE002')
    expect(findings[0]?.line).toBe(1)
  })

  it('does not count substring lookalikes such as gort.md.bak as protected-file mentions', () => {
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    const diffText = [
      'diff --git a/gort.md b/gort.md',
      '--- a/gort.md',
      '+++ b/gort.md',
      '@@ -1 +1 @@',
      '+Do not pause and always continue',
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,4 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Historical note: `gort.md.bak`',
      '+### Why this evidence supports the repair'
    ].join('\n')

    const findings = runCite002(config, diffText)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('CITE002')
  })

  it('passes when changed protected files are named in the citation entry', () => {
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    const diffText = [
      'diff --git a/gort.md b/gort.md',
      '--- a/gort.md',
      '+++ b/gort.md',
      '@@ -1 +1 @@',
      '+Do not pause and always continue',
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,4 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Updated files: [`./gort.md`](./gort.md)',
      '+### Why this evidence supports the repair'
    ].join('\n')

    expect(runCite002(config, diffText)).toHaveLength(0)
  })

  it('accepts reference-style links that resolve to changed protected files', () => {
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    const diffText = [
      'diff --git a/gort.md b/gort.md',
      '--- a/gort.md',
      '+++ b/gort.md',
      '@@ -1 +1 @@',
      '+Do not pause and always continue',
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,6 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Updated files: [controller][protected]',
      '+',
      '+[protected]: ./gort.md',
      '+### Why this evidence supports the repair'
    ].join('\n')

    expect(runCite002(config, diffText)).toHaveLength(0)
  })

  it('does not count markdown images that point at protected files as citation mentions', () => {
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    const diffText = [
      'diff --git a/gort.md b/gort.md',
      '--- a/gort.md',
      '+++ b/gort.md',
      '@@ -1 +1 @@',
      '+Do not pause and always continue',
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,4 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Screenshot: ![controller](./gort.md)',
      '+### Why this evidence supports the repair'
    ].join('\n')

    const findings = runCite002(config, diffText)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('CITE002')
  })

  it('accepts bare protected-file mentions with ignorable query and fragment suffixes', () => {
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    const diffText = [
      'diff --git a/gort.md b/gort.md',
      '--- a/gort.md',
      '+++ b/gort.md',
      '@@ -1 +1 @@',
      '+Do not pause and always continue',
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,4 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Updated files: ./gort.md?raw=1#intro',
      '+### Why this evidence supports the repair'
    ].join('\n')

    expect(runCite002(config, diffText)).toHaveLength(0)
  })

  it('accepts protected-file mentions with uppercase .MD extensions', () => {
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.MD'],
        log: 'gort.citations.md'
      }
    }

    const diffText = [
      'diff --git a/gort.MD b/gort.MD',
      '--- a/gort.MD',
      '+++ b/gort.MD',
      '@@ -1 +1 @@',
      '+Do not pause and always continue',
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,4 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Updated files: ./gort.MD',
      '+### Why this evidence supports the repair'
    ].join('\n')

    expect(runCite002(config, diffText)).toHaveLength(0)
  })

  it('reports the first added citation-log line when no new entry heading exists', () => {
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    const diffText = [
      'diff --git a/gort.md b/gort.md',
      '--- a/gort.md',
      '+++ b/gort.md',
      '@@ -1 +1 @@',
      '+Do not pause and always continue',
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -10 +10,2 @@',
      '+Intro note about the citation log',
      '+Still no entry heading'
    ].join('\n')

    const findings = runCite002(config, diffText)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('CITE002')
    expect(findings[0]?.line).toBe(10)
  })
})

describe('extractAddedCitationEntryBlocks', () => {
  it('splits added citation blocks across non-contiguous hunks', () => {
    const blocks = extractAddedCitationEntryBlocks([
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,2 @@',
      '+## 2026-04-16 — first update',
      '+### Local evidence',
      '@@ -20 +20,2 @@',
      '+## 2026-04-17 — second update',
      '+### Local evidence'
    ].join('\n'), 'gort.citations.md')

    expect(blocks).toEqual([
      { text: '## 2026-04-16 — first update\n### Local evidence', startLine: 1 },
      { text: '## 2026-04-17 — second update\n### Local evidence', startLine: 20 }
    ])
  })

  it('ignores added preamble lines until the first entry heading', () => {
    const blocks = extractAddedCitationEntryBlocks([
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,4 @@',
      '+Intro note about the citation log',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Updated files: [`./gort.md`](./gort.md)'
    ].join('\n'), 'gort.citations.md')

    expect(blocks).toEqual([
      {
        text: '## 2026-04-16 — update\n### Local evidence\n- Updated files: [`./gort.md`](./gort.md)',
        startLine: 2
      }
    ])
  })

  it('recognizes setext h2 citation entry headings', () => {
    const blocks = extractAddedCitationEntryBlocks([
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -10 +10,4 @@',
      '+2026-04-16 — update',
      '+-------------------',
      '+### Local evidence',
      '+- Updated files: [`./gort.md`](./gort.md)'
    ].join('\n'), 'gort.citations.md')

    expect(blocks).toEqual([
      {
        text: '2026-04-16 — update\n-------------------\n### Local evidence\n- Updated files: [`./gort.md`](./gort.md)',
        startLine: 10
      }
    ])
  })
})

describe('CITE003', () => {
  it('accepts configurable citation marker groups', () => {
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md',
        requiredMarkers: {
          localEvidence: ['Local evidence'],
          updatedFiles: ['Updated files'],
          rationale: ['Why this evidence supports', 'Why these sources support']
        }
      }
    }

    const diffText = [
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,5 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Updated files: [`./gort.md`](./gort.md)',
      '+### Why these sources support the repair',
      '+- rationale'
    ].join('\n')

    expect(runCite003(config, diffText)).toHaveLength(0)
  })

  it('reports the added citation-entry heading line when required markers are missing', () => {
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md',
        requiredMarkers: {
          localEvidence: ['Local evidence'],
          updatedFiles: ['Updated files'],
          rationale: ['Why this evidence supports']
        }
      }
    }

    const diffText = [
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -10 +10,3 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Updated files: [`./gort.md`](./gort.md)'
    ].join('\n')

    const findings = runCite003(config, diffText)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('CITE003')
    expect(findings[0]?.line).toBe(10)
  })

  it('uses the setext heading line as the citation-entry start when required markers are missing', () => {
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md',
        requiredMarkers: {
          localEvidence: ['Local evidence'],
          updatedFiles: ['Updated files'],
          rationale: ['Why this evidence supports']
        }
      }
    }

    const diffText = [
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -20 +20,4 @@',
      '+2026-04-16 — update',
      '+-------------------',
      '+### Local evidence',
      '+- Updated files: [`./gort.md`](./gort.md)'
    ].join('\n')

    const findings = runCite003(config, diffText)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('CITE003')
    expect(findings[0]?.line).toBe(20)
  })
})

describe('CITE004', () => {
  it('flags missing local evidence links added to citation entries', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    await writeFile(path.join(repoRoot, 'gort.citations.md'), '# Citation log\n')

    const diffText = [
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,4 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Screenshot: [missing](./artifacts/missing.png)',
      '+### Why this evidence supports the repair'
    ].join('\n')

    const findings = await runCite004(repoRoot, config, diffText)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('CITE004')
    expect(findings[0]?.line).toBe(3)
    expect(findings[0]?.column).toBe(15)
    expect(findings[0]?.evidence).toBe('- Screenshot: [missing](./artifacts/missing.png)')
  })

  it('flags missing local evidence links inside setext-h2 citation entries', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    await writeFile(path.join(repoRoot, 'gort.citations.md'), '# Citation log\n')

    const diffText = [
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -10 +10,5 @@',
      '+2026-04-16 — update',
      '+-------------------',
      '+### Local evidence',
      '+- Screenshot: [missing](./artifacts/missing.png)',
      '+### Why this evidence supports the repair'
    ].join('\n')

    const findings = await runCite004(repoRoot, config, diffText)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('CITE004')
    expect(findings[0]?.line).toBe(13)
    expect(findings[0]?.column).toBe(15)
  })

  it('accepts existing local evidence links and ignores external links', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    await mkdir(path.join(repoRoot, 'artifacts'), { recursive: true })
    await mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await writeFile(path.join(repoRoot, 'gort.citations.md'), '# Citation log\n')
    await writeFile(path.join(repoRoot, 'artifacts/proof.txt'), 'ok\n')
    await writeFile(path.join(repoRoot, 'artifacts/proof.png'), 'png\n')
    await writeFile(path.join(repoRoot, 'docs/reference.md'), '# Present Heading\n')

    const diffText = [
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,7 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Artifact: [proof](./artifacts/proof.txt)',
      '+- Screenshot: ![proof](./artifacts/proof.png)',
      '+- Section proof: [reference](./docs/reference.md#present-heading)',
      '+- Upstream issue: [tracker](https://example.com/ticket)',
      '+### Why this evidence supports the repair'
    ].join('\n')

    await expect(runCite004(repoRoot, config, diffText)).resolves.toHaveLength(0)
  })

  it('flags missing reference-style local evidence links added to citation entries', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    await writeFile(path.join(repoRoot, 'gort.citations.md'), '# Citation log\n')

    const diffText = [
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,6 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Screenshot: [missing][artifact]',
      '+',
      '+[artifact]: ./artifacts/missing.png',
      '+### Why this evidence supports the repair'
    ].join('\n')

    const findings = await runCite004(repoRoot, config, diffText)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toEqual(expect.objectContaining({
      ruleId: 'CITE004',
      filePath: 'gort.citations.md',
      line: 3,
      column: 15,
      evidence: '- Screenshot: [missing][artifact]'
    }))
  })

  it('flags missing markdown evidence fragments added to citation entries', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    await mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await writeFile(path.join(repoRoot, 'gort.citations.md'), '# Citation log\n')
    await writeFile(path.join(repoRoot, 'docs/reference.md'), '# Present Heading\n')

    const diffText = [
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,4 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Section proof: [reference](./docs/reference.md#missing-heading)',
      '+### Why this evidence supports the repair'
    ].join('\n')

    const findings = await runCite004(repoRoot, config, diffText)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toEqual(expect.objectContaining({
      ruleId: 'CITE004',
      filePath: 'gort.citations.md',
      line: 3,
      column: 18,
      message: 'Citation entry contains a markdown evidence fragment that does not resolve: ./docs/reference.md#missing-heading'
    }))
  })

  it('flags malformed evidence fragment encodings as unresolved fragments instead of crashing', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    await mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await writeFile(path.join(repoRoot, 'gort.citations.md'), '# Citation log\n')
    await writeFile(path.join(repoRoot, 'docs/reference.md'), '# Present Heading\n')

    const diffText = [
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,4 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Section proof: [reference](./docs/reference.md#bad%ZZslug)',
      '+### Why this evidence supports the repair'
    ].join('\n')

    const findings = await runCite004(repoRoot, config, diffText)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toEqual(expect.objectContaining({
      ruleId: 'CITE004',
      filePath: 'gort.citations.md',
      line: 3,
      column: 18,
      message: 'Citation entry contains a markdown evidence fragment that does not resolve: ./docs/reference.md#bad%ZZslug'
    }))
  })

  it('accepts existing absolute filesystem evidence links', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }
    const proofDir = await makeRepo()
    const proofPath = path.join(proofDir, 'proof.txt')

    await writeFile(path.join(repoRoot, 'gort.citations.md'), '# Citation log\n')
    await writeFile(proofPath, 'ok\n')
    await access(proofPath)

    const diffText = [
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,4 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      `+- Artifact: [proof](${proofPath})`,
      '+### Why this evidence supports the repair'
    ].join('\n')

    await expect(runCite004(repoRoot, config, diffText)).resolves.toHaveLength(0)
  })

  it('accepts existing file:// local evidence links', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }
    const proofDir = await makeRepo()
    const proofPath = path.join(proofDir, 'proof.txt')
    const proofUrl = `file://${proofPath}`

    await writeFile(path.join(repoRoot, 'gort.citations.md'), '# Citation log\n')
    await writeFile(proofPath, 'ok\n')

    const diffText = [
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,4 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      `+- Artifact: [proof](${proofUrl})`,
      '+### Why this evidence supports the repair'
    ].join('\n')

    await expect(runCite004(repoRoot, config, diffText)).resolves.toHaveLength(0)
  })

  it('accepts percent-encoded local evidence links that resolve to existing files', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    await mkdir(path.join(repoRoot, 'artifacts'), { recursive: true })
    await writeFile(path.join(repoRoot, 'gort.citations.md'), '# Citation log\n')
    await writeFile(path.join(repoRoot, 'artifacts/Proof File.txt'), 'ok\n')

    const diffText = [
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,4 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Artifact: [proof](./artifacts/Proof%20File.txt)',
      '+### Why this evidence supports the repair'
    ].join('\n')

    await expect(runCite004(repoRoot, config, diffText)).resolves.toHaveLength(0)
  })

  it('accepts local markdown evidence links whose query string should be ignored for file and fragment resolution', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }

    await mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await writeFile(path.join(repoRoot, 'gort.citations.md'), '# Citation log\n')
    await writeFile(path.join(repoRoot, 'docs/reference.md'), '# Present Heading\n')

    const diffText = [
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,4 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Section proof: [reference](./docs/reference.md?raw=1#present-heading)',
      '+### Why this evidence supports the repair'
    ].join('\n')

    await expect(runCite004(repoRoot, config, diffText)).resolves.toHaveLength(0)
  })
})

describe('lintRepository citation integration', () => {
  it('includes CITE004 findings when linting with diff text', async () => {
    const repoRoot = await makeRepo()
    await writeJson(path.join(repoRoot, 'agent-instruction-lint.json'), {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    })
    await writeFile(path.join(repoRoot, 'gort.citations.md'), '# Citation log\n')

    const diffText = [
      'diff --git a/gort.citations.md b/gort.citations.md',
      '--- a/gort.citations.md',
      '+++ b/gort.citations.md',
      '@@ -1 +1,4 @@',
      '+## 2026-04-16 — update',
      '+### Local evidence',
      '+- Screenshot: [missing](./artifacts/missing.png)',
      '+### Why this evidence supports the repair'
    ].join('\n')

    const findings = await lintRepository({ repoRoot, diffText })
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'CITE004', filePath: 'gort.citations.md' })
      ])
    )
  })
})

describe('PHRASE001', () => {
  it('flags forbidden emitted phrase forms in markdown diffs', () => {
    const config: AgentInstructionLintConfig = {
      phrases: {
        canonical: [
          {
            value: 'KLAATU BERADA NIKTO',
            recognizedVariants: ['Klatu Berata Nicto'],
            forbiddenEmittedForms: ['Gort mode', 'KLAATU BARATA NIKTO']
          }
        ]
      }
    }

    const diffText = [
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '+Use Gort mode to enter the controller.'
    ].join('\n')

    const findings = runPhrase001(config, diffText)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('PHRASE001')
    expect(findings[0]?.line).toBe(1)
    expect(findings[0]?.column).toBe(5)
  })

  it('does not flag the canonical emitted phrase', () => {
    const config: AgentInstructionLintConfig = {
      phrases: {
        canonical: [
          {
            value: 'KLAATU BERADA NIKTO',
            forbiddenEmittedForms: ['KLAATU BARATA NIKTO']
          }
        ]
      }
    }

    const diffText = [
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '+Use KLAATU BERADA NIKTO to enter the controller.'
    ].join('\n')

    expect(runPhrase001(config, diffText)).toHaveLength(0)
  })

  it('does not flag forbidden-phrase lookalikes embedded inside larger tokens', () => {
    const config: AgentInstructionLintConfig = {
      phrases: {
        canonical: [
          {
            value: 'KLAATU BERADA NIKTO',
            forbiddenEmittedForms: ['Gort mode']
          }
        ]
      }
    }

    const diffText = [
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1,2 @@',
      '+Legacy helper slug: legacy-Gort mode-helper',
      '+Plural note: Gort modes remain unsupported'
    ].join('\n')

    expect(runPhrase001(config, diffText)).toHaveLength(0)
  })
})

describe('TOPO001', () => {
  it('flags duplicate authority claims across controller files', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), 'This is the canonical controller entrypoint.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), 'This is the authoritative root file.\n')

    const findings = await runTopo001(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('TOPO001')
    expect(findings[0]?.line).toBe(1)
  })

  it('does not flag when precedence markers resolve the authority relation', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), 'This is the canonical controller entrypoint.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), 'This is the authoritative root file and the other document is only as a fallback.\n')

    const findings = await runTopo001(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('still flags when precedence language exists elsewhere in the file but not near the authority claim', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), 'This is the canonical controller entrypoint.\n')
    await writeFile(
      path.join(repoRoot, 'gort.md'),
      ['This is the authoritative root file.', '', 'Use README.md only as a fallback when no more specific file exists.'].join('\n') + '\n'
    )

    const findings = await runTopo001(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('TOPO001')
  })

  it('does not treat authority markers inside fenced code blocks as active claims', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), 'This is the canonical controller entrypoint.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), '```md\nThis is the authoritative root file.\n```\n')

    const findings = await runTopo001(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('does not let fenced-code fallback markers suppress active authority conflicts', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), 'This is the canonical controller entrypoint.\n')
    await writeFile(
      path.join(repoRoot, 'gort.md'),
      ['This is the authoritative root file.', '```md', 'Use README.md only as a fallback when no more specific file exists.', '```'].join('\n') + '\n'
    )

    const findings = await runTopo001(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('TOPO001')
  })

  it('does not treat tilde-fenced code blocks as active claims', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), 'This is the canonical controller entrypoint.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), '~~~md\nThis is the authoritative root file.\n~~~\n')

    const findings = await runTopo001(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('does not treat indented code blocks as active claims', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), 'This is the canonical controller entrypoint.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), '    This is the authoritative root file.\n')

    const findings = await runTopo001(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('flags broad and explicitly scoped authority claims as potentially overlapping', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), 'This is the canonical controller entrypoint.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), '## Codex\nThis is the authoritative root file.\n')

    const findings = await runTopo001(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('TOPO001')
  })

  it('does not flag authority claims scoped to different explicit startup surfaces', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), '## Codex\nThis is the canonical controller entrypoint.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), '## Zeph\nThis is the authoritative root file.\n')

    const findings = await runTopo001(repoRoot, config)
    expect(findings).toHaveLength(0)
  })
})

describe('TOPO002', () => {
  it('flags conflicting precedence claims across controller files', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), 'AGENTS.md wins on conflict.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), 'gort.md takes precedence over all other files.\n')

    const findings = await runTopo002(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('TOPO002')
  })

  it('does not flag when only one file defines precedence-winning behavior', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), 'AGENTS.md wins on conflict.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), 'This is the canonical controller entrypoint.\n')

    const findings = await runTopo002(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('does not flag precedence claims scoped to different providers', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), '## Codex\nAGENTS.md wins on conflict.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), '## Zeph\ngort.md takes precedence over all other files.\n')

    const findings = await runTopo002(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('does not flag precedence claims scoped to different tools via structured headings', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), '## Tool: bash\nAGENTS.md wins on conflict.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), '## Tool: web_search\ngort.md takes precedence over all other files.\n')

    const findings = await runTopo002(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('uses parsed markdown headings for scope context, including setext headings', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), 'Codex\n=====\nAGENTS.md wins on conflict.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), 'Zeph\n====\ngort.md takes precedence over all other files.\n')

    const findings = await runTopo002(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('uses active heading ancestry instead of leaking sibling heading scope markers', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), '## Tool: bash\nShared shell notes\n## Zeph\nAGENTS.md wins on conflict.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), '## Tool: bash\ngort.md takes precedence over all other files.\n')

    const findings = await runTopo002(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('does not flag precedence claims scoped to different providers via structured headings', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), '## Provider: openai\nAGENTS.md wins on conflict.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), '## Provider: ollama\ngort.md takes precedence over all other files.\n')

    const findings = await runTopo002(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('flags broad and explicitly scoped precedence claims as potentially overlapping', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['AGENTS.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'AGENTS.md'), 'AGENTS.md wins on conflict.\n')
    await writeFile(path.join(repoRoot, 'gort.md'), '## Codex\ngort.md takes precedence over all other files.\n')

    const findings = await runTopo002(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('TOPO002')
  })
})

describe('TOPO003', () => {
  it('flags exact normalized normative duplicates from root to scoped controllers', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        scopedControllers: ['states/klaatu.md']
      }
    }

    await mkdir(path.join(repoRoot, 'states'), { recursive: true })
    await writeFile(path.join(repoRoot, 'gort.md'), '- Do not pause between steps.\n')
    await writeFile(path.join(repoRoot, 'states/klaatu.md'), '1. Do not pause between steps\n')

    const findings = await runTopo003(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('TOPO003')
  })

  it('does not flag non-normative duplicates or code-fence duplicates', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        scopedControllers: ['states/klaatu.md']
      }
    }

    await mkdir(path.join(repoRoot, 'states'), { recursive: true })
    await writeFile(path.join(repoRoot, 'gort.md'), 'Controller overview\n```\nDo not pause between steps\n```\n')
    await writeFile(path.join(repoRoot, 'states/klaatu.md'), 'Controller overview\n')

    const findings = await runTopo003(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('does not flag exact duplicates that exist only across disjoint explicit scopes', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        scopedControllers: ['states/klaatu.md']
      }
    }

    await mkdir(path.join(repoRoot, 'states'), { recursive: true })
    await writeFile(path.join(repoRoot, 'gort.md'), '## Codex\n- Do not pause between steps.\n')
    await writeFile(path.join(repoRoot, 'states/klaatu.md'), '## Zeph\n1. Do not pause between steps\n')

    const findings = await runTopo003(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('flags exact duplicates when one side is broad and the other is explicitly scoped', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        scopedControllers: ['states/klaatu.md']
      }
    }

    await mkdir(path.join(repoRoot, 'states'), { recursive: true })
    await writeFile(path.join(repoRoot, 'gort.md'), '- Do not pause between steps.\n')
    await writeFile(path.join(repoRoot, 'states/klaatu.md'), '## Codex\n1. Do not pause between steps\n')

    const findings = await runTopo003(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('TOPO003')
  })
})

describe('BOOT001', () => {
  it('flags bootstrap read-order cycles across instruction files', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), 'Read README.md and follow the instructions.\n')
    await writeFile(path.join(repoRoot, 'README.md'), 'Start with gort.md.\n')

    const findings = await runBoot001(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('BOOT001')
    expect(findings[0]?.line).toBe(1)
  })

  it('does not flag an acyclic read-order chain', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md'],
        supportingDocs: ['docs/reference.md']
      }
    }

    await mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await writeFile(path.join(repoRoot, 'gort.md'), 'Read README.md and follow the instructions.\n')
    await writeFile(path.join(repoRoot, 'README.md'), 'Read docs/reference.md next.\n')
    await writeFile(path.join(repoRoot, 'docs/reference.md'), '# Reference\n')

    const findings = await runBoot001(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('detects cycles through explicit markdown links and ignores substring lookalikes', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md'],
        supportingDocs: ['docs/reference.md']
      }
    }

    await mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await writeFile(path.join(repoRoot, 'gort.md'), 'Read [guide](README.md).\n')
    await writeFile(path.join(repoRoot, 'README.md'), 'Load `docs/reference.md` next.\n')
    await writeFile(path.join(repoRoot, 'docs/reference.md'), 'Follow gort.md.bak for a historical example, not the real controller.\nStart with ../gort.md.\n')

    const findings = await runBoot001(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('BOOT001')
    expect(findings[0]?.evidence).toContain('docs/reference.md:2 -> gort.md')
  })

  it('detects markdown links with titles via parser-backed inline reference extraction', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), 'Read [guide](README.md "operator guide").\n')
    await writeFile(path.join(repoRoot, 'README.md'), 'Start with gort.md.\n')

    const findings = await runBoot001(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('BOOT001')
  })

  it('detects bare bootstrap path tokens with ignorable query strings', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), 'Read README.md?raw=1 and follow the instructions.\n')
    await writeFile(path.join(repoRoot, 'README.md'), 'Start with gort.md?view=plain.\n')

    const findings = await runBoot001(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('BOOT001')
  })

  it('detects reference-style markdown links via parser-backed document extraction', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), [
      'Read [guide][readme].',
      '',
      '[readme]: ./README.md'
    ].join('\n'))
    await writeFile(path.join(repoRoot, 'README.md'), [
      'Start with [root][gort].',
      '',
      '[gort]: ./gort.md'
    ].join('\n'))

    const findings = await runBoot001(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('BOOT001')
  })

  it('does not create bootstrap edges from markdown images that happen to target controller files', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), 'Read ![guide](README.md).\n')
    await writeFile(path.join(repoRoot, 'README.md'), 'Start with gort.md.\n')

    const findings = await runBoot001(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('does not create bootstrap edges from fenced code examples', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), 'Read README.md and follow the instructions.\n')
    await writeFile(path.join(repoRoot, 'README.md'), '```md\nStart with gort.md.\n```\n')

    const findings = await runBoot001(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('does not create bootstrap edges from tilde-fenced code examples', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), 'Read README.md and follow the instructions.\n')
    await writeFile(path.join(repoRoot, 'README.md'), '~~~md\nStart with gort.md.\n~~~\n')

    const findings = await runBoot001(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('does not create bootstrap edges from indented code examples', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), 'Read README.md and follow the instructions.\n')
    await writeFile(path.join(repoRoot, 'README.md'), '    Start with gort.md.\n')

    const findings = await runBoot001(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('does not flag cycles that exist only across disjoint startup surfaces', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), '## Codex\nRead README.md and follow the instructions.\n')
    await writeFile(path.join(repoRoot, 'README.md'), '## Zeph\nStart with gort.md.\n')

    const findings = await runBoot001(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('flags cycles when one side is broad and the other is explicitly scoped', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), 'Read README.md and follow the instructions.\n')
    await writeFile(path.join(repoRoot, 'README.md'), '## Codex\nStart with gort.md.\n')

    const findings = await runBoot001(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('BOOT001')
  })

  it('keeps distinct scoped cycles when the same file pair participates in multiple startup surfaces', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), '## Codex\nRead README.md and follow the instructions.\n\n## Zeph\nRead README.md and follow the instructions.\n')
    await writeFile(path.join(repoRoot, 'README.md'), '## Codex\nStart with gort.md.\n\n## Zeph\nStart with gort.md.\n')

    const findings = await runBoot001(repoRoot, config)
    expect(findings).toHaveLength(2)
    expect(findings.every((finding) => finding.ruleId === 'BOOT001')).toBe(true)
  })
})

describe('BOOT002', () => {
  it('flags ambiguous bootstrap entrypoint claims', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), 'Start with gort.md.\n')
    await writeFile(path.join(repoRoot, 'README.md'), 'The first grounding read must be README.md.\n')

    const findings = await runBoot002(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('BOOT002')
    expect(findings[0]?.line).toBe(1)
  })

  it('does not flag when one bootstrap document is explicitly fallback-only', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), 'Start with gort.md.\n')
    await writeFile(path.join(repoRoot, 'README.md'), 'Use README.md only as a fallback when no more specific file exists.\n')

    const findings = await runBoot002(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('does not flag bootstrap claims scoped to different startup surfaces', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), '## Codex\nStart with gort.md.\n')
    await writeFile(path.join(repoRoot, 'README.md'), '## Zeph\nThe first grounding read must be README.md.\n')

    const findings = await runBoot002(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('does not flag bootstrap claims scoped to different models via structured headings', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), '## Model: openai:.*codex\nStart with gort.md.\n')
    await writeFile(path.join(repoRoot, 'README.md'), '## Model: sonnet\nThe first grounding read must be README.md.\n')

    const findings = await runBoot002(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('does not flag bootstrap claims scoped to different surfaces via structured headings', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), '## Surface: cli\nStart with gort.md.\n')
    await writeFile(path.join(repoRoot, 'README.md'), '## Surface: tui\nThe first grounding read must be README.md.\n')

    const findings = await runBoot002(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('flags broad and explicitly scoped bootstrap claims as potentially overlapping', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      roles: {
        rootControllers: ['gort.md'],
        consumerGuides: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'gort.md'), 'Start with gort.md.\n')
    await writeFile(path.join(repoRoot, 'README.md'), '## Codex\nThe first grounding read must be README.md.\n')

    const findings = await runBoot002(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('BOOT002')
  })
})

describe('CITE005', () => {
  it('requires citation-log references in entry docs only', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md',
        entryDocs: ['README.md', 'gort.md']
      }
    }

    await writeFile(path.join(repoRoot, 'README.md'), '# Repo\n')
    await writeFile(path.join(repoRoot, 'gort.md'), 'See [citations](./gort.citations.md).\n')

    const findings = await runCite005(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.filePath).toBe('README.md')
  })

  it('accepts reference-style links to the citation log in entry docs', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md',
        entryDocs: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'README.md'), [
      'See [citations][log].',
      '',
      '[log]: ./gort.citations.md'
    ].join('\n'))

    const findings = await runCite005(repoRoot, config)
    expect(findings).toHaveLength(0)
  })

  it('does not count markdown images that point at the citation log as entry-doc references', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md',
        entryDocs: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'README.md'), '![citations](./gort.citations.md)\n')

    const findings = await runCite005(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('CITE005')
  })

  it('does not treat citation-log lookalikes such as .bak files as valid references', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md',
        entryDocs: ['README.md']
      }
    }

    await writeFile(path.join(repoRoot, 'README.md'), 'Historical backup: `gort.citations.md.bak`\n')

    const findings = await runCite005(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('CITE005')
  })

  it('flags missing configured entry docs instead of throwing', async () => {
    const repoRoot = await makeRepo()
    const config: AgentInstructionLintConfig = {
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md',
        entryDocs: ['README.md']
      }
    }

    const findings = await runCite005(repoRoot, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.ruleId).toBe('CITE005')
    expect(findings[0]?.message).toContain('does not exist')
  })
})

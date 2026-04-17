import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { formatFindingsText, helpText, isDirectExecution, parseCliArgs, runCli } from '../src/cli.js'
import type { Finding } from '../src/types.js'

const execFileAsync = promisify(execFile)

async function makeRepo(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'agent-instruction-lint-cli-'))
}

async function captureStdout(run: () => Promise<number>): Promise<{ code: number; output: string }> {
  let output = ''
  const originalWrite = process.stdout.write.bind(process.stdout)
  const replacement: typeof process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stdout.write
  process.stdout.write = replacement
  try {
    const code = await run()
    return { code, output }
  } finally {
    process.stdout.write = originalWrite
  }
}

async function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(command, args, { cwd })
}

describe('parseCliArgs', () => {
  it('parses repo root, config, diff file, and format options', () => {
    expect(parseCliArgs([
      '--repo-root',
      '/tmp/repo',
      '--config',
      'custom.json',
      '--diff-file',
      '/tmp/diff.patch',
      '--format',
      'json'
    ])).toEqual({
      repoRoot: '/tmp/repo',
      configPath: 'custom.json',
      diffFile: '/tmp/diff.patch',
      format: 'json',
      help: false
    })
  })

  it('parses help without requiring other arguments', () => {
    expect(parseCliArgs(['--help'])).toEqual({
      repoRoot: process.cwd(),
      format: 'text',
      help: true
    })
  })
})

describe('formatFindingsText', () => {
  it('formats findings with file, line, column, evidence, and suggestion context', () => {
    const findings: Finding[] = [
      {
        ruleId: 'LINK001',
        severity: 'error',
        filePath: 'README.md',
        line: 3,
        column: 5,
        message: 'Local link target does not exist: ./docs/missing.md',
        evidence: 'docs/missing.md',
        suggestion: 'Update the link target or restore the referenced file.'
      }
    ]

    expect(formatFindingsText(findings)).toBe([
      'README.md:3:5 LINK001 error Local link target does not exist: ./docs/missing.md',
      '  evidence: docs/missing.md',
      '  suggestion: Update the link target or restore the referenced file.'
    ].join('\n'))
  })

  it('renders a zero-findings summary when there are no findings', () => {
    expect(formatFindingsText([])).toBe('0 findings')
  })
})

describe('isDirectExecution', () => {
  it('treats a symlinked executable path as direct execution of the same file', async () => {
    const root = await makeRepo()
    const actual = path.join(root, 'dist/cli.js')
    const link = path.join(root, 'node_modules/.bin/agent-instruction-lint')

    await mkdir(path.dirname(actual), { recursive: true })
    await mkdir(path.dirname(link), { recursive: true })
    await writeFile(actual, '#!/usr/bin/env node\n')
    await symlink(actual, link)

    expect(isDirectExecution(link, actual)).toBe(true)
  })
})

describe('helpText', () => {
  it('describes the available CLI options', () => {
    const text = helpText()
    expect(text).toContain('--repo-root <path>')
    expect(text).toContain('--diff-file <path>')
    expect(text).toContain('default combined staged+unstaged+untracked git diff')
    expect(text).toContain('--format <text|json>')
  })
})

describe('runCli', () => {
  it('fails with a clear error when --diff-file does not exist', async () => {
    const repoRoot = await makeRepo()

    await expect(runCli(['--repo-root', repoRoot, '--diff-file', path.join(repoRoot, 'missing.patch')]))
      .rejects
      .toThrow(`Diff file not found: ${path.join(repoRoot, 'missing.patch')}`)
  })

  it('returns 1 and emits json when findings are present', async () => {
    const repoRoot = await makeRepo()
    await writeFile(path.join(repoRoot, 'agent-instruction-lint.json'), JSON.stringify({
      $schema: './agent-instruction-lint.schema.json',
      roles: { supportingDocs: ['README.md'] }
    }, null, 2))
    await writeFile(path.join(repoRoot, 'README.md'), 'See [missing](./docs/missing.md).\n')

    const result = await captureStdout(() => runCli(['--repo-root', repoRoot, '--format', 'json']))
    expect(result.code).toBe(1)
    expect(JSON.parse(result.output)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'LINK001', filePath: 'README.md', line: 1, column: 5 })
      ])
    )
  })

  it('returns 0 and emits a zero-findings text summary when clean', async () => {
    const repoRoot = await makeRepo()
    await writeFile(path.join(repoRoot, 'agent-instruction-lint.json'), JSON.stringify({
      $schema: './agent-instruction-lint.schema.json',
      roles: { supportingDocs: ['README.md', 'docs/reference.md'] }
    }, null, 2))
    await mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await writeFile(path.join(repoRoot, 'README.md'), 'See [ref](./docs/reference.md).\n')
    await writeFile(path.join(repoRoot, 'docs/reference.md'), '# Present\n')

    const result = await captureStdout(() => runCli(['--repo-root', repoRoot]))
    expect(result.code).toBe(0)
    expect(result.output.trim()).toBe('0 findings')
  })

  it('emits evidence and suggestion lines in text mode when findings are present', async () => {
    const repoRoot = await makeRepo()
    await writeFile(path.join(repoRoot, 'agent-instruction-lint.json'), JSON.stringify({
      $schema: './agent-instruction-lint.schema.json',
      roles: { supportingDocs: ['README.md'] }
    }, null, 2))
    await writeFile(path.join(repoRoot, 'README.md'), 'See [missing](./docs/missing.md).\n')

    const result = await captureStdout(() => runCli(['--repo-root', repoRoot]))
    expect(result.code).toBe(1)
    expect(result.output).toContain('LINK001 error Local link target does not exist: ./docs/missing.md')
    expect(result.output).toContain('evidence: docs/missing.md')
    expect(result.output).toContain('suggestion: Update the link target or restore the referenced file.')
  })

  it('uses --diff-file to drive diff-based findings even when the working tree is otherwise clean', async () => {
    const repoRoot = await makeRepo()
    const diffPath = path.join(repoRoot, 'changes.patch')

    await writeFile(path.join(repoRoot, 'agent-instruction-lint.json'), JSON.stringify({
      $schema: './agent-instruction-lint.schema.json',
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }, null, 2))
    await writeFile(path.join(repoRoot, 'gort.md'), 'Do not pause\n')
    await writeFile(path.join(repoRoot, 'gort.citations.md'), '# Citation log\n')
    await writeFile(diffPath, [
      'diff --git a/gort.md b/gort.md',
      '--- a/gort.md',
      '+++ b/gort.md',
      '@@ -1 +1 @@',
      '-Do not pause',
      '+Do not pause and always continue'
    ].join('\n'))

    const result = await captureStdout(() => runCli(['--repo-root', repoRoot, '--diff-file', diffPath, '--format', 'json']))
    expect(result.code).toBe(1)
    expect(JSON.parse(result.output)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'CITE001', filePath: 'gort.md', line: 1 })
      ])
    )
  })

  it('uses both staged and unstaged git diff by default when --diff-file is not provided', async () => {
    const repoRoot = await makeRepo()
    await writeFile(path.join(repoRoot, 'agent-instruction-lint.json'), JSON.stringify({
      $schema: './agent-instruction-lint.schema.json',
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }, null, 2))
    await writeFile(path.join(repoRoot, 'gort.md'), 'Do not pause\n')
    await writeFile(path.join(repoRoot, 'gort.citations.md'), '# Citation log\n')

    await runCommand('git', ['init'], repoRoot)
    await runCommand('git', ['config', 'user.email', 'agent@example.com'], repoRoot)
    await runCommand('git', ['config', 'user.name', 'Agent'], repoRoot)
    await runCommand('git', ['add', 'agent-instruction-lint.json', 'gort.md', 'gort.citations.md'], repoRoot)
    await runCommand('git', ['commit', '-m', 'test: init'], repoRoot)

    await writeFile(path.join(repoRoot, 'gort.md'), 'Do not pause and always continue\n')
    await runCommand('git', ['add', 'gort.md'], repoRoot)
    await writeFile(path.join(repoRoot, 'gort.citations.md'), '# Citation log\n## 2026-04-16 — update\n')

    const result = await captureStdout(() => runCli(['--repo-root', repoRoot, '--format', 'json']))
    const findings = JSON.parse(result.output)
    expect(result.code).toBe(1)
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'CITE002', filePath: 'gort.citations.md', line: 2 })
      ])
    )
    expect(findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'CITE001', filePath: 'gort.md' })
      ])
    )
  })

  it('includes untracked files in the default git diff when --diff-file is not provided', async () => {
    const repoRoot = await makeRepo()
    await writeFile(path.join(repoRoot, 'agent-instruction-lint.json'), JSON.stringify({
      $schema: './agent-instruction-lint.schema.json',
      citation: {
        protected: ['gort.md'],
        log: 'gort.citations.md'
      }
    }, null, 2))

    await runCommand('git', ['init'], repoRoot)
    await runCommand('git', ['config', 'user.email', 'agent@example.com'], repoRoot)
    await runCommand('git', ['config', 'user.name', 'Agent'], repoRoot)
    await runCommand('git', ['add', 'agent-instruction-lint.json'], repoRoot)
    await runCommand('git', ['commit', '-m', 'test: init'], repoRoot)

    await writeFile(path.join(repoRoot, 'gort.md'), 'Do not pause and always continue\n')

    const result = await captureStdout(() => runCli(['--repo-root', repoRoot, '--format', 'json']))
    const findings = JSON.parse(result.output)
    expect(result.code).toBe(1)
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'CITE001', filePath: 'gort.md', line: 1 })
      ])
    )
  })

  it('includes untracked files whose paths contain spaces in the default git diff', async () => {
    const repoRoot = await makeRepo()
    await writeFile(path.join(repoRoot, 'agent-instruction-lint.json'), JSON.stringify({
      $schema: './agent-instruction-lint.schema.json',
      citation: {
        protected: ['docs/My Guide.md'],
        log: 'gort.citations.md'
      }
    }, null, 2))

    await runCommand('git', ['init'], repoRoot)
    await runCommand('git', ['config', 'user.email', 'agent@example.com'], repoRoot)
    await runCommand('git', ['config', 'user.name', 'Agent'], repoRoot)
    await runCommand('git', ['add', 'agent-instruction-lint.json'], repoRoot)
    await runCommand('git', ['commit', '-m', 'test: init'], repoRoot)

    await mkdir(path.join(repoRoot, 'docs'), { recursive: true })
    await writeFile(path.join(repoRoot, 'docs/My Guide.md'), 'Do not pause and always continue\n')

    const result = await captureStdout(() => runCli(['--repo-root', repoRoot, '--format', 'json']))
    const findings = JSON.parse(result.output)
    expect(result.code).toBe(1)
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'CITE001', filePath: 'docs/My Guide.md', line: 1 })
      ])
    )
  })
})

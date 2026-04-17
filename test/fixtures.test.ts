import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { lintRepository } from '../src/index.js'

const fixturesRoot = path.resolve('test/fixtures')

async function lintFixture(name: string, options?: { diffFile?: string }) {
  const repoRoot = path.join(fixturesRoot, name)
  const diffText = options?.diffFile
    ? await readFile(path.join(repoRoot, options.diffFile), 'utf8')
    : undefined
  return lintRepository({ repoRoot, diffText })
}

describe('fixture repos', () => {
  it('keeps the clean gort-like fixture free of findings', async () => {
    await expect(lintFixture('gort-like-clean', { diffFile: 'diff.patch' })).resolves.toEqual([])
  })

  it('keeps disjoint provider-scoped controllers free of topology findings', async () => {
    await expect(lintFixture('scoped-provider-clean')).resolves.toEqual([])
  })

  it('surfaces representative findings for the problematic gort-like fixture', async () => {
    const findings = await lintFixture('gort-like-problems', { diffFile: 'diff.patch' })
    expect(findings.map((finding) => finding.ruleId)).toEqual([
      'CITE002',
      'CITE003',
      'CITE004',
      'LINK001',
      'BOOT001',
      'CITE005'
    ])
  })
})

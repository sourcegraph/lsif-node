import * as assert from 'assert'
import { lsif } from './common.test'
import { Element } from 'lsif-protocol'

describe('Simple Tests', () => {
  it('Single export', () => {
    const emitter = lsif(
      '/@test',
      new Map([['/@test/a.ts', 'export const x = 10;']]),
      {}
    )
    const validate = [
      JSON.parse(
        '{"id":11,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:","unique":"group","kind":"export"}'
      ),
      JSON.parse(
        '{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:x","unique":"group","kind":"export"}'
      ),
      JSON.parse(
        '{"id":18,"type":"vertex","label":"range","start":{"line":0,"character":13},"end":{"line":0,"character":14},"tag":{"type":"definition","text":"x","kind":7,"fullRange":{"start":{"line":0,"character":13},"end":{"line":0,"character":19}}}}'
      ),
    ] as Element[]
    for (const element of validate) {
      assert.deepStrictEqual(emitter.elements.get(element.id), element)
    }
  })
})

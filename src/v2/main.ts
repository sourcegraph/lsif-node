import * as path from 'path'
import ts from 'typescript-lsif'
import { Indexer } from './indexer'
import { makeWriterContext } from './writer'
import { makePathContext } from './paths'
import { loadPackageJson, loadProjectConfiguration } from './config'
import { makeProgramContext } from './program'
import { inferTypings } from './typings'

async function run(args: string[]): Promise<void> {
  const { packageJson, projectRoot } = loadPackageJson()
  const { config, tsconfigFileName } = loadProjectConfiguration(
    ts.parseCommandLine(args)
  )
  if (config.fileNames.length === 0) {
    throw new Error(`No input files specified.`)
  }

  const currentDirectory = tsconfigFileName
    ? path.dirname(tsconfigFileName)
    : process.cwd()

  const shouldInferTypings = true
  if (shouldInferTypings) {
    await inferTypings(config, projectRoot, tsconfigFileName, currentDirectory)
  }

  const writerContext = makeWriterContext(projectRoot, packageJson)
  const programContext = makeProgramContext(config, currentDirectory)
  const pathContext = makePathContext(
    programContext.program,
    projectRoot,
    currentDirectory
  )

  // TODO
  // console.log({ references: program.getResolvedProjectReferences() })

  const indexer = new Indexer(writerContext, programContext, pathContext)
  indexer.index()
}

export async function main(): Promise<void> {
  return run(ts.sys.args)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

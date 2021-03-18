import * as path from 'path'
import ts from 'typescript-lsif'
import { Indexer, version } from './indexer'
import { makeWriterContext } from './writer'
import { makePathContext } from './paths'
import { loadPackageJson, loadProjectConfiguration } from './config'
import { makeProgramContext } from './program'
import { inferTypings } from './typings'
import minimist from 'minimist'

interface Options {
  help: boolean
  version: boolean
  out: string
  repositoryRoot: string
  inferTypings: boolean
}

const defaults: Options = {
  help: false,
  version: false,
  out: 'dump.lsif',
  repositoryRoot: '',
  inferTypings: false,
}

const minOpts: minimist.Opts = {
  string: ['out', 'repositoryRoot'],
  boolean: ['help', 'version', 'inferTypings'],
  default: { ...defaults },
  alias: { help: ['h'], version: ['v'], out: ['o'] },
}

//
//
//

const helpText = `
usage: lsif-tsc [options] [tsc options]

lsif-tsc is an LSIF indexer for TypeScript.

Options:
  -h, --help            Show help.
  -v, --version         Show application version.
  -o, --out             The output file.
      --repositoryRoot  Specifies the path of the current repository (inferred automatically via git).
      --inferTypings    Infer typings for JavaScript npm modules.
`

async function run(args: string[]): Promise<void> {
  const {
    help: showHelp,
    version: showVersion,
    out,
    repositoryRoot,
    inferTypings: shouldInferTypings,
  } = {
    ...defaults,
    ...minimist(args, minOpts),
  }

  if (showHelp) {
    console.log(helpText)
    return
  }
  if (showVersion) {
    console.log(version)
    return
  }

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

  if (shouldInferTypings) {
    await inferTypings(config, projectRoot, tsconfigFileName, currentDirectory)
  }

  const writerContext = makeWriterContext(out, projectRoot, packageJson)
  const programContext = makeProgramContext(config, currentDirectory)
  const pathContext = makePathContext(
    programContext.program,
    projectRoot,
    currentDirectory,
    repositoryRoot
  )

  // TODO - project references
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

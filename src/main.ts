import * as path from 'path'
import * as ts from 'typescript'
import * as yargs from 'yargs'
import * as lsif from './lsif'
import { Indexer } from './Indexer'

export const lsif_typed = lsif.lib.codeintel.lsif_typed

export interface DocEntry {
  name?: string
  fileName?: string
  documentation?: string
  type?: string
  constructors?: DocEntry[]
  parameters?: DocEntry[]
  returnType?: string
}

export interface Options {
  project: string
  writeIndex: (index: lsif.lib.codeintel.lsif_typed.Index) => void
}

export function main(): void {
  yargs
    .scriptName('lsif-node')
    .usage('$0 <cmd> [args]')
    .command(
      'index [project]',
      'LSIF index a project',
      (yargs) => {
        yargs.positional('project', {
          type: 'string',
          default: '.',
          describe: 'the directory to index',
        })
      },
      (argv) => {
        index({
          project: argv.project as string,
          writeIndex: (index): void => {
            console.log(index)
          },
        })
      }
    )
    .help().argv
}

export function indexToOutputFile(project: string, output: string): void {
  throw new Error('NOT IMPLEMENTED YET')
}

export function index(options: Options): void {
  console.log({ options })
  // console.log("\n==========");
  // console.log({ project: argv.project, args: ts.sys.args });
  let config = ts.parseCommandLine(
    ['-p', options.project],
    (relativePath: string) => {
      console.log({ relativePath })
      return path.resolve(options.project, relativePath)
    }
  )
  let tsconfigFileName: string | undefined
  if (config.options.project) {
    const projectPath = path.resolve(config.options.project)
    if (ts.sys.directoryExists(projectPath)) {
      tsconfigFileName = path.join(projectPath, 'tsconfig.json')
    } else {
      tsconfigFileName = projectPath
    }
    if (!ts.sys.fileExists(tsconfigFileName)) {
      console.error(`no such file: ${tsconfigFileName}`)
      process.exitCode = 1
      return undefined
    }
    config = loadConfigFile(tsconfigFileName)
  }

  // console.log({ tsconfigFileName });

  if (config.fileNames.length === 0) {
    console.error(`no input files`)
    process.exitCode = 1
    return undefined
  }

  new Indexer(config, options).index()
}

if (require.main === module) {
  main()
}

function loadConfigFile(file: string): ts.ParsedCommandLine {
  let absolute = path.resolve(file)

  let readResult = ts.readConfigFile(absolute, ts.sys.readFile)
  if (readResult.error) {
    throw new Error(
      ts.formatDiagnostics([readResult.error], ts.createCompilerHost({}))
    )
  }
  let config = readResult.config
  if (config.compilerOptions !== undefined) {
    config.compilerOptions = Object.assign(
      config.compilerOptions,
      getDefaultCompilerOptions(file)
    )
  }
  let result = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    path.dirname(absolute)
  )
  if (result.errors.length > 0) {
    throw new Error(
      ts.formatDiagnostics(result.errors, ts.createCompilerHost({}))
    )
  }
  return result
}

function getDefaultCompilerOptions(configFileName?: string) {
  const options: ts.CompilerOptions =
    configFileName && path.basename(configFileName) === 'jsconfig.json'
      ? {
          allowJs: true,
          maxNodeModuleJsDepth: 2,
          allowSyntheticDefaultImports: true,
          skipLibCheck: true,
          noEmit: true,
        }
      : {}
  return options
}

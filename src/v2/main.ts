import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import ts from 'typescript-lsif'
import { create as createEmitter } from '../emitter'
import { Builder } from '../graph'
import { ExportLinker, ImportLinker } from '../linker'
import PackageJson from '../package'
import * as tss from '../typescripts'
import { TypingsInstaller } from '../typings'
import { FileWriter } from '../writer'
import { Indexer } from './indexer'
import { makeLanguageServiceHost } from './languageService'

async function run(args: string[]): Promise<void> {
  const packageFile = tss.makeAbsolute('package.json')
  const packageJson: PackageJson | undefined = PackageJson.read(packageFile)
  const projectRoot = tss.makeAbsolute(path.posix.dirname(packageFile))
  const repositoryRoot = tss.makeAbsolute(
    execSync('git rev-parse --show-toplevel').toString().trim()
  )
  const writer = new FileWriter(fs.openSync('dump.lsif', 'w'))
  const emitter = createEmitter(writer)

  let tsconfigFileName: string | undefined
  let config: ts.ParsedCommandLine = ts.parseCommandLine(args)
  if (config.options.project) {
    const projectPath = path.resolve(config.options.project)
    tsconfigFileName = ts.sys.directoryExists(projectPath)
      ? path.join(projectPath, 'tsconfig.json')
      : projectPath

    if (!ts.sys.fileExists(tsconfigFileName)) {
      throw new Error(
        `Project configuration file ${tsconfigFileName} does not exist`
      )
    }

    const absolute = path.resolve(tsconfigFileName)
    const { config: newConfig, error } = ts.readConfigFile(
      absolute,
      ts.sys.readFile.bind(ts.sys)
    )
    if (error) {
      throw new Error(ts.formatDiagnostics([error], ts.createCompilerHost({})))
    }
    if (!newConfig.compilerOptions) {
      newConfig.compilerOptions = tss.getDefaultCompilerOptions(
        tsconfigFileName
      )
    }
    const result = ts.parseJsonConfigFileContent(
      newConfig,
      ts.sys,
      path.dirname(absolute)
    )
    if (result.errors.length > 0) {
      throw new Error(
        ts.formatDiagnostics(result.errors, ts.createCompilerHost({}))
      )
    }
    config = result
  }

  if (config.fileNames.length === 0) {
    throw new Error(`No input files specified.`)
  }

  const currentDirectory = tsconfigFileName
    ? path.dirname(tsconfigFileName)
    : process.cwd()

  const inferTypings = true
  const typingsInstaller = new TypingsInstaller()
  if (inferTypings) {
    // TODO - make parameters match for better interface
    await (config.options.types
      ? typingsInstaller.installTypings(
          projectRoot,
          tsconfigFileName || process.cwd(),
          config.options.types
        )
      : typingsInstaller.guessTypings(projectRoot, currentDirectory))
  }

  const host = makeLanguageServiceHost(config, currentDirectory)
  const languageService = ts.createLanguageService(host)
  const program = languageService.getProgram()
  if (!program) {
    throw new Error("Couldn't create language service with underlying program.")
  }
  const typeChecker = program.getTypeChecker()
  const compilerOptions = program.getCompilerOptions()

  const rootDir =
    compilerOptions.rootDir !== undefined
      ? tss.makeAbsolute(compilerOptions.rootDir, currentDirectory)
      : compilerOptions.baseUrl !== undefined
      ? tss.makeAbsolute(compilerOptions.baseUrl, currentDirectory)
      : tss.normalizePath(tss.Program.getCommonSourceDirectory(program))
  const outDir =
    compilerOptions.outDir !== undefined
      ? tss.makeAbsolute(compilerOptions.outDir, currentDirectory)
      : rootDir

  let counter = 1
  const idGenerator = () => counter++
  const builder = new Builder({
    idGenerator,
    emitSource: false,
  })

  const importLinker = new ImportLinker(projectRoot, emitter, idGenerator)
  const exportLinker =
    packageJson &&
    new ExportLinker(projectRoot, packageJson, emitter, idGenerator)

  // TODO
  // console.log({ references: program.getResolvedProjectReferences() })

  const indexer = new Indexer(
    builder,
    emitter,
    program,
    typeChecker,
    importLinker,
    exportLinker,
    languageService,
    projectRoot,
    rootDir,
    outDir,
    repositoryRoot
  )

  indexer.index()
  return Promise.resolve()
}

export async function main(): Promise<void> {
  return run(ts.sys.args)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

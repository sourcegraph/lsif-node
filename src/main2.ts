import * as path from 'path'
import ts from 'typescript-lsif'
import { create as createEmitter } from './emitter'
import PackageJson from './package'
import * as fs from 'fs'
import * as tss from './typescripts'
import { execSync } from 'child_process'
import { FileWriter } from './writer'
import { TypingsInstaller } from './typings'

async function run(args: string[]): Promise<void> {
  const packageFile = tss.makeAbsolute('package.json')
  const packageJson: PackageJson | undefined = PackageJson.read(packageFile)
  const projectRoot = tss.makeAbsolute(path.posix.dirname(packageFile))
  const repositoryRoot = tss.makeAbsolute(
    execSync('git rev-parse --show-toplevel').toString().trim()
  )
  const writer = new FileWriter(fs.openSync('dump.lsif', 'w'))
  const emitter = createEmitter(writer)
  const typingsInstaller = new TypingsInstaller() // TODO - per project

  var tsconfigFileName: string | undefined
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
      ts.sys.readFile
    )
    if (error) {
      throw new Error(ts.formatDiagnostics([error], ts.createCompilerHost({})))
    }
    if (newConfig.compilerOptions !== undefined) {
      newConfig.compilerOptions = Object.assign(
        newConfig.compilerOptions,
        tss.getDefaultCompilerOptions(tsconfigFileName)
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

  // TODO - rename
  const rootX = tsconfigFileName || process.cwd()
  const rootY = tsconfigFileName
    ? path.dirname(tsconfigFileName)
    : process.cwd()

  const inferTypings = true
  if (inferTypings) {
    // TODO - make parameters match for better interface
    await (config.options.types
      ? typingsInstaller.installTypings(
          projectRoot,
          rootX,
          config.options.types
        )
      : typingsInstaller.guessTypings(projectRoot, rootY))
  }

  // TODO - extract
  const scriptSnapshots: Map<string, ts.IScriptSnapshot | null> = new Map()
  const getScriptSnapshot = (
    fileName: string
  ): ts.IScriptSnapshot | undefined => {
    let snapshot = scriptSnapshots.get(fileName)
    if (snapshot === undefined) {
      snapshot = ts.sys.fileExists(fileName)
        ? ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) || '')
        : null
      scriptSnapshots.set(fileName, snapshot)
    }

    return snapshot || undefined
  }
  const host: ts.LanguageServiceHost = {
    getProjectVersion: () => '0',
    getScriptVersion: () => '0',
    getCurrentDirectory: () => rootY,
    getCompilationSettings: () => config.options,
    getProjectReferences: () => config.projectReferences,
    getScriptFileNames: () => config.fileNames,
    directoryExists: ts.sys.directoryExists.bind(ts.sys),
    fileExists: ts.sys.fileExists.bind(ts.sys),
    getDefaultLibFileName: ts.getDefaultLibFilePath.bind(ts),
    getDirectories: ts.sys.getDirectories.bind(ts.sys),
    readDirectory: ts.sys.readDirectory.bind(ts.sys),
    readFile: ts.sys.readFile.bind(ts.sys),
    getScriptSnapshot,
  }

  const languageService = ts.createLanguageService(host)
  const program = languageService.getProgram()
  if (!program) {
    throw new Error("Couldn't create language service with underlying program.")
  }
  const typeChecker = program.getTypeChecker()

  // TODO
  console.log({ references: program.getResolvedProjectReferences() })

  for (const sourceFile of program.getSourceFiles()) {
    console.log({ sourceFile })
  }

  if (args.length < 0) {
    console.log({
      packageJson,
      repositoryRoot,
      emitter,
      typeChecker,
    })
  }

  return Promise.resolve()
}

//
//

export async function main(): Promise<void> {
  return run(ts.sys.args)
}

function exit(error?: any) {
  console.error(error)
  process.exitCode = 1
}

main().catch(exit)

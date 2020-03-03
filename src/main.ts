#!/usr/bin/env node

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path'
import * as fs from 'fs'

import * as minimist from 'minimist'

import * as ts from 'typescript-lsif'
import * as tss from './typescripts'

import { Id } from 'lsif-protocol'
import { toolVersion } from './consts'
import { Emitter } from './emitter'
import { TypingsInstaller } from './typings'
import { lsif, ProjectInfo, Options as VisitorOptions } from './lsif'
import { FileWriter } from './writer'
import { create as createEmitter } from './emitter'
import { ExportLinker, ImportLinker } from './linker'
import PackageJson from './package'
import { execSync } from 'child_process'

interface Options {
  help: boolean
  version: boolean
  repositoryRoot: string
  addContents: boolean
  inferTypings: boolean
  out: string
}

interface OptionDescription {
  id: keyof Options
  type: 'boolean' | 'string'
  alias?: string
  default: any
  values?: string[]
  description: string
}

namespace Options {
  export const defaults: Options = {
    help: false,
    version: false,
    out: 'dump.lsif',
    repositoryRoot: '',
    addContents: false,
    inferTypings: false,
  }
  export const descriptions: OptionDescription[] = [
    {
      id: 'help',
      type: 'boolean',
      alias: 'h',
      default: false,
      description: 'Show help.',
    },
    {
      id: 'version',
      type: 'boolean',
      alias: 'v',
      default: false,
      description: 'Show application version.',
    },
    {
      id: 'out',
      type: 'string',
      alias: 'o',
      default: 'dump.lsif',
      description: 'The output file.',
    },
    {
      id: 'repositoryRoot',
      type: 'string',
      default: '',
      description:
        'Specifies the path of the current repository (inferred automatically via git).',
    },
    {
      id: 'addContents',
      type: 'boolean',
      default: false,
      description: 'Embed file contents into the dump.',
    },
    {
      id: 'inferTypings',
      type: 'boolean',
      default: false,
      description: 'Infer typings for JavaScript npm modules.',
    },
  ]
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
      tss.getDefaultCompilerOptions(file)
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

function createIdGenerator(): () => Id {
  let counter = 1
  return () => {
    return counter++
  }
}

async function processProject(
  config: ts.ParsedCommandLine,
  options: Options,
  projectRoot: string,
  emitter: Emitter,
  idGenerator: () => Id,
  importLinker: ImportLinker,
  exportLinker: ExportLinker | undefined,
  typingsInstaller: TypingsInstaller
): Promise<ProjectInfo | undefined> {
  let tsconfigFileName: string | undefined
  if (config.options.project) {
    const projectPath = path.resolve(config.options.project)
    if (ts.sys.directoryExists(projectPath)) {
      tsconfigFileName = path.join(projectPath, 'tsconfig.json')
    } else {
      tsconfigFileName = projectPath
    }
    if (!ts.sys.fileExists(tsconfigFileName)) {
      console.error(
        `Project configuration file ${tsconfigFileName} does not exist`
      )
      process.exitCode = 1
      return undefined
    }
    config = loadConfigFile(tsconfigFileName)
  }

  if (config.fileNames.length === 0) {
    console.error(`No input files specified.`)
    process.exitCode = 1
    return undefined
  }

  if (options.inferTypings) {
    if (config.options.types !== undefined) {
      const start =
        tsconfigFileName !== undefined ? tsconfigFileName : process.cwd()
      await typingsInstaller.installTypings(
        projectRoot,
        start,
        config.options.types
      )
    } else {
      await typingsInstaller.guessTypings(
        projectRoot,
        tsconfigFileName !== undefined
          ? path.dirname(tsconfigFileName)
          : process.cwd()
      )
    }
  }

  // Bind all symbols
  let scriptSnapshots: Map<string, ts.IScriptSnapshot> = new Map()
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => {
      return config.fileNames
    },
    getCompilationSettings: () => {
      return config.options
    },
    getProjectReferences: () => {
      return config.projectReferences
    },
    getScriptVersion: (fileName: string): string => {
      // The files are immutable.
      return '0'
    },
    // The project is immutable
    getProjectVersion: () => '0',
    getScriptSnapshot: (fileName: string): ts.IScriptSnapshot | undefined => {
      let result: ts.IScriptSnapshot | undefined = scriptSnapshots.get(fileName)
      if (result === undefined) {
        if (!ts.sys.fileExists(fileName)) {
          return undefined
        }
        let content = ts.sys.readFile(fileName)
        if (content === undefined) {
          return undefined
        }
        result = ts.ScriptSnapshot.fromString(content)
        scriptSnapshots.set(fileName, result)
      }
      return result
    },
    getCurrentDirectory: () => {
      if (tsconfigFileName !== undefined) {
        return path.dirname(tsconfigFileName)
      } else {
        return process.cwd()
      }
    },
    getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
  }
  const languageService = ts.createLanguageService(host)
  const program = languageService.getProgram()
  if (program === undefined) {
    console.error("Couldn't create language service with underlying program.")
    process.exitCode = -1
    return undefined
  }
  const dependsOn: ProjectInfo[] = []
  const references = program.getResolvedProjectReferences()
  if (references) {
    for (let reference of references) {
      if (reference) {
        const projectInfo = await processProject(
          reference.commandLine,
          options,
          projectRoot,
          emitter,
          idGenerator,
          importLinker,
          exportLinker,
          typingsInstaller
        )
        if (projectInfo !== undefined) {
          dependsOn.push(projectInfo)
        }
      }
    }
  }

  program.getTypeChecker()
  return lsif(
    languageService,
    { ...options, projectRoot } as VisitorOptions,
    dependsOn,
    emitter,
    idGenerator,
    importLinker,
    exportLinker,
    tsconfigFileName
  )
}

async function run(this: void, args: string[]): Promise<void> {
  let minOpts: minimist.Opts = {
    string: [],
    boolean: [],
    default: Object.create(null),
    alias: Object.create(null),
  }

  let longestId: number = 0
  for (let description of Options.descriptions) {
    longestId = Math.max(longestId, description.id.length)
    ;(minOpts[description.type] as string[]).push(description.id)
    minOpts.default![description.id] = description.default
    if (description.alias !== undefined) {
      minOpts.alias![description.id] = [description.alias]
    }
  }

  const options: Options = Object.assign(
    Options.defaults,
    minimist(process.argv.slice(2), minOpts)
  )

  if (options.version) {
    console.log(toolVersion)
    return
  }

  let buffer: string[] = []
  if (options.help) {
    buffer.push(`usage: lsif-tsc [options] [tsc options]`)
    buffer.push('')
    buffer.push(`lsif-tsc is an LSIF indexer for TypeScript.`)
    buffer.push('')
    buffer.push(`Options:`)
    for (let description of Options.descriptions) {
      if (description.id == 'help') {
        continue
      }

      if (description.alias !== undefined) {
        buffer.push(
          `  -${description.alias}, --${description.id}${' '.repeat(
            longestId - description.id.length
          )}  ${description.description}`
        )
      } else {
        buffer.push(
          `      --${description.id}${' '.repeat(
            longestId - description.id.length
          )}  ${description.description}`
        )
      }
    }
    console.log(buffer.join('\n'))
    return
  }

  let packageFile = 'package.json'
  packageFile = tss.makeAbsolute(packageFile)
  const packageJson: PackageJson | undefined = PackageJson.read(packageFile)

  const projectRoot = tss.makeAbsolute(path.posix.dirname(packageFile))

  if (options.repositoryRoot === '') {
    options.repositoryRoot = execSync('git rev-parse --show-toplevel')
      .toString()
      .trimRight()
  }
  options.repositoryRoot = tss.makeAbsolute(options.repositoryRoot)

  let writer = new FileWriter(fs.openSync(options.out, 'w'))
  const config: ts.ParsedCommandLine = ts.parseCommandLine(args)
  const idGenerator = createIdGenerator()
  const emitter = createEmitter(writer)
  const importLinker: ImportLinker = new ImportLinker(
    projectRoot,
    emitter,
    idGenerator
  )
  let exportLinker: ExportLinker | undefined
  if (packageJson !== undefined) {
    exportLinker = new ExportLinker(
      projectRoot,
      packageJson,
      emitter,
      idGenerator
    )
  }
  await processProject(
    config,
    options,
    projectRoot,
    emitter,
    idGenerator,
    importLinker,
    exportLinker,
    new TypingsInstaller()
  )
}

export async function main(): Promise<void> {
  return run(ts.sys.args)
}

run(ts.sys.args).then(undefined, error => {
  console.error(error)
  process.exitCode = 1
})

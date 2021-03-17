import { execSync } from 'child_process'
import * as fs from 'fs'
import {
  lsp,
  Range,
  Document,
  DefinitionResult,
  ReferenceResult,
  DefinitionRange,
  Moniker,
  MonikerKind,
  ItemEdgeProperties,
  ResultSet,
  RangeTagTypes,
} from 'lsif-protocol'
import * as path from 'path'
import ts from 'typescript-lsif'
import { create as createEmitter } from './emitter'
import { Builder } from './graph'
import PackageJson from './package'
import * as tss from './typescripts'
import { TypingsInstaller } from './typings'
import { URI } from 'vscode-uri'
import { FileWriter } from './writer'
import { ExportLinker, ImportLinker } from './linker'

//
//

const version = '0.0.1'

const phantomPosition = { line: 0, character: 0 }
const phantomRange = { start: phantomPosition, end: phantomPosition }

const rangeFromNode = (
  file: ts.SourceFile,
  node: ts.Node,
  includeJsDocComment?: boolean
): lsp.Range => ({
  start:
    file === node
      ? phantomPosition
      : file.getLineAndCharacterOfPosition(
          node.getStart(file, includeJsDocComment)
        ),
  end: file.getLineAndCharacterOfPosition(node.getEnd()),
})

const symbolKindMap: Map<number, lsp.SymbolKind> = new Map<
  number,
  lsp.SymbolKind
>([
  [ts.SyntaxKind.ClassDeclaration, lsp.SymbolKind.Class],
  [ts.SyntaxKind.InterfaceDeclaration, lsp.SymbolKind.Interface],
  [ts.SyntaxKind.TypeParameter, lsp.SymbolKind.TypeParameter],
  [ts.SyntaxKind.MethodDeclaration, lsp.SymbolKind.Method],
  [ts.SyntaxKind.FunctionDeclaration, lsp.SymbolKind.Function],
])

const asSymbolKind = (node: ts.Node): lsp.SymbolKind =>
  symbolKindMap.get(node.kind) || lsp.SymbolKind.Property

const asHover = (file: ts.SourceFile, value: ts.QuickInfo): lsp.Hover => {
  const contents: lsp.MarkedString[] = []
  if (value.displayParts) {
    contents.push({
      language: 'typescript',
      value: (value.displayParts || []).map((part) => part.text).join(''),
    })
  }
  if (value.documentation && value.documentation.length > 0) {
    contents.push((value.documentation || []).map((part) => part.text).join(''))
  }

  return { contents }
}

const getHover = (
  languageService: ts.LanguageService,
  node: ts.DeclarationName,
  sourceFile: ts.SourceFile = node.getSourceFile()
): lsp.Hover | undefined => {
  try {
    const quickInfo = languageService.getQuickInfoAtPosition(node, sourceFile)
    if (quickInfo !== undefined) {
      return asHover(sourceFile, quickInfo)
    }
  } catch (err) {
    // fallthrough
  }

  return undefined
}

const makeLanguageServiceHost = (
  config: ts.ParsedCommandLine,
  currentDirectory: string
): ts.LanguageServiceHost => {
  const scriptSnapshots = new Map<string, ts.IScriptSnapshot | null>()

  return {
    getProjectVersion: () => '0',
    getScriptVersion: () => '0',
    getCurrentDirectory: () => currentDirectory,
    getCompilationSettings: () => config.options,
    getProjectReferences: () => config.projectReferences,
    getScriptFileNames: () => config.fileNames,
    directoryExists: ts.sys.directoryExists.bind(ts.sys),
    fileExists: ts.sys.fileExists.bind(ts.sys),
    getDefaultLibFileName: ts.getDefaultLibFilePath.bind(ts),
    getDirectories: ts.sys.getDirectories.bind(ts.sys),
    readDirectory: ts.sys.readDirectory.bind(ts.sys),
    readFile: ts.sys.readFile.bind(ts.sys),
    getScriptSnapshot: (fileName: string): ts.IScriptSnapshot | undefined => {
      let snapshot = scriptSnapshots.get(fileName)
      if (snapshot === undefined) {
        snapshot = ts.sys.fileExists(fileName)
          ? ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) || '')
          : null
        scriptSnapshots.set(fileName, snapshot)
      }

      return snapshot || undefined
    },
  }
}

//
//

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

  let counter = 1
  const idGenerator = () => counter++
  const builder = new Builder({
    idGenerator,
    emitSource: false,
  })

  const toolInfo = {
    name: 'lsif-tsc',
    args: ts.sys.args,
    version,
  }
  emitter.emit(
    builder.vertex.metaData(
      version,
      URI.file(repositoryRoot).toString(true),
      toolInfo
    )
  )
  const project = builder.vertex.project()
  emitter.emit(project)

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

  const importLinker = new ImportLinker(projectRoot, emitter, idGenerator)
  let exportLinker: ExportLinker | undefined
  if (packageJson !== undefined) {
    exportLinker = new ExportLinker(
      projectRoot,
      packageJson,
      emitter,
      idGenerator
    )
  }

  // TODO
  // console.log({ references: program.getResolvedProjectReferences() })

  const isFullContentIgnored = (sourceFile: ts.SourceFile): boolean =>
    tss.Program.isSourceFileDefaultLibrary(program, sourceFile) ||
    tss.Program.isSourceFileFromExternalLibrary(program, sourceFile)

  let currentSourceFile: ts.SourceFile | undefined
  let currentDocumentData: DocumentData | undefined

  class DocumentData {
    private ranges: Range[] = []

    public constructor(
      public document: Document,
      public monikerPath: string | undefined,
      public externalLibrary: boolean
    ) {}

    public addRange(range: Range): void {
      emitter.emit(range)
      this.ranges.push(range)
    }

    public begin(): void {
      emitter.emit(this.document)
    }

    public end(): void {
      if (this.ranges.length >= 0) {
        emitter.emit(builder.edge.contains(this.document, this.ranges))
      }
    }
  }

  const documentDatas = new Map<string, DocumentData | null>()

  const computeMonikerPath = (
    sourceFile: ts.SourceFile
  ): string | undefined => {
    // A real source file inside this project.
    if (
      !sourceFile.isDeclarationFile ||
      (sourceFile.fileName.startsWith(rootDir) &&
        sourceFile.fileName.charAt(rootDir.length) === '/')
    ) {
      return tss.computeMonikerPath(
        projectRoot,
        tss.toOutLocation(sourceFile.fileName, rootDir, outDir)
      )
    }

    // TODO - need to have processed them first
    // This can come from a dependent project.
    // let fileName = sourceFile.fileName
    // for (let outDir of dependentOutDirs) {
    //   if (fileName.startsWith(outDir)) {
    //     return tss.computeMonikerPath(projectRoot, sourceFile.fileName)
    //   }
    // }

    return undefined
  }

  const getOrCreateDocumentData = (sourceFile: ts.SourceFile): DocumentData => {
    const id = '' // TODO
    const cachedDocumentData = documentDatas.get(id)
    if (cachedDocumentData) {
      return cachedDocumentData
    }

    const document = builder.vertex.document(sourceFile.fileName, '')
    let monikerPath: string | undefined
    let externalLibrary = false
    if (tss.Program.isSourceFileFromExternalLibrary(program, sourceFile)) {
      externalLibrary = true
      monikerPath = tss.computeMonikerPath(projectRoot, sourceFile.fileName)
    } else {
      monikerPath = computeMonikerPath(sourceFile)
    }

    const documentData = new DocumentData(
      document,
      monikerPath,
      externalLibrary
    )
    documentData.begin()
    documentDatas.set(id, documentData)
    return documentData
  }

  class SymbolData {
    private definitionInfo:
      | tss.DefinitionInfo
      | tss.DefinitionInfo[]
      | undefined

    private resultSet: ResultSet
    private definitionResult: DefinitionResult | undefined
    private referenceResult: ReferenceResult | undefined
    private definitionRanges: DefinitionRange[] = []
    private referenceRanges: Map<
      | ItemEdgeProperties.declarations
      | ItemEdgeProperties.definitions
      | ItemEdgeProperties.references,
      Range[]
    > = new Map()
    private referenceResults: ReferenceResult[] = []

    public constructor(private document: Document) {
      this.resultSet = builder.vertex.resultSet()
    }

    public recordDefinitionInfo(info: tss.DefinitionInfo): void {
      // TODO - different if union/intersection/transient type
      // TODO
      if (this.definitionInfo === undefined) {
        this.definitionInfo = info
      } else if (Array.isArray(this.definitionInfo)) {
        this.definitionInfo.push(info)
      } else {
        this.definitionInfo = [this.definitionInfo]
        this.definitionInfo.push(info)
      }
    }

    public hasDefinitionInfo(info: tss.DefinitionInfo): boolean {
      if (this.definitionInfo === undefined) {
        return false
      }

      // TODO
      if (Array.isArray(this.definitionInfo)) {
        for (const item of this.definitionInfo) {
          if (tss.DefinitionInfo.equals(item, info)) {
            return true
          }
        }
        return false
      }

      return tss.DefinitionInfo.equals(this.definitionInfo, info)
    }

    public addHover(hover: lsp.Hover): void {
      const hr = builder.vertex.hoverResult(hover)
      emitter.emit(hr)
      emitter.emit(builder.edge.hover(this.resultSet, hr))
    }

    // TODO - missing things for other resolver classes
    public addDefinition(
      sourceFile: ts.SourceFile,
      definition: DefinitionRange,
      recordAsReference = true
    ): void {
      emitter.emit(builder.edge.next(definition, this.resultSet))

      this.definitionRanges.push(definition)
      if (recordAsReference) {
        this.addReference(
          sourceFile,
          definition,
          ItemEdgeProperties.definitions
        )
      }
    }

    // TODO - missing things for other resolver classes
    public addReference(
      sourceFile: ts.SourceFile,
      reference: Range | ReferenceResult,
      property?:
        | ItemEdgeProperties.declarations
        | ItemEdgeProperties.definitions
        | ItemEdgeProperties.references
    ): void {
      if (reference.label === 'range') {
        emitter.emit(builder.edge.next(reference, this.resultSet))
      }

      if (reference.label === 'range' && property !== undefined) {
        let values = this.referenceRanges.get(property)
        if (values === undefined) {
          values = []
          this.referenceRanges.set(property, values)
        }
        values.push(reference)
      } else if (reference.label === 'referenceResult') {
        this.referenceResults.push(reference)
      }
    }

    //
    // TODO - skip and only do import/export linkers
    public addMoniker(identifier: string, kind: MonikerKind): Moniker {
      const moniker = builder.vertex.moniker('tsc', identifier, kind)
      emitter.emit(moniker)
      emitter.emit(builder.edge.moniker(this.resultSet, moniker))
      return moniker
    }

    public getOrCreateDefinitionResult(): DefinitionResult {
      if (this.definitionResult === undefined) {
        this.definitionResult = builder.vertex.definitionResult()
        emitter.emit(this.definitionResult)
        emitter.emit(
          builder.edge.definition(this.resultSet, this.definitionResult)
        )
      }

      return this.definitionResult
    }

    public getOrCreateReferenceResult(): ReferenceResult {
      if (this.referenceResult === undefined) {
        this.referenceResult = builder.vertex.referencesResult()
        emitter.emit(this.referenceResult)
        emitter.emit(
          builder.edge.references(this.resultSet, this.referenceResult)
        )
      }

      return this.referenceResult
    }

    public begin(): void {
      emitter.emit(this.resultSet)
    }

    public end(): void {
      if (this.definitionRanges.length > 0) {
        const definitionResult = this.getOrCreateDefinitionResult()
        emitter.emit(
          builder.edge.item(
            definitionResult,
            this.definitionRanges,
            this.document
          )
        )
      }

      if (this.referenceRanges.size > 0) {
        const referenceResult = this.getOrCreateReferenceResult()
        for (const property of this.referenceRanges.keys()) {
          const values = this.referenceRanges.get(property)!
          emitter.emit(
            builder.edge.item(referenceResult, values, this.document, property)
          )
        }
      }
      if (this.referenceResults.length > 0) {
        const referenceResult = this.getOrCreateReferenceResult()
        emitter.emit(
          builder.edge.item(
            referenceResult,
            this.referenceResults,
            this.document
          )
        )
      }
    }
  }
  const symbolDatas = new Map<string, SymbolData | null>()

  const getOrCreateSymbolData = (
    symbol: ts.Symbol,
    location: ts.Node
  ): SymbolData => {
    const id = tss.createSymbolKey(typeChecker, symbol)
    const cachedSymbolData = symbolDatas.get(id)
    if (cachedSymbolData) {
      return cachedSymbolData
    }

    // TODO: RESOLVER METHOD
    // [location] in some
    const declarations = symbol.getDeclarations() || []

    // TODO: RESOLVER METHOD
    // [location.getSourceFile()] in some
    const sourceFiles = Array.from(
      tss.getUniqueSourceFiles(symbol.getDeclarations()).values()
    )

    // TODO - share nicely
    const symbolData = new SymbolData(currentDocumentData!.document)
    symbolData.begin()

    let monikerPath: string | undefined | null
    let externalLibrary = false
    for (const sourceFile of sourceFiles.values()) {
      const documentData = getOrCreateDocumentData(sourceFile)
      if (monikerPath === undefined) {
        monikerPath = documentData.monikerPath
        externalLibrary = documentData.externalLibrary
      } else if (monikerPath !== documentData.monikerPath) {
        monikerPath = null
      }
    }
    if (monikerPath === null) {
      monikerPath = undefined
      externalLibrary = false
    }

    // The symbol represents a source file
    let monikerIdentifer: string | undefined
    if (tss.isSourceFile(symbol) && monikerPath !== undefined) {
      monikerIdentifer = tss.createMonikerIdentifier(monikerPath, undefined)
      // } else if (exportPath !== undefined && exportPath !== '') {
      // TODO - find an equivalent
      //   monikerIdentifer = tss.createMonikerIdentifier(monikerPath, exportPath)
    }
    if (monikerIdentifer === undefined) {
      // TODO - no need to emit
      symbolData.addMoniker(id, MonikerKind.local)
    } else if (externalLibrary) {
      const moniker = symbolData.addMoniker(
        monikerIdentifer,
        MonikerKind.import
      )
      importLinker.handleMoniker(moniker)
    } else {
      const moniker = symbolData.addMoniker(
        monikerIdentifer,
        MonikerKind.export
      )
      if (exportLinker !== undefined) {
        exportLinker.handleMoniker(moniker)
      }
    }

    for (const declaration of declarations) {
      const sourceFile = declaration.getSourceFile()

      // TODO: RESOLVER METHOD
      // [identifierNode, identifierText] = [declaration, declaration.getText()] in some

      const [identifierNode, identifierText] = tss.isNamedDeclaration(
        declaration
      )
        ? [declaration.name, declaration.name.getText()]
        : tss.isValueModule(symbol) && ts.isSourceFile(declaration)
        ? [declaration, '']
        : [undefined, undefined]

      if (identifierNode === undefined || identifierText === undefined) {
        continue
      }

      const documentData = getOrCreateDocumentData(sourceFile)
      const range = ts.isSourceFile(declaration)
        ? phantomRange
        : rangeFromNode(sourceFile, identifierNode)
      const definition = builder.vertex.range(range, {
        type: RangeTagTypes.definition,
        text: identifierText,
        kind: asSymbolKind(declaration),
        fullRange: rangeFromNode(sourceFile, declaration),
      })
      documentData.addRange(definition)
      symbolData.addDefinition(sourceFile, definition)
      symbolData.recordDefinitionInfo(
        tss.createDefinitionInfo(sourceFile, identifierNode)
      )
      if (tss.isNamedDeclaration(declaration)) {
        const hover = getHover(languageService, declaration.name, sourceFile)
        if (hover) {
          symbolData.addHover(hover)
        }
      }
    }

    symbolDatas.set(id, symbolData)
    return symbolData
  }

  const handleSymbol = (symbol: ts.Symbol | undefined, location: ts.Node) => {
    if (!symbol || !currentSourceFile || !currentDocumentData) {
      return
    }

    const symbolData = getOrCreateSymbolData(symbol, location)
    if (!symbolData) {
      return
    }

    const definitionInfo = tss.createDefinitionInfo(currentSourceFile, location)
    if (symbolData.hasDefinitionInfo(definitionInfo)) {
      return
    }

    const reference = builder.vertex.range(
      rangeFromNode(currentSourceFile, location),
      {
        type: RangeTagTypes.reference,
        text: location.getText(),
      }
    )

    currentDocumentData.addRange(reference)
    symbolData.addReference(
      currentSourceFile,
      reference,
      ItemEdgeProperties.references
    )
  }

  const visit = (node: ts.Node) => {
    // console.log(node)

    switch (node.kind) {
      case ts.SyntaxKind.SourceFile:
        currentSourceFile = node as ts.SourceFile
        currentDocumentData = getOrCreateDocumentData(currentSourceFile)
        break
      case ts.SyntaxKind.ModuleDeclaration:
        // TODO
        break
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.InterfaceDeclaration:
      case ts.SyntaxKind.TypeParameter:
      case ts.SyntaxKind.MethodDeclaration:
      case ts.SyntaxKind.MethodSignature:
      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.Parameter:
        // TODO - visit declaration (for document symbols only)
        break
      case ts.SyntaxKind.ExportAssignment:
      case ts.SyntaxKind.Identifier:
      case ts.SyntaxKind.StringLiteral:
        handleSymbol(typeChecker.getSymbolAtLocation(node), node)
        return
    }

    node.forEachChild(visit)

    switch (node.kind) {
      case ts.SyntaxKind.SourceFile:
        currentSourceFile = undefined
        currentDocumentData = undefined
        break
    }
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (isFullContentIgnored(sourceFile)) {
      continue
    }

    console.log(`processing ${sourceFile.fileName}`)
    visit(sourceFile)
  }

  for (const symbolData of symbolDatas.values()) {
    symbolData?.end()
  }
  for (const documentData of documentDatas.values()) {
    documentData?.end()
  }

  emitter.emit(
    builder.edge.contains(
      project,
      Array.from(documentDatas.values()).map(
        (documentData) => documentData!.document
      )
    )
  )

  return Promise.resolve()
}

//
//

export async function main(): Promise<void> {
  return run(ts.sys.args)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

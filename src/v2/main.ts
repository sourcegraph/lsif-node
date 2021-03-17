import { execSync } from 'child_process'
import * as fs from 'fs'
import {
  DefinitionRange,
  DefinitionTag,
  Document,
  ItemEdgeProperties,
  lsp,
  Moniker,
  Range,
  RangeTagTypes,
  ReferenceResult,
  ReferenceTag,
  ResultSet,
  VertexLabels,
} from 'lsif-protocol'
import * as path from 'path'
import ts from 'typescript-lsif'
import { URI } from 'vscode-uri'
import { create as createEmitter, Emitter } from '../emitter'
import { Builder } from '../graph'
import { ExportLinker, ImportLinker } from '../linker'
import { Symbols } from '../lsif'
import PackageJson from '../package'
import * as tss from '../typescripts'
import { TypingsInstaller } from '../typings'
import { FileWriter } from '../writer'

const version = '0.0.1'
const phantomPosition = { line: 0, character: 0 }
const phantomRange = { start: phantomPosition, end: phantomPosition }

type ResolverType =
  | 'alias'
  | 'method'
  | 'standard'
  | 'transient'
  | 'typeAlias'
  | 'unionOrIntersection'

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

class DocumentData {
  private ranges: Range[] = []

  public constructor(
    private builder: Builder,
    private emitter: Emitter,
    public document: Document,
    public monikerPath: string | undefined,
    public externalLibrary: boolean
  ) {}

  public begin(): void {
    this.emitter.emit(this.document)
  }

  public end(): void {
    if (this.ranges.length > 0) {
      this.emitter.emit(this.builder.edge.contains(this.document, this.ranges))
    }
  }

  public addRange(range: Range): void {
    this.ranges.push(range)
  }
}

type ReferenceRangesProperties =
  | ItemEdgeProperties.declarations
  | ItemEdgeProperties.definitions
  | ItemEdgeProperties.references

class SymbolData {
  private definitionInfo: tss.DefinitionInfo[] = []

  private resultSet: ResultSet
  private definitionRanges: DefinitionRange[] = []
  private referenceResults: ReferenceResult[] = []
  private referenceRanges = new Map<ReferenceRangesProperties, Range[]>()

  public constructor(
    private builder: Builder,
    private emitter: Emitter,
    private document: Document
  ) {
    this.resultSet = this.builder.vertex.resultSet()
  }

  public begin(): void {
    this.emitter.emit(this.resultSet)
  }

  public end(): void {
    if (this.definitionRanges.length > 0) {
      const definitionResult = this.builder.vertex.definitionResult()
      const definition = this.builder.edge.definition(
        this.resultSet,
        definitionResult
      )
      const item = this.builder.edge.item(
        definitionResult,
        this.definitionRanges,
        this.document
      )

      this.emitter.emit(definitionResult)
      this.emitter.emit(definition)
      this.emitter.emit(item)
    }

    if (this.referenceRanges.size > 0 || this.referenceResults.length > 0) {
      const referenceResult = this.builder.vertex.referencesResult()
      const references = this.builder.edge.references(
        this.resultSet,
        referenceResult
      )

      this.emitter.emit(referenceResult)
      this.emitter.emit(references)

      if (this.referenceRanges.size > 0) {
        for (const [property, values] of this.referenceRanges.entries()) {
          const item = this.builder.edge.item(
            referenceResult,
            values,
            this.document,
            property
          )
          this.emitter.emit(item)
        }
      } else {
        const item = this.builder.edge.item(
          referenceResult,
          this.referenceResults,
          this.document
        )
        this.emitter.emit(item)
      }
    }
  }

  public hasDefinitionInfo(info: tss.DefinitionInfo): boolean {
    return this.definitionInfo.some((definitionInfo) =>
      tss.DefinitionInfo.equals(info, definitionInfo)
    )
  }

  public addDefinition(
    sourceFile: ts.SourceFile,
    definition: DefinitionRange,
    resolverType: ResolverType,
    recordAsReference = true
  ): void {
    switch (resolverType) {
      // TODO
      // case 'alias':
      //   if (this.rename) {
      //     super.addDefinition(sourceFile, definition, false)
      //   } else {
      //     this.emitter.emit(this.builder.edge.next(definition, this.resultSet))
      //     this.aliased
      //       .getOrCreatePartition(sourceFile)
      //       .addReference(definition, ItemEdgeProperties.references)
      //   }

      // TODO
      // case 'method':
      // TODO - after the following
      // if (this.bases !== undefined) {
      //   for (let base of this.bases) {
      //     base
      //       .getOrCreatePartition(sourceFile)
      //       .addReference(definition, ItemEdgeProperties.definitions)
      //   }
      // }

      case 'transient':
      case 'unionOrIntersection':
        return

      default:
        this.emitter.emit(this.builder.edge.next(definition, this.resultSet))
        this.definitionRanges.push(definition)
        if (recordAsReference) {
          this.addReference(
            sourceFile,
            definition,
            ItemEdgeProperties.definitions,
            resolverType
          )
        }
    }
  }

  public recordDefinitionInfo(
    info: tss.DefinitionInfo,
    resolverType: ResolverType
  ): void {
    switch (resolverType) {
      case 'transient':
      case 'unionOrIntersection':
        return

      default:
        this.definitionInfo.push(info)
    }
  }

  public addReference(
    sourceFile: ts.SourceFile,
    reference: Range | ReferenceResult,
    property: ReferenceRangesProperties,
    resolverType: ResolverType
  ): void {
    switch (resolverType) {
      // TODO
      // case 'alias':
      // if (reference.label === 'range') {
      //     this.emitter.emit(this.builder.edge.next(reference, this.resultSet))
      //   }
      //   this.aliased
      //     .getOrCreatePartition(sourceFile)
      //     .addReference(reference as any, property as any)
      // }

      // TODO
      // case 'method':
      //   if (this.bases !== undefined) {
      //     if (reference.label === 'range') {
      //       this.emitter.emit(this.builder.edge.next(reference, this.resultSet))
      //     }
      //     for (let base of this.bases) {
      //       base
      //         .getOrCreatePartition(sourceFile)
      //         .addReference(reference as any, property as any)
      //     }

      //     break
      //   }
      // fallthrough

      // TODO
      // case 'unionOrIntersection':
      //   if (reference.label === 'range') {
      //     this.emitter.emit(this.builder.edge.next(reference, this.resultSet))
      //   }
      //   for (let element of this.elements) {
      //     element
      //       .getOrCreatePartition(sourceFile)
      //       .addReference(reference as any, property as any)
      //   }
      //   break

      default:
        switch (reference.label) {
          case VertexLabels.range:
            this.emitter.emit(this.builder.edge.next(reference, this.resultSet))
            this.referenceRanges.set(
              property,
              (this.referenceRanges.get(property) || []).concat([reference])
            )
            break

          case VertexLabels.referenceResult:
            this.referenceResults.push(reference)
            break
        }
    }
  }

  public addHover(hover: lsp.Hover): void {
    const hoverResult = this.builder.vertex.hoverResult(hover)
    this.emitter.emit(hoverResult)
    this.emitter.emit(this.builder.edge.hover(this.resultSet, hoverResult))
  }

  public addMoniker(moniker: Moniker): void {
    this.emitter.emit(this.builder.edge.moniker(this.resultSet, moniker))
  }
}

class Indexer {
  private documentDatas = new Map<string, DocumentData | null>()
  private symbolDatas = new Map<string, SymbolData | null>()
  private currentSourceFile: ts.SourceFile | undefined
  private currentDocumentData: DocumentData | undefined
  private symbols: Symbols

  public constructor(
    private builder: Builder,
    private emitter: Emitter,
    private program: ts.Program,
    private typeChecker: ts.TypeChecker,
    private importLinker: ImportLinker,
    private exportLinker: ExportLinker | undefined,
    private languageService: ts.LanguageService,
    private projectRoot: string,
    private rootDir: string,
    private outDir: string,
    private repositoryRoot: string
  ) {
    this.symbols = new Symbols(this.program, this.typeChecker)
  }

  public index(): void {
    const metadata = this.builder.vertex.metaData(
      version,
      URI.file(this.repositoryRoot).toString(true),
      { name: 'lsif-tsc', args: ts.sys.args, version }
    )
    this.emitter.emit(metadata)

    const project = this.builder.vertex.project()
    this.emitter.emit(project)

    for (const sourceFile of this.program.getSourceFiles()) {
      if (this.isFullContentIgnored(sourceFile)) {
        continue
      }

      console.log(`processing ${sourceFile.fileName}`)
      this.visit(sourceFile)
    }

    for (const symbolData of this.symbolDatas.values()) {
      symbolData?.end()
    }
    for (const documentData of this.documentDatas.values()) {
      documentData?.end()
    }

    this.emitter.emit(
      this.builder.edge.contains(
        project,
        Array.from(this.documentDatas.values()).map(
          (documentData) => documentData!.document
        )
      )
    )
  }

  private isFullContentIgnored(sourceFile: ts.SourceFile): boolean {
    return (
      tss.Program.isSourceFileDefaultLibrary(this.program, sourceFile) ||
      tss.Program.isSourceFileFromExternalLibrary(this.program, sourceFile)
    )
  }

  public visit(node: ts.Node): void {
    switch (node.kind) {
      case ts.SyntaxKind.SourceFile:
        this.currentSourceFile = node as ts.SourceFile
        this.currentDocumentData = this.getOrCreateDocumentData(
          this.currentSourceFile
        )
        break

      case ts.SyntaxKind.ModuleDeclaration:
        // TODO - need to do export things?
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
        if (!this.currentSourceFile || !this.currentDocumentData) {
          return
        }

        const symbol = this.typeChecker.getSymbolAtLocation(node)
        if (!symbol) {
          return
        }

        const resolverType = this.resolverType(symbol, node)

        const symbolData = this.getOrCreateSymbolData(
          symbol,
          node,
          resolverType
        )
        if (!symbolData) {
          return
        }

        if (
          symbolData.hasDefinitionInfo(
            tss.createDefinitionInfo(this.currentSourceFile, node)
          )
        ) {
          return
        }

        const tag: ReferenceTag = {
          type: RangeTagTypes.reference,
          text: node.getText(),
        }
        const reference = this.builder.vertex.range(
          rangeFromNode(this.currentSourceFile, node),
          tag
        )

        this.emitter.emit(reference)
        this.currentDocumentData.addRange(reference)
        symbolData.addReference(
          this.currentSourceFile,
          reference,
          ItemEdgeProperties.references,
          resolverType
        )
        return
    }

    node.forEachChild((child) => this.visit(child))

    switch (node.kind) {
      case ts.SyntaxKind.SourceFile:
        this.currentSourceFile = undefined
        this.currentDocumentData = undefined
        break
    }
  }

  private getOrCreateDocumentData(sourceFile: ts.SourceFile): DocumentData {
    const cachedDocumentData = this.documentDatas.get(sourceFile.fileName)
    if (cachedDocumentData) {
      return cachedDocumentData
    }

    const document = this.builder.vertex.document(sourceFile.fileName, '')

    let monikerPath: string | undefined
    let externalLibrary = false
    if (tss.Program.isSourceFileFromExternalLibrary(this.program, sourceFile)) {
      externalLibrary = true
      monikerPath = tss.computeMonikerPath(
        this.projectRoot,
        sourceFile.fileName
      )
    } else {
      monikerPath = this.computeMonikerPath(sourceFile)
    }

    const documentData = new DocumentData(
      this.builder,
      this.emitter,
      document,
      monikerPath,
      externalLibrary
    )
    documentData.begin()
    this.documentDatas.set(sourceFile.fileName, documentData)
    return documentData
  }

  private computeMonikerPath(sourceFile: ts.SourceFile): string | undefined {
    // A real source file inside this project.
    if (
      !sourceFile.isDeclarationFile ||
      (sourceFile.fileName.startsWith(this.rootDir) &&
        sourceFile.fileName.charAt(this.rootDir.length) === '/')
    ) {
      return tss.computeMonikerPath(
        this.projectRoot,
        tss.toOutLocation(sourceFile.fileName, this.rootDir, this.outDir)
      )
    }
    // TODO
    // This can come from a dependent project.
    // let fileName = sourceFile.fileName
    // for (let outDir of this.dependentOutDirs) {
    //   if (fileName.startsWith(outDir)) {
    //     return tss.computeMonikerPath(this.projectRoot, sourceFile.fileName)
    //   }
    // }
    return undefined
  }

  private getOrCreateSymbolData(
    symbol: ts.Symbol,
    node: ts.Node,
    resolverType: ResolverType
  ): SymbolData {
    if (!this.currentDocumentData) {
      throw new Error('illegal symbol context')
    }

    const id = tss.createSymbolKey(this.typeChecker, symbol)
    const cachedSymbolData = this.symbolDatas.get(id)
    if (cachedSymbolData) {
      return cachedSymbolData
    }

    const symbolData = new SymbolData(
      this.builder,
      this.emitter,
      this.currentDocumentData.document
    )
    symbolData.begin()

    //
    //

    const sourceFiles = this.getSourceFiles(symbol, node, resolverType)
    const locationKind = this.symbols.getLocationKind(sourceFiles)
    const exportPath: string | undefined = this.symbols.getExportPath(
      symbol,
      locationKind
    )

    let monikerPath: string | undefined | null
    let externalLibrary = false
    for (const sourceFile of sourceFiles.values()) {
      const documentData = this.getOrCreateDocumentData(sourceFile)
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

    let monikerIdentifier: string | undefined
    if (tss.isSourceFile(symbol) && monikerPath !== undefined) {
      monikerIdentifier = tss.createMonikerIdentifier(monikerPath, undefined)
    } else if (exportPath !== undefined && exportPath !== '') {
      monikerIdentifier = tss.createMonikerIdentifier(monikerPath, exportPath)
    }

    if (monikerIdentifier) {
      if (externalLibrary) {
        const moniker = this.importLinker.handleMoniker2(monikerIdentifier)
        if (moniker) {
          symbolData.addMoniker(moniker)
        }
      } else if (this.exportLinker !== undefined) {
        const moniker = this.exportLinker.handleMoniker2(monikerIdentifier)
        if (moniker) {
          symbolData.addMoniker(moniker)
        }
      }
    }

    for (const declaration of this.getDeclarations(
      symbol,
      node,
      resolverType
    )) {
      const textAndNode = this.getText(symbol, declaration, resolverType)
      if (!textAndNode) {
        continue
      }

      this.emitDefinition(
        declaration,
        symbolData,
        textAndNode.text,
        textAndNode.node,
        resolverType
      )
    }

    this.symbolDatas.set(id, symbolData)
    return symbolData
  }

  // TODO - yuck!
  private resolverType(symbol: ts.Symbol, node: ts.Node): ResolverType {
    if (tss.isTransient(symbol)) {
      if (tss.isComposite(this.typeChecker, symbol, node)) {
        return 'unionOrIntersection'
      }

      // Problem: Symbols that come from the lib*.d.ts files are marked transient
      // as well. Check if the symbol has some other meaningful flags
      if ((symbol.getFlags() & ~ts.SymbolFlags.Transient) === 0) {
        return 'transient'
      }
    }

    return tss.isTypeAlias(symbol)
      ? 'typeAlias'
      : tss.isAliasSymbol(symbol)
      ? 'alias'
      : tss.isMethodSymbol(symbol)
      ? 'method'
      : 'standard'
  }

  private getDeclarations(
    symbol: ts.Symbol,
    node: ts.Node,
    resolverType: ResolverType
  ): ts.Node[] {
    switch (resolverType) {
      case 'transient':
      case 'unionOrIntersection':
        return [node]

      default:
        return symbol.getDeclarations() || []
    }
  }

  private getSourceFiles(
    symbol: ts.Symbol,
    node: ts.Node,
    resolverType: ResolverType
  ): ts.SourceFile[] {
    switch (resolverType) {
      case 'transient':
      case 'unionOrIntersection':
        return [node.getSourceFile()]

      default:
        return Array.from(
          tss.getUniqueSourceFiles(symbol.getDeclarations()).values()
        )
    }
  }

  private getText(
    symbol: ts.Symbol,
    node: ts.Node,
    resolverType: ResolverType
  ): { text: string; node: ts.Node } | undefined {
    switch (resolverType) {
      case 'unionOrIntersection':
        return { text: node.getText(), node }

      default:
        if (tss.isNamedDeclaration(node)) {
          return {
            text: node.name.getText(),
            node: node.name,
          }
        }

        if (tss.isValueModule(symbol) && ts.isSourceFile(node)) {
          return { text: '', node }
        }

        return undefined
    }
  }

  private emitDefinition(
    declaration: ts.Node,
    symbolData: SymbolData,
    text: string,
    node: ts.Node,
    resolverType: ResolverType
  ): void {
    const sourceFile = declaration.getSourceFile()
    const documentData = this.getOrCreateDocumentData(sourceFile)
    const range = ts.isSourceFile(declaration)
      ? phantomRange
      : rangeFromNode(sourceFile, node)
    const tag: DefinitionTag = {
      type: RangeTagTypes.definition,
      text,
      kind: asSymbolKind(declaration),
      fullRange: rangeFromNode(sourceFile, declaration),
    }
    const definition = this.builder.vertex.range(range, tag)
    this.emitter.emit(definition)
    documentData.addRange(definition)
    symbolData.addDefinition(sourceFile, definition, resolverType)
    symbolData.recordDefinitionInfo(
      tss.createDefinitionInfo(sourceFile, node),
      resolverType
    )
    if (tss.isNamedDeclaration(declaration)) {
      const hover = getHover(this.languageService, declaration.name, sourceFile)
      if (hover) {
        symbolData.addHover(hover)
      }
    }
  }
}

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

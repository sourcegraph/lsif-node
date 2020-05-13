/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
// In typescript all paths are /. So use the posix layer only
import * as path from 'path'
import { URI } from 'vscode-uri'
import * as ts from 'typescript-lsif'
import { Symbols } from './symbols'
import {
  Document,
  Edge,
  Id,
  ItemEdgeProperties,
  lsp,
  MonikerKind,
  Project,
  RangeTagTypes,
  Version,
  Vertex,
} from 'lsif-protocol'
import {
  DocumentData,
  ProjectData,
  SymbolData,
  SymbolDataContext,
  SymbolId,
} from './data'
import { version } from '../package.json'
import { Builder, EdgeBuilder, VertexBuilder } from './graph'
import { Emitter, EmitContext } from './emitter'
import * as tss from './typescripts'
import { ExportLinker, ImportLinker } from './linker'
import * as Converter from './conversion'
import {
  AliasResolver,
  MethodResolver,
  ResolverContext,
  StandardResolver,
  SymbolDataResolver,
  TransientResolver,
  TypeAliasResolver,
  UnionOrIntersectionResolver,
} from './resolver'

type Disposable = () => void

export interface Options {
  projectRoot: string
  repositoryRoot: string
  addContents: boolean
}

export class DataManager implements SymbolDataContext {
  public projectData: ProjectData
  public documentStats: number
  public documentDatas: Map<string, DocumentData>
  public symbolStats: number
  public symbolDatas: Map<string, SymbolData>
  public started: Date
  public clearOnNode: Map<ts.Node, SymbolData[]>

  constructor(private context: EmitContext, project: Project) {
    this.projectData = new ProjectData(this, project)
    this.projectData.begin()
    this.documentStats = 0
    this.symbolStats = 0
    this.started = new Date()
    this.documentDatas = new Map()
    this.symbolDatas = new Map()
    this.clearOnNode = new Map()
  }

  public get vertex(): VertexBuilder {
    return this.context.vertex
  }

  public get edge(): EdgeBuilder {
    return this.context.edge
  }

  public emit(element: Vertex | Edge): void {
    this.context.emit(element)
  }

  public getProjectData(): ProjectData {
    return this.projectData
  }

  public getDocumentData(fileName: string): DocumentData | undefined {
    return this.documentDatas.get(fileName)
  }

  public getOrCreateDocumentData(
    fileName: string,
    document: Document,
    monikerPath: string | undefined,
    externalLibrary: boolean
  ): DocumentData {
    let result = this.getDocumentData(fileName)
    if (result === undefined) {
      result = new DocumentData(this, document, monikerPath, externalLibrary)
      this.documentDatas.set(fileName, result)
      result.begin()
      this.projectData.addDocument(document)
      this.documentStats++
    }
    return result
  }

  public getSymbolData(symbolId: SymbolId): SymbolData | undefined {
    return this.symbolDatas.get(symbolId)
  }

  public getOrCreateSymbolData(
    symbolId: SymbolId,
    create: () => SymbolData
  ): SymbolData {
    let result = this.getSymbolData(symbolId)
    if (result === undefined) {
      result = create()
      this.symbolDatas.set(result.getId(), result)
      result.begin()
      this.symbolStats++
    }
    return result
  }

  public manageLifeCycle(node: ts.Node, symbolData: SymbolData): void {
    let datas = this.clearOnNode.get(node)
    if (datas === undefined) {
      datas = []
      this.clearOnNode.set(node, datas)
    }
    datas.push(symbolData)
  }
}

export interface ProjectInfo {
  rootDir: string
  outDir: string
}

class Visitor implements ResolverContext {
  private program: ts.Program
  private typeChecker: ts.TypeChecker

  private builder: Builder
  private project: Project
  private projectRoot: string
  private repositoryRoot: string
  private rootDir: string
  private outDir: string
  private dependentOutDirs: string[]
  private currentSourceFile: ts.SourceFile | undefined
  private _currentDocumentData: DocumentData | undefined
  private symbols: Symbols
  private disposables: Map<string, Disposable[]>
  private dataManager: DataManager
  private symbolDataResolvers: {
    standard: StandardResolver
    alias: AliasResolver
    method: MethodResolver
    unionOrIntersection: UnionOrIntersectionResolver
    transient: TransientResolver
    typeAlias: TypeAliasResolver
  }

  constructor(
    private languageService: ts.LanguageService,
    options: Options,
    dependsOn: ProjectInfo[],
    private emitter: Emitter,
    idGenerator: () => Id,
    private importLinker: ImportLinker,
    private exportLinker: ExportLinker | undefined,
    tsConfigFile: string | undefined
  ) {
    this.program = languageService.getProgram()!
    this.typeChecker = this.program.getTypeChecker()
    this.builder = new Builder({
      idGenerator,
      emitSource: options.addContents,
    })
    this.dependentOutDirs = []
    for (const info of dependsOn) {
      this.dependentOutDirs.push(info.outDir)
    }
    this.dependentOutDirs.sort((a, b) => b.length - a.length)
    this.projectRoot = options.projectRoot
    this.repositoryRoot = options.repositoryRoot
    const toolInfo = {
      name: 'lsif-tsc',
      args: ts.sys.args,
      version,
    }
    this.emit(
      this.vertex.metaData(
        Version,
        URI.file(this.repositoryRoot).toString(true),
        toolInfo
      )
    )
    this.project = this.vertex.project()
    const configLocation =
      tsConfigFile !== undefined ? path.dirname(tsConfigFile) : undefined
    const compilerOptions = this.program.getCompilerOptions()
    if (compilerOptions.rootDir !== undefined) {
      this.rootDir = tss.makeAbsolute(compilerOptions.rootDir, configLocation)
    } else if (compilerOptions.baseUrl !== undefined) {
      this.rootDir = tss.makeAbsolute(compilerOptions.baseUrl, configLocation)
    } else {
      this.rootDir = tss.normalizePath(
        tss.Program.getCommonSourceDirectory(this.program)
      )
    }
    if (compilerOptions.outDir !== undefined) {
      this.outDir = tss.makeAbsolute(compilerOptions.outDir, configLocation)
    } else {
      this.outDir = this.rootDir
    }
    this.dataManager = new DataManager(this, this.project)
    this.symbols = new Symbols(this.program, this.typeChecker)
    this.disposables = new Map()
    this.symbolDataResolvers = {
      standard: new StandardResolver(
        this.typeChecker,
        this.symbols,
        this,
        this.dataManager
      ),
      alias: new AliasResolver(
        this.typeChecker,
        this.symbols,
        this,
        this.dataManager
      ),
      method: new MethodResolver(
        this.typeChecker,
        this.symbols,
        this,
        this.dataManager
      ),
      unionOrIntersection: new UnionOrIntersectionResolver(
        this.typeChecker,
        this.symbols,
        this,
        this.dataManager
      ),
      transient: new TransientResolver(
        this.typeChecker,
        this.symbols,
        this,
        this.dataManager
      ),
      typeAlias: new TypeAliasResolver(
        this.typeChecker,
        this.symbols,
        this,
        this.dataManager
      ),
    }
  }

  public visitProgram(): ProjectInfo {
    const sourceFiles = this.program.getSourceFiles()
    for (const sourceFile of sourceFiles) {
      this.visit(sourceFile)
    }

    for (const entry of this.dataManager.symbolDatas.values()) {
      entry.end()
    }
    for (const entry of this.dataManager.documentDatas.values()) {
      entry.end()
    }
    this.dataManager.projectData.end()
    console.log('')

    const elapsed = new Date().getTime() - this.dataManager.started.getTime()
    console.log(
      `${this.dataManager.documentStats} file(s), ${this.dataManager.symbolStats} symbol(s)`
    )
    console.log(`Processed in ${elapsed / 1000}s`)

    return {
      rootDir: this.rootDir,
      outDir: this.outDir,
    }
  }

  protected visit(node: ts.Node): void {
    const doVisit = <T extends ts.Node>(
      node: T,
      visit: (node: T) => boolean,
      endVisit: (node: T) => void
    ): void => {
      if (visit.call(this, node)) {
        node.forEachChild(child => this.visit(child))
      }
      endVisit.call(this, node)
    }

    switch (node.kind) {
      case ts.SyntaxKind.SourceFile:
        doVisit(
          node as ts.SourceFile,
          this.visitSourceFile.bind(this),
          this.endVisitSourceFile.bind(this)
        )
        break

      case ts.SyntaxKind.Identifier:
      case ts.SyntaxKind.StringLiteral:
        this.handleSymbol(this.typeChecker.getSymbolAtLocation(node), node)
        break

      case ts.SyntaxKind.ExportAssignment:
        doVisit(
          node as ts.ExportAssignment,
          this.visitExportAssignment.bind(this),
          this.endVisitExportAssignment.bind(this)
        )
        break

      default:
        doVisit(
          node,
          this.visitGeneric.bind(this),
          this.endVisitGeneric.bind(this)
        )
        break
    }
  }

  private visitSourceFile(sourceFile: ts.SourceFile): boolean {
    const disposables: Disposable[] = []
    if (this.isFullContentIgnored(sourceFile)) {
      return false
    }
    process.stdout.write('.')

    // things we need to capture to have correct exports
    // `export =` or an `export default` declaration ==> ExportAssignment
    // `exports.bar = function foo() { ... }` ==> ExpressionStatement
    // `export { root }` ==> ExportDeclaration
    // `export { _root as root }` ==> ExportDeclaration
    const processSymbol = (
      disposables: Disposable[],
      parent: ts.Symbol,
      symbol: ts.Symbol
    ): void => {
      if (tss.getSymbolParent(symbol) === undefined) {
        disposables.push(this.symbols.addParent(symbol, parent))
      }
      if (
        parent.exports === undefined ||
        !parent.exports.has(symbol.getName() as ts.__String)
      ) {
        disposables.push(this.symbols.addExport(parent, symbol))
      }
    }
    const exportAssignments: ts.ExportAssignment[] = []
    const sourceFileSymbol = this.typeChecker.getSymbolAtLocation(sourceFile)
    for (const node of sourceFile.statements) {
      if (ts.isExportAssignment(node)) {
        exportAssignments.push(node)
      } else if (
        ts.isExportDeclaration(node) &&
        sourceFileSymbol !== undefined
      ) {
        if (node.exportClause !== undefined) {
          function isNamedExports(
            bindings: ts.NamedExportBindings
          ): bindings is ts.NamedExports {
            return 'elements' in bindings
          }

          const elements = isNamedExports(node.exportClause)
            ? node.exportClause.elements
            : [{ name: node.exportClause.name, propertyName: undefined }]

          for (const { name, propertyName } of elements) {
            const exportSymbol = this.typeChecker.getSymbolAtLocation(name)
            if (exportSymbol === undefined) {
              continue
            }
            processSymbol(disposables, sourceFileSymbol, exportSymbol)
            let localSymbol: ts.Symbol | undefined
            if (propertyName !== undefined) {
              localSymbol = this.typeChecker.getSymbolAtLocation(propertyName)
            } else if (tss.isAliasSymbol(exportSymbol)) {
              localSymbol = this.typeChecker.getAliasedSymbol(exportSymbol)
            }
            if (localSymbol !== undefined) {
              processSymbol(disposables, sourceFileSymbol, localSymbol)
            }
          }
        }
      }
    }
    if (exportAssignments.length > 0) {
      this.handleExportAssignments(exportAssignments)
    }

    this.currentSourceFile = sourceFile
    const documentData = this.getOrCreateDocumentData(sourceFile)
    this._currentDocumentData = documentData
    this.disposables.set(sourceFile.fileName, disposables)
    return true
  }

  private endVisitSourceFile(sourceFile: ts.SourceFile): void {
    if (this.isFullContentIgnored(sourceFile)) {
      return
    }

    this.currentSourceFile = undefined
    this._currentDocumentData = undefined

    for (const disposable of this.disposables.get(sourceFile.fileName)!) {
      disposable()
    }
    this.disposables.delete(sourceFile.fileName)
  }

  public isFullContentIgnored(sourceFile: ts.SourceFile): boolean {
    return (
      tss.Program.isSourceFileDefaultLibrary(this.program, sourceFile) ||
      tss.Program.isSourceFileFromExternalLibrary(this.program, sourceFile)
    )
  }

  private visitExportAssignment(node: ts.ExportAssignment): boolean {
    // Todo@dbaeumer TS compiler doesn't return symbol for export assignment.
    this.handleSymbol(
      this.typeChecker.getSymbolAtLocation(node) || tss.getSymbolFromNode(node),
      node
    )
    return true
  }

  private endVisitExportAssignment(node: ts.ExportAssignment): void {
    // no-op
  }

  private handleExportAssignments(nodes: ts.ExportAssignment[]): void {
    const index = 0 // TODO - suspicious
    for (const node of nodes) {
      const exportSymbol =
        this.typeChecker.getSymbolAtLocation(node) ||
        tss.getSymbolFromNode(node)
      const localSymbol =
        this.typeChecker.getSymbolAtLocation(node.expression) ||
        tss.getSymbolFromNode(node.expression)
      if (exportSymbol !== undefined && localSymbol !== undefined) {
        this.symbols.storeSymbolAlias(localSymbol, {
          alias: exportSymbol,
          name: `${index}_export`,
        })
      }
    }
  }

  private handleSymbol(symbol: ts.Symbol | undefined, location: ts.Node): void {
    if (symbol === undefined) {
      return
    }
    const symbolData = this.getOrCreateSymbolData(symbol, location)
    const sourceFile = this.currentSourceFile!
    if (
      symbolData.hasDefinitionInfo(
        tss.createDefinitionInfo(sourceFile, location)
      )
    ) {
      return
    }

    const reference = this.vertex.range(
      Converter.rangeFromNode(sourceFile, location),
      { type: RangeTagTypes.reference, text: location.getText() }
    )
    this.currentDocumentData.addRange(reference)
    symbolData.addReference(
      sourceFile,
      reference,
      ItemEdgeProperties.references
    )
  }

  private visitGeneric(node: ts.Node): boolean {
    return true
  }

  private endVisitGeneric(node: ts.Node): void {
    const symbol =
      this.typeChecker.getSymbolAtLocation(node) || tss.getSymbolFromNode(node)
    if (symbol === undefined) {
      return
    }
    const id = tss.createSymbolKey(this.typeChecker, symbol)
    let symbolData = this.dataManager.getSymbolData(id)
    if (symbolData !== undefined) {
      this.getResolver(symbol, node).clearForwardSymbolInformation(symbol)
      // Todo@dbaeumer thinks about whether we should add a reference here.
      return
    }
    symbolData = this.getOrCreateSymbolData(symbol)
    const sourceFile = this.currentSourceFile!
    if (
      symbolData.hasDefinitionInfo(tss.createDefinitionInfo(sourceFile, node))
    ) {
      return
    }

    const reference = this.vertex.range(
      Converter.rangeFromNode(sourceFile, node),
      { type: RangeTagTypes.reference, text: node.getText() }
    )
    this.currentDocumentData.addRange(reference)
    symbolData.addReference(
      sourceFile,
      reference,
      ItemEdgeProperties.references
    )
    return
  }

  public getDefinitionAtPosition(
    sourceFile: ts.SourceFile,
    node: ts.Identifier
  ): ReadonlyArray<ts.DefinitionInfo> | undefined {
    return this.languageService.getDefinitionAtPosition(
      sourceFile.fileName,
      node.getStart(sourceFile)
    )
  }

  public getOrCreateDocumentData(sourceFile: ts.SourceFile): DocumentData {
    const computeMonikerPath = (
      sourceFile: ts.SourceFile
    ): string | undefined => {
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
      // This can come from a dependent project.
      const fileName = sourceFile.fileName
      for (const outDir of this.dependentOutDirs) {
        if (fileName.startsWith(outDir)) {
          return tss.computeMonikerPath(this.projectRoot, sourceFile.fileName)
        }
      }
      return undefined
    }

    let result = this.dataManager.getDocumentData(sourceFile.fileName)
    if (result !== undefined) {
      return result
    }

    const document = this.vertex.document(sourceFile.fileName, sourceFile.text)

    let monikerPath: string | undefined
    let library = false
    if (tss.Program.isSourceFileFromExternalLibrary(this.program, sourceFile)) {
      library = true
      monikerPath = tss.computeMonikerPath(
        this.projectRoot,
        sourceFile.fileName
      )
    } else {
      monikerPath = computeMonikerPath(sourceFile)
    }

    result = this.dataManager.getOrCreateDocumentData(
      sourceFile.fileName,
      document,
      monikerPath,
      library
    )
    // In TS source files have symbols and can be referenced in import statements with * imports.
    // So even if we don't parse the source file we need to create a symbol data so that when
    // referenced we have the data.
    const symbol = this.typeChecker.getSymbolAtLocation(sourceFile)
    if (symbol !== undefined) {
      this.getOrCreateSymbolData(symbol, sourceFile)
    }
    return result
  }

  // private hoverCalls: number = 0;
  // private hoverTotal: number = 0;

  public getOrCreateSymbolData(
    symbol: ts.Symbol,
    location?: ts.Node
  ): SymbolData {
    const id: SymbolId = tss.createSymbolKey(this.typeChecker, symbol)
    let result = this.dataManager.getSymbolData(id)
    if (result !== undefined) {
      return result
    }
    const resolver = this.getResolver(symbol, location)
    resolver.forwardSymbolInformation(symbol)
    const declarations: ts.Node[] | undefined = resolver.getDeclarationNodes(
      symbol,
      location
    )
    const sourceFiles: ts.SourceFile[] = resolver.getSourceFiles(
      symbol,
      location
    )
    const locationKind = this.symbols.getLocationKind(sourceFiles)
    const exportPath: string | undefined = this.symbols.getExportPath(
      symbol,
      locationKind
    )
    if (resolver.requiresSourceFile && sourceFiles.length === 0) {
      throw new Error(
        'Resolver requires source file but no source file can be found.'
      )
    }
    // Make sure we create all document data before we create the symbol.
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
    result = this.dataManager.getOrCreateSymbolData(id, () =>
      resolver.requiresSourceFile
        ? resolver.resolve(
            resolver.getPartitionScope(sourceFiles),
            id,
            symbol,
            location
          )
        : resolver.resolve(undefined, id, symbol, location)
    )
    if (declarations === undefined || declarations.length === 0) {
      return result
    }
    // The symbol represents a source file
    let monikerIdentifer: string | undefined
    if (tss.isSourceFile(symbol) && monikerPath !== undefined) {
      monikerIdentifer = tss.createMonikerIdentifier(monikerPath, undefined)
    } else if (exportPath !== undefined && exportPath !== '') {
      monikerIdentifer = tss.createMonikerIdentifier(monikerPath, exportPath)
    }
    if (monikerIdentifer === undefined) {
      result.addMoniker(id, MonikerKind.local)
    } else if (externalLibrary) {
      const moniker = result.addMoniker(monikerIdentifer, MonikerKind.import)
      this.importLinker.handleMoniker(moniker)
    } else {
      const moniker = result.addMoniker(monikerIdentifer, MonikerKind.export)
      if (this.exportLinker !== undefined) {
        this.exportLinker.handleMoniker(moniker)
      }
    }

    let hover: lsp.Hover | undefined
    for (const declaration of declarations) {
      const sourceFile = declaration.getSourceFile()
      const [
        identifierNode,
        identifierText,
      ] = resolver.getIdentifierInformation(sourceFile, symbol, declaration)
      if (identifierNode !== undefined && identifierText !== undefined) {
        const documentData = this.getOrCreateDocumentData(sourceFile)
        const range = ts.isSourceFile(declaration)
          ? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
          : Converter.rangeFromNode(sourceFile, identifierNode)
        const definition = this.vertex.range(range, {
          type: RangeTagTypes.definition,
          text: identifierText,
          kind: Converter.asSymbolKind(declaration),
          fullRange: Converter.rangeFromNode(sourceFile, declaration),
        })
        documentData.addRange(definition)
        result.addDefinition(sourceFile, definition)
        result.recordDefinitionInfo(
          tss.createDefinitionInfo(sourceFile, identifierNode)
        )
        if (hover === undefined && tss.isNamedDeclaration(declaration)) {
          // let start = Date.now();
          hover = this.getHover(declaration.name, sourceFile)
          // this.hoverCalls++;
          // let diff = Date.now() - start;
          // this.hoverTotal += diff;
          // if (diff > 100) {
          // 	console.log(`Computing hover took ${diff} ms for symbol ${id} | ${symbol.getName()} | ${this.hoverCalls} | ${this.hoverTotal}`)
          // }
          if (hover) {
            result.addHover(hover)
          } else {
            // console.log(`Hover returned undefined for $symbol ${id} | ${symbol.getName()}`);
          }
        }
      }
    }
    return result
  }

  private getResolver(
    symbol: ts.Symbol,
    location?: ts.Node
  ): SymbolDataResolver {
    if (location !== undefined && tss.isTransient(symbol)) {
      if (tss.isComposite(this.typeChecker, symbol, location)) {
        return this.symbolDataResolvers.unionOrIntersection
      }

      // Problem: Symbols that come from the lib*.d.ts files are marked transient
      // as well. Check if the symbol has some other meaningful flags
      if ((symbol.getFlags() & ~ts.SymbolFlags.Transient) !== 0) {
        return this.symbolDataResolvers.standard
      }

      return this.symbolDataResolvers.transient
    }
    if (tss.isTypeAlias(symbol)) {
      return this.symbolDataResolvers.typeAlias
    }
    if (tss.isAliasSymbol(symbol)) {
      return this.symbolDataResolvers.alias
    }
    if (tss.isMethodSymbol(symbol)) {
      return this.symbolDataResolvers.method
    }
    return this.symbolDataResolvers.standard
  }

  public getHover(
    node: ts.DeclarationName,
    sourceFile?: ts.SourceFile
  ): lsp.Hover | undefined {
    if (sourceFile === undefined) {
      sourceFile = node.getSourceFile()
    }
    // ToDo@dbaeumer Crashes sometimes with.
    // TypeError: Cannot read property 'kind' of undefined
    // 	at pipelineEmitWithHint (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:84783:39)
    // 	at print (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:84683:13)
    // 	at Object.writeNode (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:84543:13)
    // 	at C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:109134:50
    // 	at Object.mapToDisplayParts (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:97873:13)
    // 	at Object.getSymbolDisplayPartsDocumentationAndSymbolKind (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:109132:61)
    // 	at C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:122472:41
    // 	at Object.runWithCancellationToken (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:31637:28)
    // 	at Object.getQuickInfoAtPosition (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:122471:34)
    // 	at Visitor.getHover (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\lib\lsif.js:1498:46)
    try {
      const quickInfo = this.languageService.getQuickInfoAtPosition(
        node,
        sourceFile
      )
      if (quickInfo === undefined) {
        return undefined
      }
      return Converter.asHover(sourceFile, quickInfo)
    } catch (err) {
      return undefined
    }
  }

  public get vertex(): VertexBuilder {
    return this.builder.vertex
  }

  public get edge(): EdgeBuilder {
    return this.builder.edge
  }

  public emit(element: Vertex | Edge): void {
    this.emitter.emit(element)
  }

  private get currentDocumentData(): DocumentData {
    if (this._currentDocumentData === undefined) {
      throw new Error('No current document partition')
    }
    return this._currentDocumentData
  }
}

export function lsif(
  languageService: ts.LanguageService,
  options: Options,
  dependsOn: ProjectInfo[],
  emitter: Emitter,
  idGenerator: () => Id,
  importLinker: ImportLinker,
  exportLinker: ExportLinker | undefined,
  tsConfigFile: string | undefined
): ProjectInfo | undefined {
  const visitor = new Visitor(
    languageService,
    options,
    dependsOn,
    emitter,
    idGenerator,
    importLinker,
    exportLinker,
    tsConfigFile
  )

  return visitor.visitProgram()
}

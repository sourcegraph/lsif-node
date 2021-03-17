import {
  DefinitionTag,
  ItemEdgeProperties,
  lsp,
  RangeTagTypes,
  ReferenceTag,
} from 'lsif-protocol'
import ts from 'typescript-lsif'
import { URI } from 'vscode-uri'
import { Emitter } from '../emitter'
import { Builder } from '../graph'
import { ExportLinker, ImportLinker } from '../linker'
import { Symbols } from '../lsif'
import * as tss from '../typescripts'
import { DocumentData } from './document'
import { getHover } from './hover'
import { ResolverType, getResolverType } from './resolution'
import { SymbolData } from './symbol'
import { rangeFromNode, phantomRange } from './ranges'

const version = '0.0.1'

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

export class Indexer {
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

        const resolverType = getResolverType(this.typeChecker, symbol, node)

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
      kind: symbolKindMap.get(declaration.kind) || lsp.SymbolKind.Property,
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

import {
  DefinitionTag,
  ItemEdgeProperties,
  lsp,
  RangeTagTypes,
  ReferenceTag,
} from 'lsif-protocol'
import ts from 'typescript-lsif'
import { URI } from 'vscode-uri'
import { Symbols } from '../lsif'
import * as tss from '../typescripts'
import { DocumentData } from './document'
import { getHover } from './hover'
import { ResolverType, getResolverType } from './resolution'
import { SymbolData } from './symbol'
import { rangeFromNode, phantomRange } from './ranges'
import { WriterContext } from './writer'
import { ProgramContext } from './program'
import { PathContext } from './paths'

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
    private writerContext: WriterContext,
    private programContext: ProgramContext,
    private pathContext: PathContext
  ) {
    this.symbols = new Symbols(
      this.programContext.program,
      this.programContext.typeChecker
    )
  }

  public index(): void {
    const metadata = this.writerContext.builder.vertex.metaData(
      version,
      URI.file(this.pathContext.repositoryRoot).toString(true),
      { name: 'lsif-tsc', args: ts.sys.args, version }
    )
    this.writerContext.emitter.emit(metadata)

    const project = this.writerContext.builder.vertex.project()
    this.writerContext.emitter.emit(project)

    for (const sourceFile of this.programContext.program.getSourceFiles()) {
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

    this.writerContext.emitter.emit(
      this.writerContext.builder.edge.contains(
        project,
        Array.from(this.documentDatas.values()).map(
          (documentData) => documentData!.document
        )
      )
    )
  }

  private isFullContentIgnored(sourceFile: ts.SourceFile): boolean {
    return (
      tss.Program.isSourceFileDefaultLibrary(
        this.programContext.program,
        sourceFile
      ) ||
      tss.Program.isSourceFileFromExternalLibrary(
        this.programContext.program,
        sourceFile
      )
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

        const symbol = this.programContext.typeChecker.getSymbolAtLocation(node)
        if (!symbol) {
          return
        }

        const resolverType = getResolverType(
          this.programContext.typeChecker,
          symbol,
          node
        )

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
        const reference = this.writerContext.builder.vertex.range(
          rangeFromNode(this.currentSourceFile, node),
          tag
        )

        this.writerContext.emitter.emit(reference)
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

    const document = this.writerContext.builder.vertex.document(
      sourceFile.fileName,
      ''
    )

    let monikerPath: string | undefined
    let externalLibrary = false
    if (
      tss.Program.isSourceFileFromExternalLibrary(
        this.programContext.program,
        sourceFile
      )
    ) {
      externalLibrary = true
      monikerPath = tss.computeMonikerPath(
        this.pathContext.projectRoot,
        sourceFile.fileName
      )
    } else {
      monikerPath = this.computeMonikerPath(sourceFile)
    }

    const documentData = new DocumentData(
      this.writerContext.builder,
      this.writerContext.emitter,
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
      (sourceFile.fileName.startsWith(this.pathContext.rootDir) &&
        sourceFile.fileName.charAt(this.pathContext.rootDir.length) === '/')
    ) {
      return tss.computeMonikerPath(
        this.pathContext.projectRoot,
        tss.toOutLocation(
          sourceFile.fileName,
          this.pathContext.rootDir,
          this.pathContext.outDir
        )
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

    const id = tss.createSymbolKey(this.programContext.typeChecker, symbol)
    const cachedSymbolData = this.symbolDatas.get(id)
    if (cachedSymbolData) {
      return cachedSymbolData
    }

    // TODO - should check resolve response instead
    const symbolData = new SymbolData(
      this.writerContext.builder,
      this.writerContext.emitter,
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

    const moniker =
      monikerIdentifier &&
      (externalLibrary
        ? this.writerContext?.importLinker.handleMoniker2(monikerIdentifier)
        : this.writerContext?.exportLinker?.handleMoniker2(monikerIdentifier))
    if (moniker) {
      symbolData.addMoniker(moniker)
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
    const definition = this.writerContext.builder.vertex.range(range, tag)
    this.writerContext.emitter.emit(definition)
    documentData.addRange(definition)
    symbolData.addDefinition(sourceFile, definition, resolverType)
    symbolData.recordDefinitionInfo(
      tss.createDefinitionInfo(sourceFile, node),
      resolverType
    )
    if (tss.isNamedDeclaration(declaration)) {
      const hover = getHover(
        this.programContext.languageService,
        declaration.name,
        sourceFile
      )
      if (hover) {
        symbolData.addHover(hover)
      }
    }
  }
}

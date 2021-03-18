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
import { PathContext } from './paths'
import { ProgramContext } from './program'
import { phantomRange, rangeFromNode } from './ranges'
import {
  AliasSymbolData,
  MethodSymbolData,
  SymbolData,
  TransientSymbolData,
  UnionOrIntersectionSymbolData,
} from './symbol'
import { WriterContext } from './writer'

export const version = '0.0.1'

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
      if (
        tss.Program.isSourceFileDefaultLibrary(
          this.programContext.program,
          sourceFile
        ) ||
        tss.Program.isSourceFileFromExternalLibrary(
          this.programContext.program,
          sourceFile
        )
      ) {
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

  private visit(node: ts.Node): void {
    if (this.preVisit(node)) {
      node.forEachChild(this.visit.bind(this))
      this.postVisit(node)
    }
  }

  private preVisit(node: ts.Node): boolean {
    switch (node.kind) {
      case ts.SyntaxKind.SourceFile:
        this.currentSourceFile = node as ts.SourceFile
        this.currentDocumentData = this.getOrCreateDocumentData(
          this.currentSourceFile
        )
        return true

      // TODO - exports
      // case ts.SyntaxKind.ModuleDeclaration:
      //   break

      // TODO - document symbols
      // case ts.SyntaxKind.ClassDeclaration:
      // case ts.SyntaxKind.InterfaceDeclaration:
      // case ts.SyntaxKind.TypeParameter:
      // case ts.SyntaxKind.MethodDeclaration:
      // case ts.SyntaxKind.MethodSignature:
      // case ts.SyntaxKind.FunctionDeclaration:
      // case ts.SyntaxKind.Parameter:
      //   break

      case ts.SyntaxKind.ExportAssignment:
      case ts.SyntaxKind.Identifier:
      case ts.SyntaxKind.StringLiteral:
        this.visitSymbol(node)
        return false

      default:
        return true
    }
  }

  private postVisit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.SourceFile) {
      this.currentSourceFile = undefined
      this.currentDocumentData = undefined
    }
  }

  private visitSymbol(node: ts.Node): void {
    if (!this.currentSourceFile || !this.currentDocumentData) {
      return
    }

    const symbol = this.programContext.typeChecker.getSymbolAtLocation(node)
    if (!symbol) {
      return
    }

    const symbolData = this.getOrCreateSymbolData(symbol, node)
    if (!symbolData) {
      return
    }

    const definitionInfo = tss.createDefinitionInfo(
      this.currentSourceFile,
      node
    )
    if (symbolData.hasDefinitionInfo(definitionInfo)) {
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
      ItemEdgeProperties.references
    )
  }

  private getOrCreateDocumentData(sourceFile: ts.SourceFile): DocumentData {
    const cachedDocumentData = this.documentDatas.get(sourceFile.fileName)
    if (cachedDocumentData) {
      return cachedDocumentData
    }

    const document = this.writerContext.builder.vertex.document(
      sourceFile.fileName
    )

    const externalLibrary = tss.Program.isSourceFileFromExternalLibrary(
      this.programContext.program,
      sourceFile
    )

    const monikerPath = externalLibrary
      ? tss.computeMonikerPath(
          this.pathContext.projectRoot,
          sourceFile.fileName
        )
      : this.computeMonikerPath(sourceFile)

    const documentData = new DocumentData(
      this.writerContext.builder,
      this.writerContext.emitter,
      document,
      externalLibrary,
      monikerPath
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
    // TODO - project references
    // This can come from a dependent project.
    // let fileName = sourceFile.fileName
    // for (let outDir of this.dependentOutDirs) {
    //   if (fileName.startsWith(outDir)) {
    //     return tss.computeMonikerPath(this.projectRoot, sourceFile.fileName)
    //   }
    // }
    return undefined
  }

  private getOrCreateSymbolData(symbol: ts.Symbol, node?: ts.Node): SymbolData {
    if (!this.currentDocumentData) {
      throw new Error('Illegal symbol context')
    }

    const id = tss.createSymbolKey(this.programContext.typeChecker, symbol)
    const cachedSymbolData = this.symbolDatas.get(id)
    if (cachedSymbolData) {
      return cachedSymbolData
    }

    const symbolData = this.makeSymbolData(symbol, node)
    symbolData.begin()

    //
    //

    const sourceFiles = symbolData.getSourceFiles(symbol, node)
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

    for (const declaration of symbolData.getDeclarations(symbol, node)) {
      const textAndNode = symbolData.getText(symbol, declaration)
      if (!textAndNode) {
        continue
      }

      this.emitDefinition(
        declaration,
        symbolData,
        textAndNode.text,
        textAndNode.node
      )
    }

    this.symbolDatas.set(id, symbolData)
    return symbolData
  }

  private makeSymbolData(symbol: ts.Symbol, node?: ts.Node): SymbolData {
    if (!this.currentDocumentData || !this.currentSourceFile) {
      throw new Error('Illegal symbol context')
    }
    const document = this.currentDocumentData.document
    const sourceFile = this.currentSourceFile

    if (tss.isTransient(symbol)) {
      if (tss.isComposite(this.programContext.typeChecker, symbol, node)) {
        const composites = tss.getCompositeSymbols(
          this.programContext.typeChecker,
          symbol,
          node
        )
        if (composites) {
          return new UnionOrIntersectionSymbolData(
            this.writerContext.builder,
            this.writerContext.emitter,
            document,
            composites.map((symbol) => this.getOrCreateSymbolData(symbol)),
            sourceFile
          )
        }
      }

      // Problem: Symbols that come from the lib*.d.ts files are marked transient
      // as well. Check if the symbol has some other meaningful flags
      if ((symbol.getFlags() & ~ts.SymbolFlags.Transient) === 0) {
        return new TransientSymbolData(
          this.writerContext.builder,
          this.writerContext.emitter,
          document
        )
      }
    }

    if (tss.isTypeAlias(symbol)) {
      // TODO - forward symbol information
    }

    if (tss.isAliasSymbol(symbol)) {
      const aliased = this.programContext.typeChecker.getAliasedSymbol(symbol)
      if (aliased !== undefined) {
        const aliasedSymbolData = this.getOrCreateSymbolData(aliased)
        if (aliasedSymbolData) {
          return new AliasSymbolData(
            this.writerContext.builder,
            this.writerContext.emitter,
            document,
            aliasedSymbolData,
            symbol.getName() !== aliased.getName()
          )
        }
      }
    }

    if (tss.isMethodSymbol(symbol)) {
      const container = tss.getSymbolParent(symbol)
      const baseSymbols = (
        (container &&
          this.symbols.findBaseMembers(container, symbol.getName())) ||
        []
      ).map((member) => this.getOrCreateSymbolData(member))

      return new MethodSymbolData(
        this.writerContext.builder,
        this.writerContext.emitter,
        document,
        baseSymbols,
        sourceFile
      )
    }

    return new SymbolData(
      this.writerContext.builder,
      this.writerContext.emitter,
      document
    )
  }

  private emitDefinition(
    declaration: ts.Node,
    symbolData: SymbolData,
    text: string,
    node: ts.Node
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
    symbolData.addDefinition(sourceFile, definition)
    symbolData.addDefinitionInfo(tss.createDefinitionInfo(sourceFile, node))
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

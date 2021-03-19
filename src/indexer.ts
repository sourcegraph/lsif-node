import {
    contains,
    DefinitionRange,
    Document,
    EdgeLabels,
    ElementTypes,
    ItemEdgeProperties,
    lsp,
    MetaData,
    Project,
    RangeTagTypes,
    ReferenceRange,
    ResultSet,
    VertexLabels,
} from 'lsif-protocol'
import ts, { ExportAssignment, ExportDeclaration } from 'typescript-lsif'
import { URI } from 'vscode-uri'
import {
    AliasSymbolData,
    DocumentData,
    MethodSymbolData,
    SymbolData,
    TransientSymbolData,
    UnionOrIntersectionSymbolData,
} from './data'
import {
    computeMonikerPath,
    createDefinitionInfo,
    createMonikerIdentifier,
    createSymbolKey,
    getCompositeSymbols,
    getSymbolFromNode,
    getSymbolParent,
    isAliasSymbol,
    isComposite,
    isMethodSymbol,
    isNamedDeclaration,
    isSourceFile,
    isTransient,
    isTypeAlias,
    makeAbsolute,
    Program,
    Symbols,
    toOutLocation,
} from './debt'
import { Emitter } from './emitter'

export const version = '0.0.1'
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

const joinTexts = (parts: { text: string }[] | undefined): string =>
    (parts || []).map((part) => part.text).join('')

// To get around deprecation
type MarkedString = string | { language: string; value: string }

const getHover = (
    languageService: ts.LanguageService,
    node: ts.DeclarationName,
    sourceFile: ts.SourceFile = node.getSourceFile()
): lsp.Hover | undefined => {
    try {
        const quickInfo = languageService.getQuickInfoAtPosition(
            node,
            sourceFile
        )
        if (quickInfo !== undefined) {
            const contents: MarkedString[] = []
            if (quickInfo.displayParts) {
                contents.push({
                    language: 'typescript',
                    value: joinTexts(quickInfo.displayParts),
                })
            }
            if (quickInfo.documentation && quickInfo.documentation.length > 0) {
                contents.push(joinTexts(quickInfo.documentation))
            }

            return { contents }
        }
    } catch (err) {
        // fallthrough
    }

    return undefined
}

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
        private emitter: Emitter,
        private languageService: ts.LanguageService,
        private program: ts.Program,
        private typeChecker: ts.TypeChecker,
        private projectRoot: string,
        private rootDir: string,
        private outDir: string,
        private repositoryRoot: string
    ) {
        this.symbols = new Symbols(this.program, this.typeChecker)
    }

    public index(): void {
        this.emitter.emit<MetaData>({
            id: -1, // TODO
            type: ElementTypes.vertex,
            label: VertexLabels.metaData,
            version,
            projectRoot: URI.file(this.repositoryRoot).toString(true),
            positionEncoding: 'utf-16',
            toolInfo: { name: 'lsif-tsc', args: ts.sys.args, version },
        })

        const project = this.emitter.emit<Project>({
            id: -1, // TODO
            type: ElementTypes.vertex,
            label: VertexLabels.project,
            kind: 'typescript',
        })

        for (const sourceFile of this.program.getSourceFiles()) {
            if (
                Program.isSourceFileDefaultLibrary(this.program, sourceFile) ||
                Program.isSourceFileFromExternalLibrary(
                    this.program,
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

        this.emitter.emit<contains>({
            id: -1, // TODO
            type: ElementTypes.edge,
            label: EdgeLabels.contains,
            outV: project.id,
            inVs: Array.from(this.documentDatas.values()).map(
                (documentData) => documentData!.document.id
            ),
        })

        // return {
        // 	id: this.tsProject.id,
        // 	sourceRoot: config.sourceRoot,
        // 	outDir: config.outDir,
        // 	references: this.tsProject.references
        // }
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

            // FUTURE: visit these for document symbols
            //
            // case ts.SyntaxKind.ModuleDeclaration:
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
        switch (node.kind) {
            case ts.SyntaxKind.SourceFile:
                this.currentSourceFile = undefined
                this.currentDocumentData = undefined
                break

            // export = foo
            // export default foo
            case ts.SyntaxKind.ExportAssignment:
                if (!this.currentDocumentData) {
                    throw new Error('Illegal statement context')
                }
                const assignmentNode = node as ExportAssignment

                const symbol = this.getSymbolAtLocation(node)
                if (symbol === undefined) {
                    return
                }
                this.getOrCreateSymbolData(symbol)

                const monikerPath = this.currentDocumentData.monikerPath
                if (monikerPath === undefined) {
                    return
                }

                const aliasedSymbol = this.getSymbolAtLocation(
                    assignmentNode.expression
                )
                if (aliasedSymbol === undefined) {
                    return
                }

                this.exportSymbol(
                    aliasedSymbol,
                    monikerPath,
                    this.getExportSymbolName(symbol),
                    this.currentSourceFile
                )
                break

            // `export { foo }` ==> ExportDeclaration
            // `export { _foo as foo }` ==> ExportDeclaration
            case ts.SyntaxKind.ExportDeclaration:
                if (!this.currentDocumentData) {
                    throw new Error('Illegal statement context')
                }
                const declarationNode = node as ExportDeclaration

                if (
                    declarationNode.exportClause !== undefined &&
                    ts.isNamedExports(declarationNode.exportClause)
                ) {
                    for (const element of declarationNode.exportClause
                        .elements) {
                        const symbol = this.getSymbolAtLocation(element.name)
                        if (symbol === undefined) {
                            continue
                        }

                        // TODO - move condition out
                        const monikerPath = this.currentDocumentData.monikerPath
                        if (monikerPath === undefined) {
                            return
                        }

                        // Make sure we have a symbol data
                        this.getOrCreateSymbolData(symbol)

                        const aliasedSymbol =
                            (symbol.getFlags() & ts.SymbolFlags.Alias) !== 0
                                ? this.typeChecker.getAliasedSymbol(symbol)
                                : element.propertyName !== undefined
                                ? this.getSymbolAtLocation(element.propertyName)
                                : undefined
                        if (aliasedSymbol === undefined) {
                            continue
                        }

                        this.exportSymbol(
                            aliasedSymbol,
                            monikerPath,
                            this.getExportSymbolName(symbol),
                            this.currentSourceFile
                        )
                    }
                } else if (declarationNode.moduleSpecifier !== undefined) {
                    const symbol = this.getSymbolAtLocation(declarationNode)
                    if (
                        symbol === undefined ||
                        (symbol.getFlags() & ts.SymbolFlags.ExportStar) === 0
                    ) {
                        return
                    }

                    const monikerPath = this.currentDocumentData.monikerPath
                    if (monikerPath === undefined) {
                        return
                    }
                    this.getOrCreateSymbolData(symbol)
                    const aliasedSymbol = this.getSymbolAtLocation(
                        declarationNode.moduleSpecifier
                    )
                    if (
                        aliasedSymbol === undefined ||
                        !isSourceFile(aliasedSymbol)
                    ) {
                        return
                    }
                    this.getOrCreateSymbolData(aliasedSymbol)
                    this.exportSymbol(
                        aliasedSymbol,
                        monikerPath,
                        '',
                        this.currentSourceFile
                    )
                }
                break
        }
    }

    //
    // TODO - work on these

    private getSymbolAtLocation(node: ts.Node): ts.Symbol | undefined {
        let result = this.typeChecker.getSymbolAtLocation(node)
        if (result === undefined) {
            result = getSymbolFromNode(node)
        }
        return result
    }

    private exportSymbol(
        symbol: ts.Symbol,
        monikerPath: string,
        newName: string | undefined,
        locationNode: ts.Node | undefined
    ): void {
        // TODO
        // const walker = new ExportSymbolWalker(this.context, this.symbols, locationNode, true);
        // const result = walker.walk(symbol, newName ?? symbol.escapedName as string);
        // this.emitAttachedMonikers(monikerPath, result);
    }

    private getExportSymbolName(symbol: ts.Symbol): string {
        let escapedName = symbol.getEscapedName() as string
        if (escapedName.charAt(0) === '"' || escapedName.charAt(0) === "'") {
            escapedName = escapedName.substr(1, escapedName.length - 2)
        }
        // We use `.`as a path separator so escape `.` into `..`
        escapedName = escapedName.replace(new RegExp('\\.', 'g'), '..')
        return escapedName
    }

    //
    //

    private visitSymbol(node: ts.Node): void {
        if (!this.currentSourceFile || !this.currentDocumentData) {
            return
        }

        const symbol = this.typeChecker.getSymbolAtLocation(node)
        if (!symbol) {
            return
        }

        const symbolData = this.getOrCreateSymbolData(symbol, node)
        if (!symbolData) {
            return
        }

        const definitionInfo = createDefinitionInfo(
            this.currentSourceFile,
            node
        )
        if (symbolData.hasDefinitionInfo(definitionInfo)) {
            return
        }

        const referenceRange = this.emitter.emit<ReferenceRange>({
            id: -1, // TODO
            type: ElementTypes.vertex,
            label: VertexLabels.range,
            ...rangeFromNode(this.currentSourceFile, node),
            tag: {
                type: RangeTagTypes.reference,
                text: node.getText(),
            },
        })
        this.currentDocumentData.addRange(referenceRange)
        symbolData.addReference(
            this.currentSourceFile,
            referenceRange,
            ItemEdgeProperties.references
        )
    }

    private getOrCreateDocumentData(sourceFile: ts.SourceFile): DocumentData {
        const externalLibrary = Program.isSourceFileFromExternalLibrary(
            this.program,
            sourceFile
        )

        const monikerPath = externalLibrary
            ? computeMonikerPath(this.projectRoot, sourceFile.fileName)
            : this.computeMonikerPath(sourceFile)

        //
        // TODO: NEW
        //
        // const isFromProjectSources = (sourceFile: ts.SourceFile): boolean => {
        // 	const fileName = sourceFile.fileName;
        // 	return !sourceFile.isDeclarationFile || paths.isParent(sourceRoot, fileName);
        // };

        // const isFromDependentProject = (sourceFile: ts.SourceFile): boolean => {
        // 	if (!sourceFile.isDeclarationFile) {
        // 		return false;
        // 	}
        // 	const fileName = sourceFile.fileName;
        // 	for (let outDir of dependentOutDirs) {
        // 		if (fileName.startsWith(outDir)) {
        // 			return true;
        // 		}
        // 	}
        // 	return false;
        // };

        // const isFromWorkspaceFolder = (sourceFile: ts.SourceFile): boolean => {
        // 	return paths.isParent(workspaceFolder, sourceFile.fileName);
        // };

        // const document = this.vertex.document(sourceFile.fileName, sourceFile.text);
        // const fileName = sourceFile.fileName;

        // let monikerPath: string | undefined;
        // let external: boolean = false;
        // if (this.isSourceFileFromExternalLibrary(sourceFile)) {
        // 	external = true;
        // 	monikerPath = tss.computeMonikerPath(workspaceFolder, fileName);
        // } else if (isFromProjectSources(sourceFile)) {
        // 	monikerPath = tss.computeMonikerPath(workspaceFolder, tss.toOutLocation(fileName, sourceRoot, outDir));
        // } else if (isFromDependentProject(sourceFile)) {
        // 	external = true;
        // 	monikerPath = tss.computeMonikerPath(workspaceFolder, fileName);
        // } else if (isFromWorkspaceFolder(sourceFile)) {
        // 	external = sourceFile.isDeclarationFile;
        // 	monikerPath = tss.computeMonikerPath(workspaceFolder, fileName);
        // }

        // const symbol = this.typeChecker.getSymbolAtLocation(sourceFile);
        // return [manager.createDocumentData(fileName, document, symbol !== undefined ? ModuleSystemKind.module : ModuleSystemKind.global, monikerPath, external, next), symbol];

        const cachedDocumentData = this.documentDatas.get(sourceFile.fileName)
        if (cachedDocumentData) {
            return cachedDocumentData
        }

        const document = this.emitter.emit<Document>({
            id: -1, // TODO
            type: ElementTypes.vertex,
            label: VertexLabels.document,
            uri: URI.file(makeAbsolute(sourceFile.fileName)).toString(true),
            languageId: 'typescript',
        })

        const documentData = new DocumentData(
            this.emitter,
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
            (sourceFile.fileName.startsWith(this.rootDir) &&
                sourceFile.fileName.charAt(this.rootDir.length) === '/')
        ) {
            return computeMonikerPath(
                this.projectRoot,
                toOutLocation(sourceFile.fileName, this.rootDir, this.outDir)
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

    private getOrCreateSymbolData(
        symbol: ts.Symbol,
        node?: ts.Node
    ): SymbolData {
        if (!this.currentDocumentData) {
            throw new Error('Illegal symbol context')
        }

        const id = createSymbolKey(this.typeChecker, symbol)
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
        if (isSourceFile(symbol) && monikerPath !== undefined) {
            monikerIdentifier = createMonikerIdentifier(monikerPath, undefined)
        } else if (exportPath !== undefined && exportPath !== '') {
            monikerIdentifier = createMonikerIdentifier(monikerPath, exportPath)
        }

        const moniker =
            monikerIdentifier &&
            (externalLibrary
                ? this.emitter?.handleImportMoniker(monikerIdentifier)
                : this.emitter?.handleExportMoniker(monikerIdentifier))
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
        const resultSet = this.emitter.emit<ResultSet>({
            id: -1, // TODO
            type: ElementTypes.vertex,
            label: VertexLabels.resultSet,
        })

        if (isTransient(symbol)) {
            if (isComposite(this.typeChecker, symbol, node)) {
                const composites = getCompositeSymbols(
                    this.typeChecker,
                    symbol,
                    node
                )
                if (composites) {
                    return new UnionOrIntersectionSymbolData(
                        this.emitter,
                        document,
                        resultSet,
                        composites.map((symbol) =>
                            this.getOrCreateSymbolData(symbol)
                        ),
                        sourceFile
                    )
                }
            }

            // Problem: Symbols that come from the lib*.d.ts files are marked transient
            // as well. Check if the symbol has some other meaningful flags
            if ((symbol.getFlags() & ~ts.SymbolFlags.Transient) === 0) {
                return new TransientSymbolData(
                    this.emitter,
                    document,
                    resultSet
                )
            }
        }

        if (isTypeAlias(symbol)) {
            // TODO - forward symbol information
        }

        if (isAliasSymbol(symbol)) {
            const aliased = this.typeChecker.getAliasedSymbol(symbol)
            const aliasedSymbolData = this.getOrCreateSymbolData(aliased)
            if (aliasedSymbolData) {
                return new AliasSymbolData(
                    this.emitter,
                    document,
                    resultSet,
                    aliasedSymbolData,
                    symbol.getName() !== aliased.getName()
                )
            }
        }

        if (isMethodSymbol(symbol)) {
            const container = getSymbolParent(symbol)
            const baseSymbols = (
                (container &&
                    this.symbols.findBaseMembers(
                        container,
                        symbol.getName()
                    )) ||
                []
            ).map((member) => this.getOrCreateSymbolData(member))

            return new MethodSymbolData(
                this.emitter,
                document,
                resultSet,
                baseSymbols,
                sourceFile
            )
        }

        return new SymbolData(this.emitter, document, resultSet)
    }

    private emitDefinition(
        declaration: ts.Node,
        symbolData: SymbolData,
        text: string,
        node: ts.Node
    ): void {
        const sourceFile = declaration.getSourceFile()
        const documentData = this.getOrCreateDocumentData(sourceFile)
        const definitionRange = this.emitter.emit<DefinitionRange>({
            id: -1, // TODO
            type: ElementTypes.vertex,
            label: VertexLabels.range,
            ...(ts.isSourceFile(declaration)
                ? phantomRange
                : rangeFromNode(sourceFile, node)),
            tag: {
                type: RangeTagTypes.definition,
                text,
                kind:
                    symbolKindMap.get(declaration.kind) ||
                    lsp.SymbolKind.Property,
                fullRange: rangeFromNode(sourceFile, declaration),
            },
        })
        documentData.addRange(definitionRange)
        symbolData.addDefinition(sourceFile, definitionRange)
        symbolData.addDefinitionInfo(createDefinitionInfo(sourceFile, node))
        if (isNamedDeclaration(declaration)) {
            const hover = getHover(
                this.languageService,
                declaration.name,
                sourceFile
            )
            if (hover) {
                symbolData.addHover(hover)
            }
        }
    }
}

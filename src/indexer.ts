import {
    DefinitionTag,
    ItemEdgeProperties,
    lsp,
    RangeTagTypes,
    ReferenceTag,
} from 'lsif-protocol'
import ts from 'typescript-lsif'
import { URI } from 'vscode-uri'
import { Symbols } from './lsif'
import * as tss from './typescripts'
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
import { Emitter } from './writer'

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
        private emitter: Emitter,
        private programContext: ProgramContext,
        private pathContext: PathContext
    ) {
        this.symbols = new Symbols(
            this.programContext.program,
            this.programContext.typeChecker
        )
    }

    public index(): void {
        const metadata = this.emitter.vertex.metaData(
            version,
            URI.file(this.pathContext.repositoryRoot).toString(true),
            { name: 'lsif-tsc', args: ts.sys.args, version }
        )
        this.emitter.emit(metadata)

        const project = this.emitter.vertex.project()
        this.emitter.emit(project)

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

        this.emitter.emit(
            this.emitter.edge.contains(
                project,
                Array.from(this.documentDatas.values()).map(
                    (documentData) => documentData!.document
                )
            )
        )

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
        if (node.kind === ts.SyntaxKind.SourceFile) {
            this.currentSourceFile = undefined
            this.currentDocumentData = undefined
        }
    }

    //
    // NEW

    // private endVisitExportAssignment(node: ts.ExportAssignment): void {
    // 	// export = foo;
    // 	// export default foo;
    // 	const symbol = this.tsProject.getSymbolAtLocation(node);
    // 	if (symbol === undefined) {
    // 		return;
    // 	}
    // 	// Make sure we have a symbol data;
    // 	this.dataManager.getOrCreateSymbolData(symbol);
    // 	const monikerPath = this.currentDocumentData.monikerPath;
    // 	if (monikerPath === undefined) {
    // 		return;
    // 	}
    // 	const aliasedSymbol = this.tsProject.getSymbolAtLocation(node.expression);
    // 	if (aliasedSymbol === undefined) {
    // 		return;
    // 	}
    // 	const aliasedSymbolData = this.dataManager.getOrCreateSymbolData(aliasedSymbol);
    // 	if (aliasedSymbolData === undefined) {
    // 		return;
    // 	}
    // 	aliasedSymbolData.changeVisibility(SymbolDataVisibility.indirectExported);
    // 	this.tsProject.exportSymbol(aliasedSymbol, monikerPath, this.tsProject.getExportSymbolName(symbol), this.currentSourceFile);
    // }

    //
    // NEW

    // private endVisitExportDeclaration(node: ts.ExportDeclaration): void {
    // 	// `export { foo }` ==> ExportDeclaration
    // 	// `export { _foo as foo }` ==> ExportDeclaration
    // 	if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
    // 		for (const element of node.exportClause.elements) {
    // 			const symbol = this.tsProject.getSymbolAtLocation(element.name);
    // 			if (symbol === undefined) {
    // 				continue;
    // 			}
    // 			const monikerPath = this.currentDocumentData.monikerPath;
    // 			if (monikerPath === undefined) {
    // 				return;
    // 			}
    // 			// Make sure we have a symbol data;
    // 			this.dataManager.getOrCreateSymbolData(symbol);
    // 			const aliasedSymbol = Symbols.isAliasSymbol(symbol)
    // 				? this.tsProject.getAliasedSymbol(symbol)
    // 				: element.propertyName !== undefined
    // 					? this.tsProject.getSymbolAtLocation(element.propertyName)
    // 					: undefined;
    // 			if (aliasedSymbol === undefined) {
    // 				continue;
    // 			}
    // 			const aliasedSymbolData = this.dataManager.getOrCreateSymbolData(aliasedSymbol);
    // 			if (aliasedSymbolData === undefined) {
    // 				return;
    // 			}
    // 			aliasedSymbolData.changeVisibility(SymbolDataVisibility.indirectExported);
    // 			this.tsProject.exportSymbol(aliasedSymbol, monikerPath, this.tsProject.getExportSymbolName(symbol), this.currentSourceFile);
    // 		}
    // 	} else if (node.moduleSpecifier !== undefined) {
    // 		const symbol = this.tsProject.getSymbolAtLocation(node);
    // 		if (symbol === undefined || !Symbols.isExportStar(symbol)) {
    // 			return;
    // 		}
    // 		const monikerPath = this.currentDocumentData.monikerPath;
    // 		if (monikerPath === undefined) {
    // 			return;
    // 		}
    // 		this.dataManager.getOrCreateSymbolData(symbol);
    // 		const aliasedSymbol = this.tsProject.getSymbolAtLocation(node.moduleSpecifier);
    // 		if (aliasedSymbol === undefined || !Symbols.isSourceFile(aliasedSymbol)) {
    // 			return;
    // 		}
    // 		this.dataManager.getOrCreateSymbolData(aliasedSymbol);
    // 		this.tsProject.exportSymbol(aliasedSymbol, monikerPath, '', this.currentSourceFile);
    // 	}
    // }

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
        const reference = this.emitter.vertex.range(
            rangeFromNode(this.currentSourceFile, node),
            tag
        )

        this.emitter.emit(reference)
        this.currentDocumentData.addRange(reference)
        symbolData.addReference(
            this.currentSourceFile,
            reference,
            ItemEdgeProperties.references
        )
    }

    private getOrCreateDocumentData(sourceFile: ts.SourceFile): DocumentData {
        //
        // NEW

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

        const document = this.emitter.vertex.document(sourceFile.fileName)

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
            (sourceFile.fileName.startsWith(this.pathContext.rootDir) &&
                sourceFile.fileName.charAt(this.pathContext.rootDir.length) ===
                    '/')
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

    private getOrCreateSymbolData(
        symbol: ts.Symbol,
        node?: ts.Node
    ): SymbolData {
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
            monikerIdentifier = tss.createMonikerIdentifier(
                monikerPath,
                undefined
            )
        } else if (exportPath !== undefined && exportPath !== '') {
            monikerIdentifier = tss.createMonikerIdentifier(
                monikerPath,
                exportPath
            )
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

        if (tss.isTransient(symbol)) {
            if (
                tss.isComposite(this.programContext.typeChecker, symbol, node)
            ) {
                const composites = tss.getCompositeSymbols(
                    this.programContext.typeChecker,
                    symbol,
                    node
                )
                if (composites) {
                    return new UnionOrIntersectionSymbolData(
                        this.emitter,
                        document,
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
                return new TransientSymbolData(this.emitter, document)
            }
        }

        if (tss.isTypeAlias(symbol)) {
            // TODO - forward symbol information
        }

        if (tss.isAliasSymbol(symbol)) {
            const aliased = this.programContext.typeChecker.getAliasedSymbol(
                symbol
            )
            const aliasedSymbolData = this.getOrCreateSymbolData(aliased)
            if (aliasedSymbolData) {
                return new AliasSymbolData(
                    this.emitter,
                    document,
                    aliasedSymbolData,
                    symbol.getName() !== aliased.getName()
                )
            }
        }

        if (tss.isMethodSymbol(symbol)) {
            const container = tss.getSymbolParent(symbol)
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
                baseSymbols,
                sourceFile
            )
        }

        return new SymbolData(this.emitter, document)
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
            kind:
                symbolKindMap.get(declaration.kind) || lsp.SymbolKind.Property,
            fullRange: rangeFromNode(sourceFile, declaration),
        }
        const definition = this.emitter.vertex.range(range, tag)
        this.emitter.emit(definition)
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

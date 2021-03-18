/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
// In typescript all paths are /. So use the posix layer only

import ts from 'typescript-lsif'
import LRUCache from 'lru-cache'
import * as tss from './typescripts'

interface Disposable {
    (): void
}

enum LocationKind {
    tsLibrary = 1,
    module = 2,
    global = 3,
}

interface SymbolAlias {
    /**
     * The alias symbol. For example the symbol representing `default` in
     * a statement like `export default product` or the symbol representing
     * `MyTypeName` in a type declarartion statement like `type MyTypeName = { x: number }`
     */
    alias: ts.Symbol
    name: string
}

export class Symbols {
    private baseSymbolCache: LRUCache<string, ts.Symbol[]>
    private baseMemberCache: LRUCache<string, LRUCache<string, ts.Symbol[]>>
    private exportedPaths: LRUCache<ts.Symbol, string | null>
    private symbolAliases: Map<string, SymbolAlias>
    private parents: Map<string, ts.Symbol>
    private exports: Map<string, Set<string>>
    private sourceFilesContainingAmbientDeclarations: Set<string>

    constructor(
        private program: ts.Program,
        private typeChecker: ts.TypeChecker
    ) {
        this.baseSymbolCache = new LRUCache(2048)
        this.baseMemberCache = new LRUCache(2048)
        this.exportedPaths = new LRUCache(2048)
        this.symbolAliases = new Map()
        this.parents = new Map()
        this.exports = new Map()
        this.sourceFilesContainingAmbientDeclarations = new Set()

        const ambientModules = this.typeChecker.getAmbientModules()
        for (let module of ambientModules) {
            const declarations = module.getDeclarations()
            if (declarations !== undefined) {
                for (let declarartion of declarations) {
                    const sourceFile = declarartion.getSourceFile()
                    this.sourceFilesContainingAmbientDeclarations.add(
                        sourceFile.fileName
                    )
                }
            }
        }
    }

    public storeSymbolAlias(symbol: ts.Symbol, typeAlias: SymbolAlias): void {
        const key = tss.createSymbolKey(this.typeChecker, symbol)
        this.symbolAliases.set(key, typeAlias)
    }

    public hasSymbolAlias(symbol: ts.Symbol): boolean {
        const key = tss.createSymbolKey(this.typeChecker, symbol)
        return this.symbolAliases.has(key)
    }

    public deleteSymbolAlias(symbol: ts.Symbol): void {
        const key = tss.createSymbolKey(this.typeChecker, symbol)
        this.symbolAliases.delete(key)
    }

    public addParent(symbol: ts.Symbol, parent: ts.Symbol): Disposable {
        const key = tss.createSymbolKey(this.typeChecker, symbol)
        this.parents.set(key, parent)
        return () => {
            this.parents.delete(key)
        }
    }

    private getParent(symbol: ts.Symbol): ts.Symbol | undefined {
        let result = tss.getSymbolParent(symbol)
        if (result !== undefined) {
            return result
        }
        return this.parents.get(tss.createSymbolKey(this.typeChecker, symbol))
    }

    public addExport(parent: ts.Symbol, symbol: ts.Symbol): Disposable {
        const parentKey = tss.createSymbolKey(this.typeChecker, parent)
        const symbolKey = tss.createSymbolKey(this.typeChecker, symbol)
        let values = this.exports.get(parentKey)
        if (values === undefined) {
            values = new Set()
            this.exports.set(parentKey, values)
        }
        values.add(symbolKey)
        return () => {
            let values = this.exports.get(parentKey)
            if (values === undefined) {
                return
            }
            values.delete(symbolKey)
            if (values.size === 0) {
                this.exports.delete(parentKey)
            }
        }
    }

    private isExported(parent: ts.Symbol, symbol: ts.Symbol): boolean {
        if (
            parent.exports !== undefined &&
            parent.exports.has(symbol.getName() as ts.__String)
        ) {
            return true
        }
        let exports = this.exports.get(
            tss.createSymbolKey(this.typeChecker, parent)
        )
        return (
            exports !== undefined &&
            exports.has(tss.createSymbolKey(this.typeChecker, symbol))
        )
    }

    public getBaseSymbols(symbol: ts.Symbol): ts.Symbol[] | undefined {
        const key = tss.createSymbolKey(this.typeChecker, symbol)
        let result = this.baseSymbolCache.get(key)
        if (result === undefined) {
            if (tss.isTypeLiteral(symbol)) {
                // ToDo@dirk: compute base symbols for type literals.
                return undefined
            } else if (tss.isInterface(symbol)) {
                result = this.computeBaseSymbolsForInterface(symbol)
            } else if (tss.isClass(symbol)) {
                result = this.computeBaseSymbolsForClass(symbol)
            }
            if (result !== undefined) {
                this.baseSymbolCache.set(key, result)
            }
        }
        return result
    }

    private computeBaseSymbolsForClass(
        symbol: ts.Symbol
    ): ts.Symbol[] | undefined {
        let result: ts.Symbol[] = []
        let declarations = symbol.getDeclarations()
        if (declarations === undefined) {
            return undefined
        }
        let typeChecker = this.typeChecker
        for (let declaration of declarations) {
            if (ts.isClassDeclaration(declaration)) {
                let heritageClauses = declaration.heritageClauses
                if (heritageClauses) {
                    for (let heritageClause of heritageClauses) {
                        for (let type of heritageClause.types) {
                            let tsType = typeChecker.getTypeAtLocation(
                                type.expression
                            )
                            if (tsType !== undefined) {
                                let baseSymbol = tsType.getSymbol()
                                if (
                                    baseSymbol !== undefined &&
                                    baseSymbol !== symbol
                                ) {
                                    result.push(baseSymbol)
                                }
                            }
                        }
                    }
                }
            }
        }
        return result.length === 0 ? undefined : result
    }

    private computeBaseSymbolsForInterface(
        symbol: ts.Symbol
    ): ts.Symbol[] | undefined {
        let result: ts.Symbol[] = []
        let tsType = this.typeChecker.getDeclaredTypeOfSymbol(symbol)
        if (tsType === undefined) {
            return undefined
        }
        let baseTypes = tsType.getBaseTypes()
        if (baseTypes !== undefined) {
            for (let base of baseTypes) {
                let symbol = base.getSymbol()
                if (symbol) {
                    result.push(symbol)
                }
            }
        }
        return result.length === 0 ? undefined : result
    }

    public findBaseMembers(
        symbol: ts.Symbol,
        memberName: string
    ): ts.Symbol[] | undefined {
        let key = tss.createSymbolKey(this.typeChecker, symbol)
        let cache = this.baseMemberCache.get(key)
        if (cache === undefined) {
            cache = new LRUCache(64)
            this.baseMemberCache.set(key, cache)
        }
        let result: ts.Symbol[] | undefined = cache.get(memberName)
        if (result === undefined) {
            let baseSymbols = this.getBaseSymbols(symbol)
            if (baseSymbols !== undefined) {
                for (let base of baseSymbols) {
                    if (!base.members) {
                        continue
                    }
                    let method = base.members.get(memberName as ts.__String)
                    if (method !== undefined) {
                        if (result === undefined) {
                            result = [method]
                        } else {
                            result.push(method)
                        }
                    } else {
                        let baseResult = this.findBaseMembers(base, memberName)
                        if (baseResult !== undefined) {
                            if (result === undefined) {
                                result = baseResult
                            } else {
                                result.push(...baseResult)
                            }
                        }
                    }
                }
            }
            if (result !== undefined) {
                cache.set(memberName, result)
            } else {
                cache.set(memberName, [])
            }
        } else if (result.length === 0) {
            return undefined
        }
        return result
    }

    public getExportPath(
        symbol: ts.Symbol,
        kind: LocationKind | undefined
    ): string | undefined {
        let result = this.exportedPaths.get(symbol)
        if (result !== undefined) {
            return result === null ? undefined : result
        }
        if (tss.isSourceFile(symbol)) {
            this.exportedPaths.set(symbol, '')
            return ''
        }
        let parent = this.getParent(symbol)
        if (parent === undefined) {
            if (
                tss.isValueModule(symbol) ||
                kind === LocationKind.tsLibrary ||
                kind === LocationKind.global
            ) {
                this.exportedPaths.set(symbol, symbol.getName())
                return symbol.getName()
            }
            const typeAlias = this.symbolAliases.get(
                tss.createSymbolKey(this.typeChecker, symbol)
            )
            if (
                typeAlias !== undefined &&
                this.getExportPath(typeAlias.alias, kind) !== undefined
            ) {
                this.exportedPaths.set(symbol, typeAlias.name)
                return typeAlias.name
            }
            this.exportedPaths.set(symbol, null)
            return undefined
        } else {
            let parentValue = this.getExportPath(parent, kind)
            // The parent is not exported so any member isn't either
            if (parentValue === undefined) {
                this.exportedPaths.set(symbol, null)
                return undefined
            } else {
                if (
                    tss.isInterface(parent) ||
                    tss.isClass(parent) ||
                    tss.isTypeLiteral(parent)
                ) {
                    result = `${parentValue}.${symbol.getName()}`
                    this.exportedPaths.set(symbol, result)
                    return result
                } else if (this.isExported(parent, symbol)) {
                    result =
                        parentValue.length > 0
                            ? `${parentValue}.${symbol.getName()}`
                            : symbol.getName()
                    this.exportedPaths.set(symbol, result)
                    return result
                } else {
                    this.exportedPaths.set(symbol, null)
                    return undefined
                }
            }
        }
    }

    public getLocationKind(
        sourceFiles: ts.SourceFile[]
    ): LocationKind | undefined {
        if (sourceFiles.length === 0) {
            return undefined
        }
        let tsLibraryCount: number = 0
        let moduleCount: number = 0
        let externalLibraryCount: number = 0
        let declarationFileCount: number = 0
        for (let sourceFile of sourceFiles) {
            if (
                this.typeChecker.getSymbolAtLocation(sourceFile) !== undefined
            ) {
                moduleCount++
                continue
            }
            if (
                tss.Program.isSourceFileDefaultLibrary(this.program, sourceFile)
            ) {
                tsLibraryCount++
                continue
            }
            if (
                tss.Program.isSourceFileFromExternalLibrary(
                    this.program,
                    sourceFile
                )
            ) {
                externalLibraryCount++
                continue
            }
            if (
                sourceFile.isDeclarationFile &&
                !this.sourceFilesContainingAmbientDeclarations.has(
                    sourceFile.fileName
                )
            ) {
                declarationFileCount++
                continue
            }
        }
        const numberOfFiles = sourceFiles.length
        if (moduleCount === numberOfFiles) {
            return LocationKind.module
        }
        if (tsLibraryCount === numberOfFiles) {
            return LocationKind.tsLibrary
        }
        if (
            (externalLibraryCount === numberOfFiles ||
                declarationFileCount === numberOfFiles) &&
            moduleCount === 0
        ) {
            return LocationKind.global
        }
        return undefined
    }
}

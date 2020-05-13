/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as ts from 'typescript-lsif'
import * as tss from './typescripts'

type Disposable = () => void

export enum LocationKind {
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
  private baseSymbolCache: Map<string, ts.Symbol[]>
  private baseMemberCache: Map<string, Map<string, ts.Symbol[]>>
  private exportedPaths: Map<ts.Symbol, string | null>
  private symbolAliases: Map<string, SymbolAlias>
  private parents: Map<string, ts.Symbol>
  private exports: Map<string, Set<string>>
  private sourceFilesContainingAmbientDeclarations: Set<string>

  constructor(
    private program: ts.Program,
    private typeChecker: ts.TypeChecker
  ) {
    this.baseSymbolCache = new Map()
    this.baseMemberCache = new Map()
    this.exportedPaths = new Map()
    this.symbolAliases = new Map()
    this.parents = new Map()
    this.exports = new Map()
    this.sourceFilesContainingAmbientDeclarations = new Set()

    const ambientModules = this.typeChecker.getAmbientModules()
    for (const module of ambientModules) {
      const declarations = module.getDeclarations()
      if (declarations !== undefined) {
        for (const declarartion of declarations) {
          const sourceFile = declarartion.getSourceFile()
          this.sourceFilesContainingAmbientDeclarations.add(sourceFile.fileName)
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
    const result = tss.getSymbolParent(symbol)
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
      const values = this.exports.get(parentKey)
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
    if (parent.exports?.has(symbol.getName() as ts.__String)) {
      return true
    }
    const exports = this.exports.get(
      tss.createSymbolKey(this.typeChecker, parent)
    )
    return Boolean(exports?.has(tss.createSymbolKey(this.typeChecker, symbol)))
  }

  public getBaseSymbols(symbol: ts.Symbol): ts.Symbol[] | undefined {
    const key = tss.createSymbolKey(this.typeChecker, symbol)
    let result = this.baseSymbolCache.get(key)
    if (result === undefined) {
      if (tss.isTypeLiteral(symbol)) {
        // ToDo@dirk: compute base symbols for type literals.
        return undefined
      }
      if (tss.isInterface(symbol)) {
        result = this.computeBaseSymbolsForInterface(symbol)
      }
      if (tss.isClass(symbol)) {
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
    const result: ts.Symbol[] = []
    const declarations = symbol.getDeclarations()
    if (declarations === undefined) {
      return undefined
    }
    const typeChecker = this.typeChecker
    for (const declaration of declarations) {
      if (ts.isClassDeclaration(declaration)) {
        const heritageClauses = declaration.heritageClauses
        if (heritageClauses) {
          for (const heritageClause of heritageClauses) {
            for (const type of heritageClause.types) {
              const tsType = typeChecker.getTypeAtLocation(type.expression)
              const baseSymbol = tsType.getSymbol()
              if (baseSymbol !== undefined && baseSymbol !== symbol) {
                result.push(baseSymbol)
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
    const result: ts.Symbol[] = []
    const tsType = this.typeChecker.getDeclaredTypeOfSymbol(symbol)

    const baseTypes = tsType.getBaseTypes()
    if (baseTypes !== undefined) {
      for (const base of baseTypes) {
        const symbol = base.getSymbol()
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
    const key = tss.createSymbolKey(this.typeChecker, symbol)
    let cache = this.baseMemberCache.get(key)
    if (cache === undefined) {
      cache = new Map()
      this.baseMemberCache.set(key, cache)
    }
    let result: ts.Symbol[] | undefined = cache.get(memberName)
    if (result === undefined) {
      const baseSymbols = this.getBaseSymbols(symbol)
      if (baseSymbols !== undefined) {
        for (const base of baseSymbols) {
          if (!base.members) {
            continue
          }
          const method = base.members.get(memberName as ts.__String)
          if (method !== undefined) {
            if (result === undefined) {
              result = [method]
            } else {
              result.push(method)
            }
          } else {
            const baseResult = this.findBaseMembers(base, memberName)
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
    const parent = this.getParent(symbol)
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
    }

    const parentValue = this.getExportPath(parent, kind)
    // The parent is not exported so any member isn't either
    if (parentValue === undefined) {
      this.exportedPaths.set(symbol, null)
      return undefined
    }

    if (
      tss.isInterface(parent) ||
      tss.isClass(parent) ||
      tss.isTypeLiteral(parent)
    ) {
      result = `${parentValue}.${symbol.getName()}`
      this.exportedPaths.set(symbol, result)
      return result
    }

    if (this.isExported(parent, symbol)) {
      result =
        parentValue.length > 0
          ? `${parentValue}.${symbol.getName()}`
          : symbol.getName()
      this.exportedPaths.set(symbol, result)
      return result
    }

    this.exportedPaths.set(symbol, null)
    return undefined
  }

  public getLocationKind(
    sourceFiles: ts.SourceFile[]
  ): LocationKind | undefined {
    if (sourceFiles.length === 0) {
      return undefined
    }
    let tsLibraryCount = 0
    let moduleCount = 0
    let externalLibraryCount = 0
    let declarationFileCount = 0
    for (const sourceFile of sourceFiles) {
      if (this.typeChecker.getSymbolAtLocation(sourceFile) !== undefined) {
        moduleCount++
        continue
      }
      if (tss.Program.isSourceFileDefaultLibrary(this.program, sourceFile)) {
        tsLibraryCount++
        continue
      }
      if (
        tss.Program.isSourceFileFromExternalLibrary(this.program, sourceFile)
      ) {
        externalLibraryCount++
        continue
      }
      if (
        sourceFile.isDeclarationFile &&
        !this.sourceFilesContainingAmbientDeclarations.has(sourceFile.fileName)
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

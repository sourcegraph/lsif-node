/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as ts from 'typescript-lsif'
import { Symbols } from './symbols'
import {
  AliasedSymbolData,
  MethodSymbolData,
  StandardSymbolData,
  SymbolData,
  SymbolDataContext,
  SymbolId,
  TransientSymbolData,
  UnionOrIntersectionSymbolData,
} from './data'
import * as tss from './typescripts'

export interface ResolverContext {
  getOrCreateSymbolData(symbol: ts.Symbol, location?: ts.Node): SymbolData
}

export abstract class SymbolDataResolver {
  constructor(
    protected typeChecker: ts.TypeChecker,
    protected symbols: Symbols,
    protected resolverContext: ResolverContext,
    protected symbolDataContext: SymbolDataContext
  ) {}

  public abstract requiresSourceFile: boolean

  public forwardSymbolInformation(symbol: ts.Symbol): void {}

  public clearForwardSymbolInformation(symbol: ts.Symbol): void {}

  public getDeclarationNodes(
    symbol: ts.Symbol,
    location?: ts.Node
  ): ts.Node[] | undefined {
    return symbol.getDeclarations()
  }

  public getSourceFiles(
    symbol: ts.Symbol,
    location?: ts.Node
  ): ts.SourceFile[] {
    const sourceFiles = tss.getUniqueSourceFiles(symbol.getDeclarations())
    if (sourceFiles.size === 0) {
      return []
    }
    return Array.from(sourceFiles.values())
  }

  public getPartitionScope(sourceFiles: ts.SourceFile[]): ts.SourceFile {
    if (sourceFiles.length === 0) {
      throw new Error('No source file selection provided')
    }
    return sourceFiles[0]
  }

  public getIdentifierInformation(
    sourceFile: ts.SourceFile,
    symbol: ts.Symbol,
    declaration: ts.Node
  ): [ts.Node, string] | [undefined, undefined] {
    if (tss.isNamedDeclaration(declaration)) {
      const name = declaration.name
      return [name, name.getText()]
    }
    if (tss.isValueModule(symbol) && ts.isSourceFile(declaration)) {
      return [declaration, '']
    }
    return [undefined, undefined]
  }

  public abstract resolve(
    sourceFile: ts.SourceFile | undefined,
    id: SymbolId,
    symbol: ts.Symbol,
    location?: ts.Node,
  ): SymbolData
}

export class StandardResolver extends SymbolDataResolver {
  constructor(
    typeChecker: ts.TypeChecker,
    protected symbols: Symbols,
    resolverContext: ResolverContext,
    symbolDataContext: SymbolDataContext
  ) {
    super(typeChecker, symbols, resolverContext, symbolDataContext)
  }

  public get requiresSourceFile(): boolean {
    return false
  }

  public resolve(
    sourceFile: ts.SourceFile | undefined,
    id: SymbolId,
    symbol: ts.Symbol,
    location?: ts.Node,
  ): SymbolData {
    return new StandardSymbolData(this.symbolDataContext, id)
  }
}

export class AliasResolver extends SymbolDataResolver {
  constructor(
    typeChecker: ts.TypeChecker,
    protected symbols: Symbols,
    resolverContext: ResolverContext,
    symbolDataContext: SymbolDataContext
  ) {
    super(typeChecker, symbols, resolverContext, symbolDataContext)
  }

  public get requiresSourceFile(): boolean {
    return false
  }

  public resolve(
    sourceFile: ts.SourceFile | undefined,
    id: SymbolId,
    symbol: ts.Symbol,
    location?: ts.Node,
  ): SymbolData {
    const aliased = this.typeChecker.getAliasedSymbol(symbol)
    const aliasedSymbolData = this.resolverContext.getOrCreateSymbolData(
      aliased
    )
    return new AliasedSymbolData(
      this.symbolDataContext,
      id,
      aliasedSymbolData,
      symbol.getName() !== aliased.getName()
    )
  }
}

export class MethodResolver extends SymbolDataResolver {
  constructor(
    typeChecker: ts.TypeChecker,
    protected symbols: Symbols,
    resolverContext: ResolverContext,
    symbolDataContext: SymbolDataContext
  ) {
    super(typeChecker, symbols, resolverContext, symbolDataContext)
  }

  public get requiresSourceFile(): boolean {
    return true
  }

  public resolve(
    sourceFile: ts.SourceFile,
    id: SymbolId,
    symbol: ts.Symbol,
    location?: ts.Node,
  ): SymbolData {
    // console.log(`MethodResolver#resolve for symbol ${id} | ${symbol.getName()}`);
    const container = tss.getSymbolParent(symbol)
    if (container === undefined) {
      return new MethodSymbolData(
        this.symbolDataContext,
        id,
        sourceFile,
        undefined,
      )
    }
    const baseMembers = this.symbols.findBaseMembers(
      container,
      symbol.getName()
    )
    if (baseMembers === undefined || baseMembers.length === 0) {
      return new MethodSymbolData(
        this.symbolDataContext,
        id,
        sourceFile,
        undefined,
      )
    }
    const baseSymbolData = baseMembers.map(member =>
      this.resolverContext.getOrCreateSymbolData(member)
    )
    return new MethodSymbolData(
      this.symbolDataContext,
      id,
      sourceFile,
      baseSymbolData,
    )
  }
}

export class UnionOrIntersectionResolver extends SymbolDataResolver {
  constructor(
    typeChecker: ts.TypeChecker,
    protected symbols: Symbols,
    resolverContext: ResolverContext,
    symbolDataContext: SymbolDataContext
  ) {
    super(typeChecker, symbols, resolverContext, symbolDataContext)
  }

  public get requiresSourceFile(): boolean {
    return true
  }

  public getDeclarationNodes(
    symbol: ts.Symbol,
    location?: ts.Node
  ): ts.Node[] | undefined {
    if (location === undefined) {
      throw new Error('Union or intersection resolver requires a location')
    }
    return [location]
  }

  public getSourceFiles(
    symbol: ts.Symbol,
    location?: ts.Node
  ): ts.SourceFile[] {
    if (location === undefined) {
      throw new Error('Union or intersection resolver requires a location')
    }
    return [location.getSourceFile()]
  }

  public resolve(
    sourceFile: ts.SourceFile,
    id: SymbolId,
    symbol: ts.Symbol,
    location?: ts.Node,
  ): SymbolData {
    const composites = tss.getCompositeSymbols(
      this.typeChecker,
      symbol,
      location
    )
    if (composites !== undefined) {
      const datas: SymbolData[] = []
      for (const symbol of composites) {
        datas.push(this.resolverContext.getOrCreateSymbolData(symbol))
      }
      return new UnionOrIntersectionSymbolData(
        this.symbolDataContext,
        id,
        sourceFile,
        datas
      )
    }
    return new StandardSymbolData(this.symbolDataContext, id)
    // We have something like x: { prop: number} | { prop: string };
    // throw new Error(`Union or intersection resolver requires a location`);
  }

  public getIdentifierInformation(
    sourceFile: ts.SourceFile,
    symbol: ts.Symbol,
    declaration: ts.Node
  ): [ts.Node, string] | [undefined, undefined] {
    return [declaration, declaration.getText()]
  }
}

export class TransientResolver extends SymbolDataResolver {
  constructor(
    typeChecker: ts.TypeChecker,
    protected symbols: Symbols,
    resolverContext: ResolverContext,
    symbolDataContext: SymbolDataContext
  ) {
    super(typeChecker, symbols, resolverContext, symbolDataContext)
  }

  public get requiresSourceFile(): boolean {
    return false
  }

  public getDeclarationNodes(
    symbol: ts.Symbol,
    location?: ts.Node
  ): ts.Node[] | undefined {
    if (location === undefined) {
      throw new Error('TransientResolver requires a location')
    }
    return [location]
  }

  public getSourceFiles(
    symbol: ts.Symbol,
    location?: ts.Node
  ): ts.SourceFile[] {
    if (location === undefined) {
      throw new Error('TransientResolver requires a location')
    }
    return [location.getSourceFile()]
  }

  public resolve(
    sourceFile: ts.SourceFile,
    id: SymbolId,
    symbol: ts.Symbol,
    location?: ts.Node,
  ): SymbolData {
    if (location === undefined) {
      throw new Error('TransientResolver resolver requires a location')
    }
    return new TransientSymbolData(this.symbolDataContext, id)
  }
}

type TypeLiteralCallback = (
  index: number,
  typeAlias: ts.Symbol,
  literalType: ts.Symbol
) => number

export class TypeAliasResolver extends StandardResolver {
  constructor(
    typeChecker: ts.TypeChecker,
    protected symbols: Symbols,
    resolverContext: ResolverContext,
    symbolDataContext: SymbolDataContext
  ) {
    super(typeChecker, symbols, resolverContext, symbolDataContext)
  }

  public forwardSymbolInformation(symbol: ts.Symbol): void {
    this.visitSymbol(
      symbol,
      (index: number, typeAlias: ts.Symbol, literalType: ts.Symbol) => {
        // T1 & (T2 | T3) will be expanded into T1 & T2 | T1 & T3. So check if we have already seens
        // a literal to ensure we are always using the first one
        if (this.symbols.hasSymbolAlias(literalType)) {
          return index
        }
        // We put the number into the front since it is not a valid
        // identifier. So it can't be in code.
        const name = `${index++}_${typeAlias.getName()}`
        this.symbols.storeSymbolAlias(literalType, { alias: typeAlias, name })
        return index
      }
    )
  }

  public clearForwardSymbolInformation(symbol: ts.Symbol): void {
    this.visitSymbol(
      symbol,
      (index: number, typeAlias: ts.Symbol, literalType: ts.Symbol) => {
        this.symbols.deleteSymbolAlias(literalType)
        return index
      }
    )
  }

  private visitSymbol(symbol: ts.Symbol, cb: TypeLiteralCallback): void {
    const type = this.typeChecker.getDeclaredTypeOfSymbol(symbol)
    this.visitType(symbol, type, 0, cb)
  }

  private visitType(
    typeAlias: ts.Symbol,
    type: ts.Type,
    index: number,
    cb: TypeLiteralCallback
  ): number {
    if (tss.isTypeLiteral(type.symbol)) {
      return cb(index, typeAlias, type.symbol)
    }
    if (type.isUnionOrIntersection()) {
      if (type.types.length > 0) {
        for (const item of type.types) {
          index = this.visitType(typeAlias, item, index, cb)
        }
      }
    }
    return index
  }
}

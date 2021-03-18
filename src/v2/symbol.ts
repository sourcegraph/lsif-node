import {
  DefinitionRange,
  Document,
  ItemEdgeProperties,
  lsp,
  Moniker,
  Range,
  ReferenceResult,
  ResultSet,
  VertexLabels,
} from 'lsif-protocol'
import ts from 'typescript-lsif'
import { Emitter } from '../emitter'
import { Builder } from '../graph'
import * as tss from '../typescripts'

type ReferenceRangesProperties =
  | ItemEdgeProperties.declarations
  | ItemEdgeProperties.definitions
  | ItemEdgeProperties.references

export class SymbolData {
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

  public getDeclarations(symbol: ts.Symbol, node: ts.Node): ts.Node[] {
    return symbol.getDeclarations() || []
  }

  public getSourceFiles(symbol: ts.Symbol, node: ts.Node): ts.SourceFile[] {
    return Array.from(
      tss.getUniqueSourceFiles(symbol.getDeclarations()).values()
    )
  }

  public getText(
    symbol: ts.Symbol,
    node: ts.Node
  ): { text: string; node: ts.Node } | undefined {
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

  public hasDefinitionInfo(info: tss.DefinitionInfo): boolean {
    return this.definitionInfo.some((definitionInfo) =>
      tss.DefinitionInfo.equals(info, definitionInfo)
    )
  }

  public addDefinition(
    sourceFile: ts.SourceFile,
    definition: DefinitionRange,
    recordAsReference = true
  ): void {
    this.emitter.emit(this.builder.edge.next(definition, this.resultSet))
    this.definitionRanges.push(definition)
    if (recordAsReference) {
      this.addReference(sourceFile, definition, ItemEdgeProperties.definitions)
    }
  }

  public recordDefinitionInfo(info: tss.DefinitionInfo): void {
    this.definitionInfo.push(info)
  }

  public addReference(
    sourceFile: ts.SourceFile,
    reference: Range | ReferenceResult,
    property: ReferenceRangesProperties
  ): void {
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

  public addHover(hover: lsp.Hover): void {
    const hoverResult = this.builder.vertex.hoverResult(hover)
    this.emitter.emit(hoverResult)
    this.emitter.emit(this.builder.edge.hover(this.resultSet, hoverResult))
  }

  public addMoniker(moniker: Moniker): void {
    this.emitter.emit(this.builder.edge.moniker(this.resultSet, moniker))
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
}

export class TypeAliasSymbolData extends SymbolData {
  // TODO
}

export class AliasSymbolData extends SymbolData {
  // TODO
  // public addDefinition(
  //   sourceFile: ts.SourceFile,
  //   definition: DefinitionRange,
  //   recordAsReference = true
  // ): void {
  //       if (this.rename) {
  //         super.addDefinition(sourceFile, definition, false)
  //       } else {
  //         this.emitter.emit(this.builder.edge.next(definition, this.resultSet))
  //         this.aliased
  //           .getOrCreatePartition(sourceFile)
  //           .addReference(definition, ItemEdgeProperties.references)
  //       }
  // }
  // TODO
  // public addReference(
  //   sourceFile: ts.SourceFile,
  //   reference: Range | ReferenceResult,
  //   property: ReferenceRangesProperties
  // ): void {
  //     if (reference.label === 'range') {
  //         this.emitter.emit(this.builder.edge.next(reference, this.resultSet))
  //       }
  //       this.aliased
  //         .getOrCreatePartition(sourceFile)
  //         .addReference(reference as any, property as any)
  //     }
}

export class MethodSymbolData extends SymbolData {
  // TODO
  // public addDefinition(
  //   sourceFile: ts.SourceFile,
  //   definition: DefinitionRange,
  //   recordAsReference = true
  // ): void {
  //     // TODO - where does super call go?
  //     if (this.bases !== undefined) {
  //       for (let base of this.bases) {
  //         base
  //           .getOrCreatePartition(sourceFile)
  //           .addReference(definition, ItemEdgeProperties.definitions)
  //       }
  //     }
  // }
  // TODO
  // public addReference(
  //   sourceFile: ts.SourceFile,
  //   reference: Range | ReferenceResult,
  //   property: ReferenceRangesProperties
  // ): void {
  //     // TODO - where does super call go?
  //       if (this.bases !== undefined) {
  //         if (reference.label === 'range') {
  //           this.emitter.emit(this.builder.edge.next(reference, this.resultSet))
  //         }
  //         for (let base of this.bases) {
  //           base
  //             .getOrCreatePartition(sourceFile)
  //             .addReference(reference as any, property as any)
  //         }
  // }
}

export class TransientSymbolData extends SymbolData {
  public getDeclarations(symbol: ts.Symbol, node: ts.Node): ts.Node[] {
    return [node]
  }

  public getSourceFiles(symbol: ts.Symbol, node: ts.Node): ts.SourceFile[] {
    return [node.getSourceFile()]
  }

  public addDefinition(
    sourceFile: ts.SourceFile,
    definition: DefinitionRange,
    recordAsReference = true
  ): void {
    return
  }

  public recordDefinitionInfo(info: tss.DefinitionInfo): void {
    return
  }
}

export class UnionOrIntersectionSymbolData extends SymbolData {
  public getDeclarations(symbol: ts.Symbol, node: ts.Node): ts.Node[] {
    return [node]
  }

  public getSourceFiles(symbol: ts.Symbol, node: ts.Node): ts.SourceFile[] {
    return [node.getSourceFile()]
  }

  public getText(
    symbol: ts.Symbol,
    node: ts.Node
  ): { text: string; node: ts.Node } | undefined {
    return { text: node.getText(), node }
  }

  public addDefinition(
    sourceFile: ts.SourceFile,
    definition: DefinitionRange,
    recordAsReference = true
  ): void {
    return
  }

  public recordDefinitionInfo(info: tss.DefinitionInfo): void {
    return
  }
}

type ResolverType =
  | 'alias'
  | 'method'
  | 'standard'
  | 'transient'
  | 'typeAlias'
  | 'unionOrIntersection'

const getResolverType = (
  typeChecker: ts.TypeChecker,
  symbol: ts.Symbol,
  node: ts.Node
): ResolverType => {
  if (tss.isTransient(symbol)) {
    if (tss.isComposite(typeChecker, symbol, node)) {
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

// TODO - extract
export const makeSymbolData = (
  typeChecker: ts.TypeChecker,
  symbol: ts.Symbol,
  node: ts.Node,
  builder: Builder,
  emitter: Emitter,
  document: Document
): SymbolData => {
  const resolverType = getResolverType(typeChecker, symbol, node)

  switch (resolverType) {
    case 'alias':
      // TODO
      //  let aliased = this.typeChecker.getAliasedSymbol(symbol)
      //  if (aliased !== undefined) {
      //    let aliasedSymbolData = this.resolverContext.getOrCreateSymbolData(
      //      aliased
      //    )
      //    if (aliasedSymbolData !== undefined) {
      //      return new AliasedSymbolData(
      //        this.symbolDataContext,
      //        id,
      //        aliasedSymbolData,
      //        scope,
      //        symbol.getName() !== aliased.getName()
      //      )
      //    }
      //  }
      //  return new StandardSymbolData(this.symbolDataContext, id)

      return new AliasSymbolData(builder, emitter, document)

    case 'method':
      // TODO
      // console.log(`MethodResolver#resolve for symbol ${id} | ${symbol.getName()}`);
      // let container = tss.getSymbolParent(symbol)
      // if (container === undefined) {
      //   return new MethodSymbolData(
      //     this.symbolDataContext,
      //     id,
      //     sourceFile,
      //     undefined,
      //     scope
      //   )
      // }
      // let baseMembers = this.symbols.findBaseMembers(container, symbol.getName())
      // if (baseMembers === undefined || baseMembers.length === 0) {
      //   return new MethodSymbolData(
      //     this.symbolDataContext,
      //     id,
      //     sourceFile,
      //     undefined,
      //     scope
      //   )
      // }
      // let baseSymbolData = baseMembers.map((member) =>
      //   this.resolverContext.getOrCreateSymbolData(member)
      // )
      // return new MethodSymbolData(
      //   this.symbolDataContext,
      //   id,
      //   sourceFile,
      //   baseSymbolData,
      //   scope
      // )

      return new MethodSymbolData(builder, emitter, document)

    case 'transient':
      return new TransientSymbolData(builder, emitter, document)

    case 'typeAlias':
      return new TypeAliasSymbolData(builder, emitter, document)

    case 'unionOrIntersection':
      // TODO
      // const composites = tss.getCompositeSymbols(
      //   this.typeChecker,
      //   symbol,
      //   location
      // )
      // if (composites !== undefined) {
      //   const datas: SymbolData[] = []
      //   for (let symbol of composites) {
      //     datas.push(this.resolverContext.getOrCreateSymbolData(symbol))
      //   }
      //   return new UnionOrIntersectionSymbolData(
      //     this.symbolDataContext,
      //     id,
      //     sourceFile,
      //     datas
      //   )
      // } else {
      //   return new StandardSymbolData(this.symbolDataContext, id, undefined)
      // }
      // // We have something like x: { prop: number} | { prop: string };
      // // throw new Error(`Union or intersection resolver requires a location`);

      return new UnionOrIntersectionSymbolData(builder, emitter, document)

    default:
      return new SymbolData(builder, emitter, document)
  }
}

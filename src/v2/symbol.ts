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
import { ResolverType } from './resolution'

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

  public hasDefinitionInfo(info: tss.DefinitionInfo): boolean {
    return this.definitionInfo.some((definitionInfo) =>
      tss.DefinitionInfo.equals(info, definitionInfo)
    )
  }

  public addDefinition(
    sourceFile: ts.SourceFile,
    definition: DefinitionRange,
    resolverType: ResolverType,
    recordAsReference = true
  ): void {
    switch (resolverType) {
      // TODO
      // case 'alias':
      //   if (this.rename) {
      //     super.addDefinition(sourceFile, definition, false)
      //   } else {
      //     this.emitter.emit(this.builder.edge.next(definition, this.resultSet))
      //     this.aliased
      //       .getOrCreatePartition(sourceFile)
      //       .addReference(definition, ItemEdgeProperties.references)
      //   }

      // TODO
      // case 'method':
      // TODO - after the following
      // if (this.bases !== undefined) {
      //   for (let base of this.bases) {
      //     base
      //       .getOrCreatePartition(sourceFile)
      //       .addReference(definition, ItemEdgeProperties.definitions)
      //   }
      // }

      case 'transient':
      case 'unionOrIntersection':
        return

      default:
        this.emitter.emit(this.builder.edge.next(definition, this.resultSet))
        this.definitionRanges.push(definition)
        if (recordAsReference) {
          this.addReference(
            sourceFile,
            definition,
            ItemEdgeProperties.definitions,
            resolverType
          )
        }
    }
  }

  public recordDefinitionInfo(
    info: tss.DefinitionInfo,
    resolverType: ResolverType
  ): void {
    switch (resolverType) {
      case 'transient':
      case 'unionOrIntersection':
        return

      default:
        this.definitionInfo.push(info)
    }
  }

  public addReference(
    sourceFile: ts.SourceFile,
    reference: Range | ReferenceResult,
    property: ReferenceRangesProperties,
    resolverType: ResolverType
  ): void {
    switch (resolverType) {
      // TODO
      // case 'alias':
      // if (reference.label === 'range') {
      //     this.emitter.emit(this.builder.edge.next(reference, this.resultSet))
      //   }
      //   this.aliased
      //     .getOrCreatePartition(sourceFile)
      //     .addReference(reference as any, property as any)
      // }

      // TODO
      // case 'method':
      //   if (this.bases !== undefined) {
      //     if (reference.label === 'range') {
      //       this.emitter.emit(this.builder.edge.next(reference, this.resultSet))
      //     }
      //     for (let base of this.bases) {
      //       base
      //         .getOrCreatePartition(sourceFile)
      //         .addReference(reference as any, property as any)
      //     }

      //     break
      //   }
      // fallthrough

      // TODO
      // case 'unionOrIntersection':
      //   if (reference.label === 'range') {
      //     this.emitter.emit(this.builder.edge.next(reference, this.resultSet))
      //   }
      //   for (let element of this.elements) {
      //     element
      //       .getOrCreatePartition(sourceFile)
      //       .addReference(reference as any, property as any)
      //   }
      //   break

      default:
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

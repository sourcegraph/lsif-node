/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
// In typescript all paths are /. So use the posix layer only
import * as ts from 'typescript-lsif'
import {
  DefinitionRange,
  DefinitionResult,
  Document,
  Edge,
  EventKind,
  ItemEdgeProperties,
  lsp,
  Moniker,
  MonikerKind,
  Project,
  Range,
  ReferenceResult,
  ResultSet,
  Vertex,
} from 'lsif-protocol'
import * as tss from './typescripts'
import { EmitContext } from './emitter'
import { VertexBuilder, EdgeBuilder } from './graph'

export type SymbolId = string

export interface SymbolDataContext extends EmitContext {
  getDocumentData(fileName: string): DocumentData | undefined
  getOrCreateSymbolData(
    symbolId: SymbolId,
    create: () => SymbolData
  ): SymbolData
  manageLifeCycle(node: ts.Node, symbolData: SymbolData): void
}

abstract class LSIFData {
  protected constructor(protected context: SymbolDataContext) {}

  public abstract begin(): void

  public abstract end(): void

  protected emit(value: Vertex | Edge): void {
    this.context.emit(value)
  }

  protected get vertex(): VertexBuilder {
    return this.context.vertex
  }

  protected get edge(): EdgeBuilder {
    return this.context.edge
  }
}

export class ProjectData extends LSIFData {
  private documents: Document[]

  constructor(context: SymbolDataContext, private project: Project) {
    super(context)
    this.documents = []
  }

  public begin(): void {
    this.emit(this.project)
    this.emit(this.vertex.event(EventKind.begin, this.project))
  }

  public addDocument(document: Document): void {
    this.documents.push(document)
    if (this.documents.length > 32) {
      this.emit(this.edge.contains(this.project, this.documents))
      this.documents = []
    }
  }

  public end(): void {
    if (this.documents.length > 0) {
      this.emit(this.edge.contains(this.project, this.documents))
    }
    this.emit(this.vertex.event(EventKind.end, this.project))
  }
}

export class DocumentData extends LSIFData {
  private ranges: Range[]

  constructor(
    context: SymbolDataContext,
    public document: Document,
    public monikerPath: string | undefined,
    public externalLibrary: boolean
  ) {
    super(context)
    this.ranges = []
  }

  public begin(): void {
    this.emit(this.document)
    this.emit(this.vertex.event(EventKind.begin, this.document))
  }

  public addRange(range: Range): void {
    this.emit(range)
    this.ranges.push(range)
  }

  public end(): void {
    if (this.ranges.length >= 0) {
      this.emit(this.edge.contains(this.document, this.ranges))
    }
    this.emit(this.vertex.event(EventKind.end, this.document))
  }
}

class SymbolDataPartition extends LSIFData {
  private static EMPTY_ARRAY = (Object.freeze([]) as unknown) as any[]
  private static EMPTY_MAP = (Object.freeze(new Map()) as unknown) as Map<
    any,
    any
  >

  private definitionRanges: DefinitionRange[]

  private referenceRanges: Map<
    | ItemEdgeProperties.declarations
    | ItemEdgeProperties.definitions
    | ItemEdgeProperties.references,
    Range[]
  >
  private referenceResults: ReferenceResult[]

  constructor(
    context: SymbolDataContext,
    private symbolData: SymbolData,
    private document: Document
  ) {
    super(context)
    this.definitionRanges = SymbolDataPartition.EMPTY_ARRAY
    this.referenceRanges = SymbolDataPartition.EMPTY_MAP
    this.referenceResults = SymbolDataPartition.EMPTY_ARRAY
  }

  public begin(): void {
    // Do nothing.
  }

  public addDefinition(
    value: DefinitionRange,
    recordAsReference: boolean = true
  ): void {
    if (this.definitionRanges === SymbolDataPartition.EMPTY_ARRAY) {
      this.definitionRanges = []
    }
    this.definitionRanges.push(value)
    if (recordAsReference) {
      this.addReference(value, ItemEdgeProperties.definitions)
    }
  }

  public findDefinition(range: lsp.Range): DefinitionRange | undefined {
    if (this.definitionRanges === SymbolDataPartition.EMPTY_ARRAY) {
      return undefined
    }
    for (const definitionRange of this.definitionRanges) {
      if (
        definitionRange.start.line === range.start.line &&
        definitionRange.start.character === range.start.character &&
        definitionRange.end.line === range.end.line &&
        definitionRange.end.character === range.end.character
      ) {
        return definitionRange
      }
    }
    return undefined
  }

  public addReference(
    value: Range,
    property:
      | ItemEdgeProperties.declarations
      | ItemEdgeProperties.definitions
      | ItemEdgeProperties.references
  ): void
  public addReference(value: ReferenceResult): void
  public addReference(
    value: Range | ReferenceResult,
    property?:
      | ItemEdgeProperties.declarations
      | ItemEdgeProperties.definitions
      | ItemEdgeProperties.references
  ): void {
    if (value.label === 'range' && property !== undefined) {
      if (this.referenceRanges === SymbolDataPartition.EMPTY_MAP) {
        this.referenceRanges = new Map()
      }
      let values = this.referenceRanges.get(property)
      if (values === undefined) {
        values = []
        this.referenceRanges.set(property, values)
      }
      values.push(value)
    } else if (value.label === 'referenceResult') {
      if (this.referenceResults === SymbolDataPartition.EMPTY_ARRAY) {
        this.referenceResults = []
      }
      this.referenceResults.push(value)
    }
  }

  public end(): void {
    if (this.definitionRanges !== SymbolDataPartition.EMPTY_ARRAY) {
      const definitionResult = this.symbolData.getOrCreateDefinitionResult()
      this.emit(
        this.edge.item(definitionResult, this.definitionRanges, this.document)
      )
    }
    if (this.referenceRanges !== SymbolDataPartition.EMPTY_MAP) {
      const referenceResult = this.symbolData.getOrCreateReferenceResult()
      for (const property of this.referenceRanges.keys()) {
        const values = this.referenceRanges.get(property)!
        this.emit(
          this.edge.item(referenceResult, values, this.document, property)
        )
      }
    }
    if (this.referenceResults !== SymbolDataPartition.EMPTY_ARRAY) {
      const referenceResult = this.symbolData.getOrCreateReferenceResult()
      this.emit(
        this.edge.item(referenceResult, this.referenceResults, this.document)
      )
    }
  }
}

export abstract class SymbolData extends LSIFData {
  private declarationInfo: tss.DefinitionInfo | tss.DefinitionInfo[] | undefined

  protected resultSet: ResultSet

  constructor(context: SymbolDataContext, private id: SymbolId) {
    super(context)
    this.resultSet = this.vertex.resultSet()
  }

  public getId(): string {
    return this.id
  }

  public getResultSet(): ResultSet {
    return this.resultSet
  }

  public begin(): void {
    this.emit(this.resultSet)
  }

  public recordDefinitionInfo(info: tss.DefinitionInfo): void {
    if (this.declarationInfo === undefined) {
      this.declarationInfo = info
    } else if (Array.isArray(this.declarationInfo)) {
      this.declarationInfo.push(info)
    } else {
      this.declarationInfo = [this.declarationInfo]
      this.declarationInfo.push(info)
    }
  }

  public hasDefinitionInfo(info: tss.DefinitionInfo): boolean {
    if (this.declarationInfo === undefined) {
      return false
    }
    if (Array.isArray(this.declarationInfo)) {
      for (const item of this.declarationInfo) {
        if (tss.DefinitionInfo.equals(item, info)) {
          return true
        }
      }
      return false
    }
    return tss.DefinitionInfo.equals(this.declarationInfo, info)
  }

  public addHover(hover: lsp.Hover): void {
    const hr = this.vertex.hoverResult(hover)
    this.emit(hr)
    this.emit(this.edge.hover(this.resultSet, hr))
  }

  public addMoniker(identifier: string, kind: MonikerKind): Moniker {
    const moniker = this.vertex.moniker('tsc', identifier, kind)
    this.emit(moniker)
    this.emit(this.edge.moniker(this.resultSet, moniker))
    return moniker
  }

  public abstract getOrCreateDefinitionResult(): DefinitionResult

  public abstract addDefinition(
    sourceFile: ts.SourceFile,
    definition: DefinitionRange
  ): void
  public abstract findDefinition(
    sourceFile: ts.SourceFile,
    range: lsp.Range
  ): DefinitionRange | undefined

  public abstract getOrCreateReferenceResult(): ReferenceResult

  public abstract addReference(
    sourceFile: ts.SourceFile,
    reference: Range,
    property:
      | ItemEdgeProperties.declarations
      | ItemEdgeProperties.definitions
      | ItemEdgeProperties.references
  ): void
  public abstract addReference(
    sourceFile: ts.SourceFile,
    reference: ReferenceResult
  ): void

  public abstract getOrCreatePartition(
    sourceFile: ts.SourceFile
  ): SymbolDataPartition
}

export class StandardSymbolData extends SymbolData {
  private definitionResult: DefinitionResult | undefined
  private referenceResult: ReferenceResult | undefined
  private partitions: Map<string /* filename */, SymbolDataPartition  >=new Map()

  constructor(
    context: SymbolDataContext,
    id: SymbolId,
  ) {
    super(context, id)
  }

  public addDefinition(
    sourceFile: ts.SourceFile,
    definition: DefinitionRange,
    recordAsReference = true
  ): void {
    this.emit(this.edge.next(definition, this.resultSet))
    this.getOrCreatePartition(sourceFile).addDefinition(
      definition,
      recordAsReference
    )
  }

  public findDefinition(
    sourceFile: ts.SourceFile,
    range: lsp.Range
  ): DefinitionRange | undefined {
    const partition = this.partitions.get(sourceFile.fileName)
    if (partition === undefined) {
      return undefined
    }
    return partition.findDefinition(range)
  }

  public addReference(
    sourceFile: ts.SourceFile,
    reference: Range | ReferenceResult,
    property?:
      | ItemEdgeProperties.declarations
      | ItemEdgeProperties.definitions
      | ItemEdgeProperties.references
  ): void {
    if (reference.label === 'range') {
      this.emit(this.edge.next(reference, this.resultSet))
    }
    this.getOrCreatePartition(sourceFile).addReference(
      reference as any,
      property as any
    )
  }

  public getOrCreateDefinitionResult(): DefinitionResult {
    if (this.definitionResult === undefined) {
      this.definitionResult = this.vertex.definitionResult()
      this.emit(this.definitionResult)
      this.emit(this.edge.definition(this.resultSet, this.definitionResult))
    }
    return this.definitionResult
  }

  public getOrCreateReferenceResult(): ReferenceResult {
    if (this.referenceResult === undefined) {
      this.referenceResult = this.vertex.referencesResult()
      this.emit(this.referenceResult)
      this.emit(this.edge.references(this.resultSet, this.referenceResult))
    }
    return this.referenceResult
  }

  public getOrCreatePartition(sourceFile: ts.SourceFile): SymbolDataPartition {
    const fileName = sourceFile.fileName
    let result = this.partitions.get(fileName)
    if (result === undefined) {
      const documentData = this.context.getDocumentData(fileName)
      if (documentData === undefined) {
        throw new Error(`No document data for ${fileName}`)
      }
      result = new SymbolDataPartition(
        this.context,
        this,
        documentData.document
      )
      this.context.manageLifeCycle(sourceFile, this)
      result.begin()
      this.partitions.set(fileName, result)
    }
    return result
  }

  public end(): void {
    for (const entry of this.partitions.values()) {
      entry.end()
    }
  }
}

export class AliasedSymbolData extends StandardSymbolData {
  constructor(
    context: SymbolDataContext,
    id: string,
    private aliased: SymbolData,
    private rename = false
  ) {
    super(context, id)
  }

  public begin(): void {
    super.begin()
    this.emit(this.edge.next(this.resultSet, this.aliased.getResultSet()))
  }

  public addDefinition(
    sourceFile: ts.SourceFile,
    definition: DefinitionRange
  ): void {
    if (this.rename) {
      super.addDefinition(sourceFile, definition, false)
    } else {
      this.emit(this.edge.next(definition, this.resultSet))
      this.aliased
        .getOrCreatePartition(sourceFile)
        .addReference(definition, ItemEdgeProperties.references)
    }
  }

  public findDefinition(
    sourceFile: ts.SourceFile,
    range: lsp.Range
  ): DefinitionRange | undefined {
    if (this.rename) {
      return super.findDefinition(sourceFile, range)
    }

    return this.aliased.findDefinition(sourceFile, range)
  }

  public addReference(
    sourceFile: ts.SourceFile,
    reference: Range | ReferenceResult,
    property?:
      | ItemEdgeProperties.declarations
      | ItemEdgeProperties.definitions
      | ItemEdgeProperties.references
  ): void {
    if (reference.label === 'range') {
      this.emit(this.edge.next(reference, this.resultSet))
    }
    this.aliased
      .getOrCreatePartition(sourceFile)
      .addReference(reference as any, property as any)
  }
}

export class MethodSymbolData extends StandardSymbolData {
  private sourceFile: ts.SourceFile | undefined
  private bases: SymbolData[] | undefined

  constructor(
    context: SymbolDataContext,
    id: string,
    sourceFile: ts.SourceFile,
    bases: SymbolData[] | undefined,
  ) {
    super(context, id)
    this.sourceFile = sourceFile
    if (bases !== undefined && bases.length === 0) {
      this.bases = undefined
    } else {
      this.bases = bases
    }
  }

  public begin(): void {
    super.begin()
    if (this.bases !== undefined) {
      for (const base of this.bases) {
        // We take the first source file to cluster this. We might want to find a source
        // file that has already changed to make the diff minimal.
        super.addReference(this.sourceFile!, base.getOrCreateReferenceResult())
      }
    }
    this.sourceFile = undefined
  }

  public addDefinition(
    sourceFile: ts.SourceFile,
    definition: DefinitionRange
  ): void {
    super.addDefinition(sourceFile, definition, this.bases === undefined)
    if (this.bases !== undefined) {
      for (const base of this.bases) {
        base
          .getOrCreatePartition(sourceFile)
          .addReference(definition, ItemEdgeProperties.definitions)
      }
    }
  }

  public addReference(
    sourceFile: ts.SourceFile,
    reference: Range | ReferenceResult,
    property?:
      | ItemEdgeProperties.declarations
      | ItemEdgeProperties.definitions
      | ItemEdgeProperties.references
  ): void {
    if (this.bases !== undefined) {
      if (reference.label === 'range') {
        this.emit(this.edge.next(reference, this.resultSet))
      }
      for (const base of this.bases) {
        base
          .getOrCreatePartition(sourceFile)
          .addReference(reference as any, property as any)
      }
    } else {
      super.addReference(sourceFile, reference as any, property as any)
    }
  }
}

export class UnionOrIntersectionSymbolData extends StandardSymbolData {
  private sourceFile: ts.SourceFile | undefined
  private elements: SymbolData[]

  constructor(
    context: SymbolDataContext,
    id: string,
    sourceFile: ts.SourceFile,
    elements: SymbolData[]
  ) {
    super(context, id)
    this.elements = elements
    this.sourceFile = sourceFile
  }

  public begin(): void {
    super.begin()
    for (const element of this.elements) {
      // We take the first source file to cluster this. We might want to find a source
      // file that has already changed to make the diff minimal.
      super.addReference(this.sourceFile!, element.getOrCreateReferenceResult())
    }
    this.sourceFile = undefined
  }

  public recordDefinitionInfo(info: tss.DefinitionInfo): void {}

  public addDefinition(
    sourceFile: ts.SourceFile,
    definition: DefinitionRange
  ): void {
    // We don't do anoything for definitions since they a transient anyways.
  }

  public addReference(
    sourceFile: ts.SourceFile,
    reference: Range | ReferenceResult,
    property?:
      | ItemEdgeProperties.declarations
      | ItemEdgeProperties.definitions
      | ItemEdgeProperties.references
  ): void {
    if (reference.label === 'range') {
      this.emit(this.edge.next(reference, this.resultSet))
    }
    for (const element of this.elements) {
      element
        .getOrCreatePartition(sourceFile)
        .addReference(reference as any, property as any)
    }
  }
}

export class TransientSymbolData extends StandardSymbolData {
  constructor(context: SymbolDataContext, id: string) {
    super(context, id)
  }

  public begin(): void {
    super.begin()
  }

  public recordDefinitionInfo(info: tss.DefinitionInfo): void {}

  public addDefinition(
    sourceFile: ts.SourceFile,
    definition: DefinitionRange
  ): void {
    // We don't do anoything for definitions since they a transient anyways.
  }

  public addReference(
    sourceFile: ts.SourceFile,
    reference: Range | ReferenceResult,
    property?:
      | ItemEdgeProperties.declarations
      | ItemEdgeProperties.definitions
      | ItemEdgeProperties.references
  ): void {
    super.addReference(sourceFile, reference, property)
  }
}

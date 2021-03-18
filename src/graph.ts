/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict'

import { URI } from 'vscode-uri'

import {
    lsp,
    Id,
    Vertex,
    E,
    Project,
    Document,
    HoverResult,
    ReferenceResult,
    contains,
    textDocument_definition,
    textDocument_references,
    textDocument_diagnostic,
    textDocument_hover,
    item,
    DiagnosticResult,
    Range,
    RangeTag,
    DeclarationRange,
    ReferenceRange,
    DocumentSymbolResult,
    textDocument_documentSymbol,
    ReferenceTag,
    DeclarationTag,
    UnknownTag,
    DefinitionResult,
    ImplementationResult,
    textDocument_implementation,
    textDocument_typeDefinition,
    TypeDefinitionResult,
    FoldingRangeResult,
    textDocument_foldingRange,
    RangeBasedDocumentSymbol,
    DefinitionTag,
    DefinitionRange,
    ResultSet,
    MetaData,
    Location,
    ElementTypes,
    VertexLabels,
    EdgeLabels,
    Moniker,
    PackageInformation,
    moniker,
    packageInformation,
    MonikerKind,
    ItemEdgeProperties,
    EventKind,
    EventScope,
    DocumentEvent,
    ProjectEvent,
    DeclarationResult,
    textDocument_declaration,
    next,
} from 'lsif-protocol'
import { makeAbsolute } from './typescripts'

export class VertexBuilder {
    constructor(private nextId: () => Id) {}

    public metaData(
        version: string,
        projectRoot: string,
        toolInfo?: {
            name: string
            version?: string
            args?: string[]
        }
    ): MetaData {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.metaData,
            version,
            projectRoot,
            positionEncoding: 'utf-16',
            toolInfo,
        }
    }

    public event(kind: EventKind, scope: Project): ProjectEvent
    public event(kind: EventKind, scope: Document): DocumentEvent
    public event(
        kind: EventKind,
        scope: Project | Document
    ): ProjectEvent | DocumentEvent {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.event,
            kind,
            scope:
                scope.label === 'project'
                    ? EventScope.project
                    : EventScope.document,
            data: scope.id,
        }
    }

    public project(): Project {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.project,
            kind: 'typescript',
        }
    }

    public document(path: string): Document {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.document,
            uri: URI.file(makeAbsolute(path)).toString(true),
            languageId: 'typescript',
        }
    }

    public moniker(
        scheme: string,
        identifier: string,
        kind?: MonikerKind
    ): Moniker {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.moniker,
            kind,
            scheme,
            identifier,
        }
    }

    public packageInformation(
        name: string,
        manager: string
    ): PackageInformation {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.packageInformation,
            name,
            manager,
        }
    }

    public resultSet(): ResultSet {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.resultSet,
        }
    }

    public range(range: lsp.Range, tag: UnknownTag): Range
    public range(range: lsp.Range, tag: DeclarationTag): DeclarationRange
    public range(range: lsp.Range, tag: DefinitionTag): DefinitionRange
    public range(range: lsp.Range, tag: ReferenceTag): ReferenceRange
    public range(range: lsp.Range, tag?: RangeTag): Range {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.range,
            start: range.start,
            end: range.end,
            ...(tag ? { tag } : {}),
        }
    }

    public location(range: lsp.Range): Location {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.location,
            range,
        }
    }

    public documentSymbolResult(
        values: lsp.DocumentSymbol[] | RangeBasedDocumentSymbol[]
    ): DocumentSymbolResult {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.documentSymbolResult,
            result: values,
        }
    }

    public diagnosticResult(values: lsp.Diagnostic[]): DiagnosticResult {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.diagnosticResult,
            result: values,
        }
    }

    public foldingRangeResult(values: lsp.FoldingRange[]): FoldingRangeResult {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.foldingRangeResult,
            result: values,
        }
    }

    public hoverResult(value: lsp.Hover): HoverResult
    public hoverResult(
        contents: lsp.MarkupContent | lsp.MarkedString | lsp.MarkedString[]
    ): HoverResult
    public hoverResult(
        value:
            | lsp.Hover
            | lsp.MarkupContent
            | lsp.MarkedString
            | lsp.MarkedString[]
    ): HoverResult {
        if (lsp.Hover.is(value)) {
            return {
                id: this.nextId(),
                type: ElementTypes.vertex,
                label: VertexLabels.hoverResult,
                result: {
                    contents: value.contents,
                    range: value.range,
                },
            }
        }
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.hoverResult,
            result: {
                contents: value as
                    | lsp.MarkupContent
                    | lsp.MarkedString
                    | lsp.MarkedString[],
            },
        }
    }

    public declarationResult(): DeclarationResult {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.declarationResult,
        }
    }

    public definitionResult(): DefinitionResult {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.definitionResult,
        }
    }

    public typeDefinitionResult(): TypeDefinitionResult {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.typeDefinitionResult,
        }
    }

    public referencesResult(): ReferenceResult {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.referenceResult,
        }
    }

    public implementationResult(): ImplementationResult {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.implementationResult,
        }
    }
}

export class EdgeBuilder {
    constructor(private nextId: () => Id) {}

    public raw(
        kind: EdgeLabels,
        from: Id,
        to: Id
    ): E<Vertex, Vertex, EdgeLabels> {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: kind,
            outV: from,
            inV: to,
        }
    }

    public contains(from: Project, to: Document[]): contains
    public contains(from: Document, to: Range[]): contains
    public contains(from: Vertex, to: Vertex[]): contains {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.contains,
            outV: from.id,
            inVs: to.map((v) => v.id),
        }
    }

    public next(from: Range | ResultSet, to: ResultSet): next {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.next,
            outV: from.id,
            inV: to.id,
        }
    }

    public moniker(from: Range | ResultSet, to: Moniker): moniker {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.moniker,
            outV: from.id,
            inV: to.id,
        }
    }

    public packageInformation(
        from: Moniker,
        to: PackageInformation
    ): packageInformation {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.packageInformation,
            outV: from.id,
            inV: to.id,
        }
    }

    public documentSymbols(
        from: Document,
        to: DocumentSymbolResult
    ): textDocument_documentSymbol {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_documentSymbol,
            outV: from.id,
            inV: to.id,
        }
    }

    public foldingRange(
        from: Document,
        to: FoldingRangeResult
    ): textDocument_foldingRange {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_foldingRange,
            outV: from.id,
            inV: to.id,
        }
    }

    public diagnostic(
        from: Project | Document,
        to: DiagnosticResult
    ): textDocument_diagnostic {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_diagnostic,
            outV: from.id,
            inV: to.id,
        }
    }

    public hover(from: Range | ResultSet, to: HoverResult): textDocument_hover {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_hover,
            outV: from.id,
            inV: to.id,
        }
    }

    public declaration(
        from: Range | ResultSet,
        to: DeclarationResult
    ): textDocument_declaration {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_declaration,
            outV: from.id,
            inV: to.id,
        }
    }

    public definition(
        from: Range | ResultSet,
        to: DefinitionResult
    ): textDocument_definition {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_definition,
            outV: from.id,
            inV: to.id,
        }
    }

    public typeDefinition(
        from: Range | ResultSet,
        to: TypeDefinitionResult
    ): textDocument_typeDefinition {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_typeDefinition,
            outV: from.id,
            inV: to.id,
        }
    }

    public references(
        from: Range | ResultSet,
        to: ReferenceResult
    ): textDocument_references {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_references,
            outV: from.id,
            inV: to.id,
        }
    }

    public implementation(
        from: Range | ResultSet,
        to: ImplementationResult
    ): textDocument_implementation {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_implementation,
            outV: from.id,
            inV: to.id,
        }
    }

    public item(
        from:
            | DeclarationResult
            | DefinitionResult
            | TypeDefinitionResult
            | ImplementationResult,
        to: Range[],
        document: Document
    ): item
    public item(
        from: ReferenceResult,
        to: Range[],
        document: Document,
        property:
            | ItemEdgeProperties.declarations
            | ItemEdgeProperties.definitions
            | ItemEdgeProperties.references
    ): item
    public item(
        from: ReferenceResult,
        to: ReferenceResult[],
        document: Document
    ): item
    public item(
        from: ImplementationResult,
        to: ImplementationResult[],
        document: Document
    ): item
    public item(
        from:
            | DeclarationResult
            | DefinitionResult
            | TypeDefinitionResult
            | ReferenceResult
            | ImplementationResult,
        to: Vertex[],
        document: Document,
        property?:
            | ItemEdgeProperties.declarations
            | ItemEdgeProperties.definitions
            | ItemEdgeProperties.references
    ): item {
        let result: item
        if (to.length === 0) {
            let result: item = {
                id: this.nextId(),
                type: ElementTypes.edge,
                label: EdgeLabels.item,
                outV: from.id,
                inVs: [],
                document: document.id,
            }
            if (from.label === 'referenceResult') {
                result.property =
                    property !== undefined
                        ? property
                        : ItemEdgeProperties.references
            }
            return result
        }
        let toKind = to[0].label
        result = {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.item,
            outV: from.id,
            inVs: to.map((v) => v.id),
            document: document.id,
        }
        switch (from.label) {
            case 'declarationResult':
                break
            case 'definitionResult':
                break
            case 'referenceResult':
                result.property =
                    property !== undefined
                        ? property
                        : ItemEdgeProperties.referenceResults
                break
            case 'implementationResult':
                if (toKind === 'implementationResult') {
                    result.property = ItemEdgeProperties.implementationResults
                }
                break
            default:
                throw new Error("Shouldn't happen")
        }
        return result
    }
}

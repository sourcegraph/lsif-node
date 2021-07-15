import {
    contains,
    DefinitionRange,
    DefinitionResult,
    Document,
    EdgeLabels,
    ElementTypes,
    HoverResult,
    item,
    ItemEdgeProperties,
    lsp,
    moniker,
    Moniker,
    next,
    Range,
    ReferenceResult,
    ResultSet,
    textDocument_definition,
    textDocument_hover,
    textDocument_references,
    VertexLabels,
} from 'lsif-protocol'
import ts from 'typescript-lsif'
import {
    DefinitionInfo,
    getUniqueSourceFiles,
    isNamedDeclaration,
    isValueModule,
} from './debt'
import { Emitter } from './emitter'

export class DocumentData {
    private ranges: Range[] = []

    public constructor(
        private emitter: Emitter,
        public readonly document: Document,
        public readonly externalLibrary: boolean,
        public readonly monikerPath?: string
    ) {}

    public begin(): void {
        // no-op
    }

    public addRange(range: Range): void {
        this.ranges.push(range)
    }

    public end(): void {
        if (this.ranges.length > 0) {
            this.emitter.emit<contains>({
                type: ElementTypes.edge,
                label: EdgeLabels.contains,
                outV: this.document.id,
                inVs: this.ranges.map((v) => v.id),
            })
        }
    }
}

type ReferenceRangesProperties =
    | ItemEdgeProperties.declarations
    | ItemEdgeProperties.definitions
    | ItemEdgeProperties.references

export class SymbolData {
    private definitionInfo: DefinitionInfo[] = []
    private definitionRanges: DefinitionRange[] = []
    private referenceResults: ReferenceResult[] = []
    private referenceRanges = new Map<ReferenceRangesProperties, Range[]>()

    public constructor(
        protected emitter: Emitter,
        protected document: Document,
        public readonly resultSet: ResultSet
    ) {}

    public begin(): void {
        // no-op
    }

    public getSourceFiles(symbol: ts.Symbol, node?: ts.Node): ts.SourceFile[] {
        return Array.from(
            getUniqueSourceFiles(symbol.getDeclarations()).values()
        )
    }

    public getDeclarations(symbol: ts.Symbol, node?: ts.Node): ts.Node[] {
        return symbol.getDeclarations() || []
    }

    public getText(
        symbol: ts.Symbol,
        node?: ts.Node
    ): { text: string; node: ts.Node } | undefined {
        if (!node) {
            return undefined
        }

        if (isNamedDeclaration(node)) {
            return {
                text: node.name.getText(),
                node: node.name,
            }
        }

        if (isValueModule(symbol) && ts.isSourceFile(node)) {
            return { text: '', node }
        }

        return undefined
    }

    public addDefinition(
        sourceFile: ts.SourceFile,
        definition: DefinitionRange,
        recordAsReference = true
    ): void {
        this.emitter.emit<next>({
            type: ElementTypes.edge,
            label: EdgeLabels.next,
            outV: definition.id,
            inV: this.resultSet.id,
        })

        this.definitionRanges.push(definition)

        if (recordAsReference) {
            this.addReference(
                sourceFile,
                definition,
                ItemEdgeProperties.definitions
            )
        }
    }

    public addDefinitionInfo(info: DefinitionInfo): void {
        this.definitionInfo.push(info)
    }

    public hasDefinitionInfo(info: DefinitionInfo): boolean {
        return this.definitionInfo.some((definitionInfo) =>
            DefinitionInfo.equals(info, definitionInfo)
        )
    }

    public addReference(
        sourceFile: ts.SourceFile,
        reference: Range | ReferenceResult,
        property?: ReferenceRangesProperties
    ): void {
        switch (reference.label) {
            case VertexLabels.range:
                if (property) {
                    this.emitter.emit<next>({
                        type: ElementTypes.edge,
                        label: EdgeLabels.next,
                        outV: reference.id,
                        inV: this.resultSet.id,
                    })

                    const oldList = this.referenceRanges.get(property) || []
                    const newList = oldList.concat([reference])
                    this.referenceRanges.set(property, newList)
                }
                break

            case VertexLabels.referenceResult:
                this.referenceResults.push(reference)
                break
        }
    }

    public addHover(hover: lsp.Hover): void {
        const hoverResult = this.emitter.emit<HoverResult>({
            type: ElementTypes.vertex,
            label: VertexLabels.hoverResult,
            result: hover,
        })

        this.emitter.emit<textDocument_hover>({
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_hover,
            outV: this.resultSet.id,
            inV: hoverResult.id,
        })
    }

    public addMoniker(moniker: Moniker): void {
        this.emitter.emit<moniker>({
            type: ElementTypes.edge,
            label: EdgeLabels.moniker,
            outV: this.resultSet.id,
            inV: moniker.id,
        })
    }

    public end(): void {
        if (this.definitionRanges.length > 0) {
            const definitionResult = this.getOrCreateDefinitionResult()

            this.emitter.emit<item>({
                type: ElementTypes.edge,
                label: EdgeLabels.item,
                outV: definitionResult.id,
                inVs: this.definitionRanges.map((v) => v.id),
                document: this.document.id,
            })
        }

        if (this.referenceRanges.size > 0) {
            const referenceResult = this.getOrCreateReferenceResult()

            for (const [property, values] of this.referenceRanges.entries()) {
                this.emitter.emit<item>({
                    type: ElementTypes.edge,
                    label: EdgeLabels.item,
                    outV: referenceResult.id,
                    inVs: values.map((v) => v.id),
                    document: this.document.id,
                    property,
                })
            }
        }

        if (this.referenceResults.length > 0) {
            const referenceResult = this.getOrCreateReferenceResult()

            this.emitter.emit<item>({
                type: ElementTypes.edge,
                label: EdgeLabels.item,
                outV: referenceResult.id,
                inVs: this.referenceResults.map((v) => v.id),
                document: this.document.id,
                property: ItemEdgeProperties.referenceResults,
            })
        }
    }

    public getOrCreateDefinitionResult(): DefinitionResult {
        const definitionResult = this.emitter.emit<DefinitionResult>({
            type: ElementTypes.vertex,
            label: VertexLabels.definitionResult,
        })

        this.emitter.emit<textDocument_definition>({
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_definition,
            outV: this.resultSet.id,
            inV: definitionResult.id,
        })

        return definitionResult
    }

    public getOrCreateReferenceResult(): ReferenceResult {
        const referenceResult = this.emitter.emit<ReferenceResult>({
            type: ElementTypes.vertex,
            label: VertexLabels.referenceResult,
        })

        this.emitter.emit<textDocument_references>({
            type: ElementTypes.edge,
            label: EdgeLabels.textDocument_references,
            outV: this.resultSet.id,
            inV: referenceResult.id,
        })

        return referenceResult
    }
}

export class AliasSymbolData extends SymbolData {
    constructor(
        emitter: Emitter,
        document: Document,
        resultSet: ResultSet,
        private aliased: SymbolData,
        private rename: boolean
    ) {
        super(emitter, document, resultSet)
    }

    public begin(): void {
        super.begin()

        this.emitter.emit<next>({
            type: ElementTypes.edge,
            label: EdgeLabels.next,
            outV: this.resultSet.id,
            inV: this.aliased.resultSet.id,
        })
    }

    public addDefinition(
        sourceFile: ts.SourceFile,
        definition: DefinitionRange,
        recordAsReference = true
    ): void {
        if (this.rename) {
            super.addDefinition(sourceFile, definition, false)
        } else {
            this.emitter.emit<next>({
                type: ElementTypes.edge,
                label: EdgeLabels.next,
                outV: definition.id,
                inV: this.resultSet.id,
            })
            super.addReference(
                sourceFile,
                definition,
                ItemEdgeProperties.references
            )
        }
    }

    public addReference(
        sourceFile: ts.SourceFile,
        reference: Range | ReferenceResult,
        property: ReferenceRangesProperties
    ): void {
        if (reference.label === VertexLabels.range) {
            this.emitter.emit<next>({
                type: ElementTypes.edge,
                label: EdgeLabels.next,
                outV: reference.id,
                inV: this.resultSet.id,
            })
        }
        this.aliased.addReference(sourceFile, reference, property)
    }
}

export class MethodSymbolData extends SymbolData {
    constructor(
        emitter: Emitter,
        document: Document,
        resultSet: ResultSet,
        private bases: SymbolData[],
        private sourceFile: ts.SourceFile
    ) {
        super(emitter, document, resultSet)
    }

    public begin(): void {
        super.begin()

        for (const base of this.bases) {
            // We take the first source file to cluster this. We might want to find a source
            // file that has already changed to make the diff minimal.
            super.addReference(
                this.sourceFile,
                base.getOrCreateReferenceResult()
            )
        }
    }

    public addDefinition(
        sourceFile: ts.SourceFile,
        definition: DefinitionRange,
        recordAsReference = true
    ): void {
        super.addDefinition(sourceFile, definition, this.bases.length === 0)

        for (const base of this.bases) {
            base.addReference(
                sourceFile,
                definition,
                ItemEdgeProperties.definitions
            )
        }
    }

    public addReference(
        sourceFile: ts.SourceFile,
        reference: Range | ReferenceResult,
        property: ReferenceRangesProperties
    ): void {
        if (this.bases.length === 0) {
            super.addReference(sourceFile, reference, property)
            return
        }

        if (reference.label === 'range') {
            this.emitter.emit<next>({
                type: ElementTypes.edge,
                label: EdgeLabels.next,
                outV: reference.id,
                inV: this.resultSet.id,
            })
        }
        for (const base of this.bases) {
            base.addReference(sourceFile, reference, property)
        }
    }
}

export class TransientSymbolData extends SymbolData {
    public getSourceFiles(symbol: ts.Symbol, node?: ts.Node): ts.SourceFile[] {
        return node ? [node.getSourceFile()] : []
    }

    public getDeclarations(symbol: ts.Symbol, node?: ts.Node): ts.Node[] {
        return node ? [node] : []
    }

    public addDefinition(
        sourceFile: ts.SourceFile,
        definition: DefinitionRange,
        recordAsReference = true
    ): void {
        return
    }

    public addDefinitionInfo(info: DefinitionInfo): void {
        return
    }
}

export class UnionOrIntersectionSymbolData extends SymbolData {
    constructor(
        emitter: Emitter,
        document: Document,
        resultSet: ResultSet,
        private elements: SymbolData[],
        private sourceFile: ts.SourceFile
    ) {
        super(emitter, document, resultSet)
    }

    public begin(): void {
        super.begin()

        for (const element of this.elements) {
            super.addReference(
                this.sourceFile,
                element.getOrCreateReferenceResult()
            )
        }
    }

    public getSourceFiles(symbol: ts.Symbol, node?: ts.Node): ts.SourceFile[] {
        return node ? [node.getSourceFile()] : []
    }

    public getDeclarations(symbol: ts.Symbol, node?: ts.Node): ts.Node[] {
        return node ? [node] : []
    }

    public getText(
        symbol: ts.Symbol,
        node?: ts.Node
    ): { text: string; node: ts.Node } | undefined {
        return node && { text: node.getText(), node }
    }

    public addDefinition(
        sourceFile: ts.SourceFile,
        definition: DefinitionRange,
        recordAsReference = true
    ): void {
        return
    }

    public addDefinitionInfo(info: DefinitionInfo): void {
        return
    }
}

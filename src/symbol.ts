import {
    DefinitionRange,
    DefinitionResult,
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
import { Emitter } from './writer'
import * as tss from './typescripts'

type ReferenceRangesProperties =
    | ItemEdgeProperties.declarations
    | ItemEdgeProperties.definitions
    | ItemEdgeProperties.references

export class SymbolData {
    private resultSet: ResultSet
    private definitionRanges: DefinitionRange[] = []
    private referenceResults: ReferenceResult[] = []
    private referenceRanges = new Map<ReferenceRangesProperties, Range[]>()
    private definitionInfo: tss.DefinitionInfo[] = []

    public constructor(
        protected emitter: Emitter,
        protected document: Document
    ) {
        this.resultSet = this.emitter.vertex.resultSet()
    }

    public getResultSet(): ResultSet {
        return this.resultSet
    }

    public begin(): void {
        this.emitter.emit(this.resultSet)
    }

    public getSourceFiles(symbol: ts.Symbol, node?: ts.Node): ts.SourceFile[] {
        return Array.from(
            tss.getUniqueSourceFiles(symbol.getDeclarations()).values()
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

    public addDefinition(
        sourceFile: ts.SourceFile,
        definition: DefinitionRange,
        recordAsReference = true
    ): void {
        this.emitter.emit(this.emitter.edge.next(definition, this.resultSet))
        this.definitionRanges.push(definition)
        if (recordAsReference) {
            this.addReference(
                sourceFile,
                definition,
                ItemEdgeProperties.definitions
            )
        }
    }

    public addDefinitionInfo(info: tss.DefinitionInfo): void {
        this.definitionInfo.push(info)
    }

    public hasDefinitionInfo(info: tss.DefinitionInfo): boolean {
        return this.definitionInfo.some((definitionInfo) =>
            tss.DefinitionInfo.equals(info, definitionInfo)
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
                    this.emitter.emit(
                        this.emitter.edge.next(reference, this.resultSet)
                    )
                    this.referenceRanges.set(
                        property,
                        (this.referenceRanges.get(property) || []).concat([
                            reference,
                        ])
                    )
                }
                break

            case VertexLabels.referenceResult:
                this.referenceResults.push(reference)
                break
        }
    }

    public addHover(hover: lsp.Hover): void {
        const hoverResult = this.emitter.vertex.hoverResult(hover)
        this.emitter.emit(hoverResult)
        this.emitter.emit(this.emitter.edge.hover(this.resultSet, hoverResult))
    }

    public addMoniker(moniker: Moniker): void {
        this.emitter.emit(this.emitter.edge.moniker(this.resultSet, moniker))
    }

    public end(): void {
        if (this.definitionRanges.length > 0) {
            const definitionResult = this.getOrCreateDefinitionResult()

            this.emitter.emit(
                this.emitter.edge.item(
                    definitionResult,
                    this.definitionRanges,
                    this.document
                )
            )
        }

        if (this.referenceRanges.size > 0) {
            const referenceResult = this.getOrCreateReferenceResult()

            for (const [property, values] of this.referenceRanges.entries()) {
                this.emitter.emit(
                    this.emitter.edge.item(
                        referenceResult,
                        values,
                        this.document,
                        property
                    )
                )
            }
        }

        if (this.referenceResults.length > 0) {
            const referenceResult = this.getOrCreateReferenceResult()

            this.emitter.emit(
                this.emitter.edge.item(
                    referenceResult,
                    this.referenceResults,
                    this.document
                )
            )
        }
    }

    public getOrCreateDefinitionResult(): DefinitionResult {
        const definitionResult = this.emitter.vertex.definitionResult()
        this.emitter.emit(definitionResult)
        this.emitter.emit(
            this.emitter.edge.definition(this.resultSet, definitionResult)
        )
        return definitionResult
    }

    public getOrCreateReferenceResult(): ReferenceResult {
        const referenceResult = this.emitter.vertex.referencesResult()
        this.emitter.emit(referenceResult)
        this.emitter.emit(
            this.emitter.edge.references(this.resultSet, referenceResult)
        )
        return referenceResult
    }
}

export class AliasSymbolData extends SymbolData {
    constructor(
        emitter: Emitter,
        document: Document,
        private aliased: SymbolData,
        private rename: boolean
    ) {
        super(emitter, document)
    }

    public begin(): void {
        super.begin()

        this.emitter.emit(
            this.emitter.edge.next(
                this.getResultSet(),
                this.aliased.getResultSet()
            )
        )
    }

    public addDefinition(
        sourceFile: ts.SourceFile,
        definition: DefinitionRange,
        recordAsReference = true
    ): void {
        if (this.rename) {
            super.addDefinition(sourceFile, definition, false)
        } else {
            this.emitter.emit(
                this.emitter.edge.next(definition, this.getResultSet())
            )
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
            this.emitter.emit(
                this.emitter.edge.next(reference, this.getResultSet())
            )
        }
        this.aliased.addReference(sourceFile, reference, property)
    }
}

export class MethodSymbolData extends SymbolData {
    constructor(
        emitter: Emitter,
        document: Document,
        private bases: SymbolData[],
        private sourceFile: ts.SourceFile
    ) {
        super(emitter, document)
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
            this.emitter.emit(
                this.emitter.edge.next(reference, this.getResultSet())
            )
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

    public addDefinitionInfo(info: tss.DefinitionInfo): void {
        return
    }
}

export class UnionOrIntersectionSymbolData extends SymbolData {
    constructor(
        emitter: Emitter,
        document: Document,
        private elements: SymbolData[],
        private sourceFile: ts.SourceFile
    ) {
        super(emitter, document)
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

    public addDefinitionInfo(info: tss.DefinitionInfo): void {
        return
    }
}

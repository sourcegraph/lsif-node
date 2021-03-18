import { Document, Range } from 'lsif-protocol'
import { Emitter } from './writer'

export class DocumentData {
    private ranges: Range[] = []

    public constructor(
        private emitter: Emitter,
        public document: Document,
        public externalLibrary: boolean,
        public monikerPath?: string
    ) {}

    public begin(): void {
        this.emitter.emit(this.document)
    }

    public addRange(range: Range): void {
        this.ranges.push(range)
    }

    public end(): void {
        if (this.ranges.length > 0) {
            this.emitter.emit(
                this.emitter.edge.contains(this.document, this.ranges)
            )
        }
    }
}

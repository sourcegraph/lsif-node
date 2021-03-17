import { Document, Range } from 'lsif-protocol'
import { Emitter } from '../emitter'
import { Builder } from '../graph'

export class DocumentData {
  private ranges: Range[] = []

  public constructor(
    private builder: Builder,
    private emitter: Emitter,
    public document: Document,
    public monikerPath: string | undefined,
    public externalLibrary: boolean
  ) {}

  public begin(): void {
    this.emitter.emit(this.document)
  }

  public addRange(range: Range): void {
    this.ranges.push(range)
  }

  public end(): void {
    if (this.ranges.length > 0) {
      this.emitter.emit(this.builder.edge.contains(this.document, this.ranges))
    }
  }
}

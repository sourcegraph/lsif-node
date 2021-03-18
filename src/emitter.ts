import { Edge, Vertex } from 'lsif-protocol'

export interface Emitter {
    emit(element: Vertex | Edge): void
}

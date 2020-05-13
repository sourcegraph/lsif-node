/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { Vertex, Edge } from 'lsif-protocol'
import { Writer } from './writer'
import { VertexBuilder, EdgeBuilder,  } from './graph'

export interface Emitter {
  emit(element: Vertex | Edge): void
}

export function create(writer: Writer): Emitter {
  return {
    emit: element => writer.writeln(JSON.stringify(element, undefined, 0)),
  }
}

export interface EmitContext {
  vertex: VertexBuilder
  edge: EdgeBuilder
  emit(element: Vertex | Edge): void
}

import { Descriptor } from './Descriptor'

export class Symbol {
  constructor(public readonly value: string) {}
  public static local(counter: number): Symbol {
    return new Symbol(`local ${counter}`)
  }
  public static empty(): Symbol {
    return new Symbol('')
  }
  public static package(name: string, version: string): Symbol {
    return new Symbol(`lsif-node npm ${name} ${version} `)
  }
  public static global(owner: Symbol, descriptor: Descriptor): Symbol {
    return new Symbol(owner.value + descriptor.syntax())
  }
}

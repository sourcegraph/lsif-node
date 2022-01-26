import { Descriptor } from './Descriptor'

export class Sym {
  private constructor(public readonly value: string) {}
  public isEmpty(): boolean {
    return this.value === ''
  }
  public isLocal(): boolean {
    return this.value.startsWith('local ')
  }
  public isEmptyOrLocal(): boolean {
    return this.isEmpty() || this.isLocal()
  }

  public static local(counter: number): Sym {
    return new Sym(`local ${counter}`)
  }
  public static empty(): Sym {
    return new Sym('')
  }
  public static package(name: string, version: string): Sym {
    return new Sym(`lsif-node npm ${name} ${version} `)
  }
  public static global(owner: Sym, descriptor: Descriptor): Sym {
    return new Sym(owner.value + descriptor.syntax())
  }
}

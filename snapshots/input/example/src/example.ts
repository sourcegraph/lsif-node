interface Hello {
  prop: string
}

export enum Foo {
  A,
  B,
}
class Bar<A> {
  classProp = 42
  constructor(public readonly a: string) {}
  public method<B>(x: number, y: A, z: B) {
    return `${x}${y}${z}`.length
  }
  static bar() {
    return new Bar('a')
  }
}
export function redirect() {
  const a = 'a'
  let b = { a, b: 'b' }
  var c = { b, x: 1 }
  for (const x of [1, 2, 3]) {
    c.x = x
  }
  return {
    ...b,
    c,
    d: 'd',
  }
}

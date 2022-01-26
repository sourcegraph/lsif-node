interface Hello {
  prop: string
}
class Bar {
  constructor(public readonly a: string) {}
  private method(x: number) {
    return x + 1
  }
  static bar() {
    return new Bar('a')
  }
}
export function redirect() {
  const a = 'a'
  let b = { a, b: 'b' }
  var c = { b }
  return {
    ...b,
    c,
    d: 'd',
  }
}

  interface Hello {
//          ^^^^^ definition example 1.0.0 src/example.ts/Hello#
    prop: string
//  ^^^^ definition example 1.0.0 src/example.ts/Hello#prop.
  }
  class Bar {
//      ^^^ reference local 0
    constructor(public readonly a: string) {}
//                              ^ reference local 2
    private method(x: number) {
//          ^^^^^^ definition local 3
//                 ^ reference local 4
      return x + 1
//           ^ reference local 4
    }
    static bar() {
//         ^^^ definition local 5
      return new Bar('a')
//               ^^^ reference local 0
    }
  }
  export function redirect() {
//                ^^^^^^^^ definition example 1.0.0 src/example.ts/redirect().
    const a = 'a'
//        ^ definition local 8
    let b = { a, b: 'b' }
//      ^ definition local 11
//            ^ definition example 1.0.0 src/example.ts/a0:
//               ^ definition example 1.0.0 src/example.ts/b0:
    var c = { b }
//      ^ definition local 14
//            ^ definition example 1.0.0 src/example.ts/b1:
    return {
      ...b,
//       ^ reference local 11
      c,
//    ^ definition example 1.0.0 src/example.ts/c0:
      d: 'd',
//    ^ definition example 1.0.0 src/example.ts/d0:
    }
  }
  

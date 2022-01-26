  interface Hello {
//          ^^^^^ definition example 1.0.0 src/example.ts/Hello#
    prop: string
//  ^^^^ definition example 1.0.0 src/example.ts/Hello#prop.
  }
  
  export enum Foo {
//            ^^^ definition example 1.0.0 src/example.ts/Foo#
    A,
//  ^ reference example 1.0.0 src/example.ts/Foo#A.
    B,
//  ^ reference example 1.0.0 src/example.ts/Foo#B.
  }
  class Bar<A> {
//      ^^^ reference example 1.0.0 src/example.ts/Bar#
//          ^ definition example 1.0.0 src/example.ts/Bar#[A]
    classProp = 42
//  ^^^^^^^^^ definition example 1.0.0 src/example.ts/Bar#classProp.
    constructor(public readonly a: string) {}
//                              ^ definition example 1.0.0 src/example.ts/Bar#<constructor>().(a)
    public method<B>(x: number, y: A, z: B) {
//         ^^^^^^ definition example 1.0.0 src/example.ts/Bar#method().
//                ^ definition example 1.0.0 src/example.ts/Bar#method().[B]
//                   ^ definition example 1.0.0 src/example.ts/Bar#method().(x)
//                              ^ definition example 1.0.0 src/example.ts/Bar#method().(y)
//                                 ^ reference example 1.0.0 src/example.ts/Bar#[A]
//                                    ^ definition example 1.0.0 src/example.ts/Bar#method().(z)
//                                       ^ reference example 1.0.0 src/example.ts/Bar#method().[B]
      return `${x}${y}${z}`.length
//              ^ reference example 1.0.0 src/example.ts/Bar#method().(x)
//                  ^ reference example 1.0.0 src/example.ts/Bar#method().(y)
//                      ^ reference example 1.0.0 src/example.ts/Bar#method().(z)
//                          ^^^^^^ reference typescript 4.5.5 lib/lib.es5.d.ts/String#length.
    }
    static bar() {
//         ^^^ definition example 1.0.0 src/example.ts/Bar#bar().
      return new Bar('a')
//               ^^^ reference example 1.0.0 src/example.ts/Bar#
    }
  }
  export function redirect() {
//                ^^^^^^^^ definition example 1.0.0 src/example.ts/redirect().
    const a = 'a'
//        ^ definition local 2
    let b = { a, b: 'b' }
//      ^ definition local 5
//            ^ definition example 1.0.0 src/example.ts/a0:
//               ^ definition example 1.0.0 src/example.ts/b0:
    var c = { b, x: 1 }
//      ^ definition local 8
//            ^ definition example 1.0.0 src/example.ts/b1:
//               ^ definition example 1.0.0 src/example.ts/x0:
    for (const x of [1, 2, 3]) {
//             ^ definition local 11
      c.x = x
//    ^ reference local 8
//      ^ reference example 1.0.0 src/example.ts/x0:
//          ^ reference local 11
    }
    return {
      ...b,
//       ^ reference local 5
      c,
//    ^ definition example 1.0.0 src/example.ts/c0:
      d: 'd',
//    ^ definition example 1.0.0 src/example.ts/d0:
    }
  }
  

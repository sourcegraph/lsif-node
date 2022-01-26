  export function redirect() {
//                ^^^^^^^^ reference example 1.0.0 src/example.ts/redirect().
    const a = 'a'
//        ^ reference local 2
    const b = { a, b: 'b' }
//        ^ reference local 5
//              ^ reference example 1.0.0 src/example.ts/a0:
//                 ^ reference example 1.0.0 src/example.ts/b0:
    const c = { b }
//        ^ reference local 8
//              ^ reference example 1.0.0 src/example.ts/b1:
    return {
      ...b,
//       ^ reference local 5
      c,
//    ^ reference example 1.0.0 src/example.ts/c0:
      d: 'd',
//    ^ reference example 1.0.0 src/example.ts/d0:
    }
  }
  

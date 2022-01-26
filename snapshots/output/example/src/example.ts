  export function redirect() {
//                ^^^^^^^^ reference example 1.0.0 src/example.ts/redirect().
    const a = 'a'
//        ^ reference local 2
    const b = { a }
//        ^ reference local 5
//              ^ reference local 7
    return b.a
//         ^ reference local 5
//           ^ reference local 7
  }
  

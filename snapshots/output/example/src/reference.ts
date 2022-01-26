  import { redirect } from './example'
//         ^^^^^^^^ reference example 1.0.0 src/example.ts/redirect().
  
  export function foo() {
//                ^^^ reference example 1.0.0 src/reference.ts/foo().
    const x = redirect()
//        ^ reference local 2
//            ^^^^^^^^ reference example 1.0.0 src/example.ts/redirect().
    return x.a + x.b + x.c.b.a + x.c.b.b + x.d
//         ^ reference local 2
//           ^ reference example 1.0.0 src/example.ts/a0:
//               ^ reference local 2
//                 ^ reference example 1.0.0 src/example.ts/b0:
//                     ^ reference local 2
//                       ^ reference example 1.0.0 src/example.ts/c0:
//                         ^ reference example 1.0.0 src/example.ts/b1:
//                           ^ reference example 1.0.0 src/example.ts/a0:
//                               ^ reference local 2
//                                 ^ reference example 1.0.0 src/example.ts/c0:
//                                   ^ reference example 1.0.0 src/example.ts/b1:
//                                     ^ reference example 1.0.0 src/example.ts/b0:
//                                         ^ reference local 2
//                                           ^ reference example 1.0.0 src/example.ts/d0:
  }
  

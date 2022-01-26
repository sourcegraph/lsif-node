  import { hello } from '../../../input/example/src/example'
//         ^^^^^ reference local 3
  
  export function run(): string {
//                ^^^ reference example 1.0.0 src/reference.ts/run().
    hello().bar()
//  ^^^^^ reference local 3
//          ^^^ reference example 1.0.0 src/example.ts/Container#bar().
    return hello().prop
//         ^^^^^ reference local 3
//                 ^^^^ reference example 1.0.0 src/example.ts/Container#prop.
  }
  

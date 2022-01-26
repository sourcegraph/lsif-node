  import { join } from 'path'
//         ^^^^ reference local 3
  
  interface Container {
//          ^^^^^^^^^ reference example 1.0.0 src/example.ts/Container#
    prop: string
//  ^^^^ reference example 1.0.0 src/example.ts/Container#prop.
    bar(): string
//  ^^^ reference example 1.0.0 src/example.ts/Container#bar().
  }
  
  export function hello(): Container {
//                ^^^^^ reference example 1.0.0 src/example.ts/hello().
//                         ^^^^^^^^^ reference example 1.0.0 src/example.ts/Container#
    return {
      prop: '',
//    ^^^^ reference local 7
      bar() {
//    ^^^ reference local 8
        return ''
      },
    }
  }
  interface Hello {
//          ^^^^^ reference example 1.0.0 src/example.ts/Hello#
    name: string
//  ^^^^ reference example 1.0.0 src/example.ts/Hello#name.
  }
  
  export function main(h: Hello): void {
//                ^^^^ reference example 1.0.0 src/example.ts/main().
//                     ^ reference local 9
//                        ^^^^^ reference example 1.0.0 src/example.ts/Hello#
    const message = `hello ${h.name}!`
//        ^^^^^^^ reference local 13
//                           ^ reference local 9
//                             ^^^^ reference example 1.0.0 src/example.ts/Hello#name.
    console.log(join(message, message))
//  ^^^^^^^ reference typescript 4.5.5 lib/lib.dom.d.ts/console.
//  ^^^^^^^ reference @types/node 17.0.10 globals.d.ts/console.
//  ^^^^^^^ reference @types/node 17.0.10 console.d.ts/'node:console'/global/console/
//  ^^^^^^^ reference @types/node 17.0.10 console.d.ts/'node:console'/global/console.
//          ^^^ reference typescript 4.5.5 lib/lib.dom.d.ts/Console#log().
//          ^^^ reference @types/node 17.0.10 console.d.ts/'node:console'/global/Console#log().
//              ^^^^ reference local 3
//                   ^^^^^^^ reference local 13
//                            ^^^^^^^ reference local 13
  }
  
  export function helper(): void {
//                ^^^^^^ reference example 1.0.0 src/example.ts/helper().
    const hello1 = { name: 'Susan' }
//        ^^^^^^ reference local 17
//                   ^^^^ reference local 19
    console.log(hello1.name)
//  ^^^^^^^ reference typescript 4.5.5 lib/lib.dom.d.ts/console.
//  ^^^^^^^ reference @types/node 17.0.10 globals.d.ts/console.
//  ^^^^^^^ reference @types/node 17.0.10 console.d.ts/'node:console'/global/console/
//  ^^^^^^^ reference @types/node 17.0.10 console.d.ts/'node:console'/global/console.
//          ^^^ reference typescript 4.5.5 lib/lib.dom.d.ts/Console#log().
//          ^^^ reference @types/node 17.0.10 console.d.ts/'node:console'/global/Console#log().
//              ^^^^^^ reference local 17
//                     ^^^^ reference local 19
    main(hello1)
//  ^^^^ reference example 1.0.0 src/example.ts/main().
//       ^^^^^^ reference local 17
  
    const hello2: Hello = { name: 'Susan' }
//        ^^^^^^ reference local 22
//                ^^^^^ reference example 1.0.0 src/example.ts/Hello#
//                          ^^^^ reference local 24
    console.log(hello2.name)
//  ^^^^^^^ reference typescript 4.5.5 lib/lib.dom.d.ts/console.
//  ^^^^^^^ reference @types/node 17.0.10 globals.d.ts/console.
//  ^^^^^^^ reference @types/node 17.0.10 console.d.ts/'node:console'/global/console/
//  ^^^^^^^ reference @types/node 17.0.10 console.d.ts/'node:console'/global/console.
//          ^^^ reference typescript 4.5.5 lib/lib.dom.d.ts/Console#log().
//          ^^^ reference @types/node 17.0.10 console.d.ts/'node:console'/global/Console#log().
//              ^^^^^^ reference local 22
//                     ^^^^ reference example 1.0.0 src/example.ts/Hello#name.
    const hello3 = { hello2 }
//        ^^^^^^ reference local 27
//                   ^^^^^^ reference local 29
    console.log(hello3.hello2)
//  ^^^^^^^ reference typescript 4.5.5 lib/lib.dom.d.ts/console.
//  ^^^^^^^ reference @types/node 17.0.10 globals.d.ts/console.
//  ^^^^^^^ reference @types/node 17.0.10 console.d.ts/'node:console'/global/console/
//  ^^^^^^^ reference @types/node 17.0.10 console.d.ts/'node:console'/global/console.
//          ^^^ reference typescript 4.5.5 lib/lib.dom.d.ts/Console#log().
//          ^^^ reference @types/node 17.0.10 console.d.ts/'node:console'/global/Console#log().
//              ^^^^^^ reference local 27
//                     ^^^^^^ reference local 29
    main(hello2)
//  ^^^^ reference example 1.0.0 src/example.ts/main().
//       ^^^^^^ reference local 22
  }
  

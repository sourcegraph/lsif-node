  import { join } from "path";
//         ^^^^ reference local 4
  interface Hello {
//          ^^^^^ reference local 5
    name: string;
//  ^^^^ reference local 6
  }
  
  export function main(h: Hello): void {
//                ^^^^ reference local 7
//                     ^ reference local 8
//                        ^^^^^ reference local 5
    const message = `hello ${h.name}!`;
//        ^^^^^^^ reference local 12
//                           ^ reference local 8
//                             ^^^^ reference local 6
    console.log(join(message, message));
//  ^^^^^^^ reference local 16
//  ^^^^^^^ reference local 20
//  ^^^^^^^ reference local 26
//  ^^^^^^^ reference local 29
//          ^^^ reference local 31
//          ^^^ reference local 33
//              ^^^^ reference local 4
//                   ^^^^^^^ reference local 12
//                            ^^^^^^^ reference local 12
  }
  
  export function helper() {
//                ^^^^^^ reference local 34
    const hello1 = { name: "Susan" };
//        ^^^^^^ reference local 38
//                   ^^^^ reference local 40
    console.log(hello1.name);
//  ^^^^^^^ reference local 16
//  ^^^^^^^ reference local 20
//  ^^^^^^^ reference local 26
//  ^^^^^^^ reference local 29
//          ^^^ reference local 31
//          ^^^ reference local 33
//              ^^^^^^ reference local 38
//                     ^^^^ reference local 40
    main(hello1);
//  ^^^^ reference local 7
//       ^^^^^^ reference local 38
  
    const hello2: Hello = { name: "Susan" };
//        ^^^^^^ reference local 43
//                ^^^^^ reference local 5
//                          ^^^^ reference local 45
    console.log(hello2.name);
//  ^^^^^^^ reference local 16
//  ^^^^^^^ reference local 20
//  ^^^^^^^ reference local 26
//  ^^^^^^^ reference local 29
//          ^^^ reference local 31
//          ^^^ reference local 33
//              ^^^^^^ reference local 43
//                     ^^^^ reference local 6
    const hello3 = { hello2 };
//        ^^^^^^ reference local 48
//                   ^^^^^^ reference local 50
    console.log(hello3.hello2);
//  ^^^^^^^ reference local 16
//  ^^^^^^^ reference local 20
//  ^^^^^^^ reference local 26
//  ^^^^^^^ reference local 29
//          ^^^ reference local 31
//          ^^^ reference local 33
//              ^^^^^^ reference local 48
//                     ^^^^^^ reference local 50
    main(hello2);
//  ^^^^ reference local 7
//       ^^^^^^ reference local 43
  }
  

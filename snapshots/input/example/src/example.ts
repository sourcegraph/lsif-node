import { join } from 'path'

interface Container {
  prop: string
  bar(): string
}

export function hello(): Container {
  return {
    prop: '',
    bar() {
      return ''
    },
  }
}
interface Hello {
  name: string
}

export function main(h: Hello): void {
  const message = `hello ${h.name}!`
  console.log(join(message, message))
}

export function helper(): void {
  const hello1 = { name: 'Susan' }
  console.log(hello1.name)
  main(hello1)

  const hello2: Hello = { name: 'Susan' }
  console.log(hello2.name)
  const hello3 = { hello2 }
  console.log(hello3.hello2)
  main(hello2)
}

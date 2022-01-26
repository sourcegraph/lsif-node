import { redirect } from './example'

export function foo() {
  const x = redirect()
  return x.a + x.b + x.c.b.a + x.c.b.b + x.d
}

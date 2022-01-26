import { hello } from '../../../input/example/src/example'

export function run(): string {
  hello().bar()
  return hello().prop
}

import { Hocuspocus, Configuration } from '@hocuspocus/server'

export const newHocuspocus = (options?: Partial<Configuration>) => {
  // 创建一个Hocuspocus Server实例(Hocuspocus类实例)并返回
  // 端口是随机的

  const server = new Hocuspocus({
    // We don’t need the logging in testing.
    quiet: true,
    // Binding something port 0 will end up on a random free port.
    // That’s helpful to run tests concurrently.
    port: 0,
    // Add or overwrite settings, depending on the test case.
    ...options,
  })

  return server.listen()
}

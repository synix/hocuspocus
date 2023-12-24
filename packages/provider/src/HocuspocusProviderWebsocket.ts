import {
  Forbidden, MessageTooBig, Unauthorized, WsReadyStates,
} from '@hocuspocus/common'
import { retry } from '@lifeomic/attempt'
import * as time from 'lib0/time'
import * as url from 'lib0/url'
import type { MessageEvent } from 'ws'
import { Event } from 'ws'
import EventEmitter from './EventEmitter.js'
import { HocuspocusProvider } from './HocuspocusProvider.js'
import {
  WebSocketStatus,
  onAwarenessChangeParameters, onAwarenessUpdateParameters,
  onCloseParameters, onDisconnectParameters, onMessageParameters, onOpenParameters, onOutgoingMessageParameters, onStatusParameters,
} from './types.js'
import { IncomingMessage } from './IncomingMessage.js'

// HocusPocusWebSocket是WebSocket的子类，多了一个identifier属性，作为WebSocket对象的唯一标识
export type HocusPocusWebSocket = WebSocket & { identifier: string };

export type HocuspocusProviderWebsocketConfiguration =
  Required<Pick<CompleteHocuspocusProviderWebsocketConfiguration, 'url'>>
  & Partial<CompleteHocuspocusProviderWebsocketConfiguration>

export interface CompleteHocuspocusProviderWebsocketConfiguration {
  /**
   * URL of your @hocuspocus/server instance
   */
   url: string,

  /**
   * Pass `false` to start the connection manually.
   */
  connect: boolean,

  /**
   * URL parameters that should be added.
   */
  parameters: { [key: string]: any },
  /**
   * An optional WebSocket polyfill, for example for Node.js
   */
  WebSocketPolyfill: any,

  /**
   * Disconnect when no message is received for the defined amount of milliseconds.
   */
  messageReconnectTimeout: number,

  // 以下8个字段是调用@lifeomic/attempt库的retry()函数用的
  // See https://github.com/lifeomic/attempt?tab=readme-ov-file#usage

  /**
   * The delay between each attempt in milliseconds. You can provide a factor to have the delay grow exponentially.
   * @lifeomic/attempt库的delay缺省值为200(ms)
   */
  delay: number,
  /**
   * The intialDelay is the amount of time to wait before making the first attempt. This option should typically be 0 since you typically want the first attempt to happen immediately.
   * @lifeomic/attempt库的initialDelay缺省值为0
   */
  initialDelay: number,
  /**
   * The factor option is used to grow the delay exponentially.
   * @lifeomic/attempt库的factor缺省值为0
   */
  factor: number,
  /**
   * The maximum number of attempts or 0 if there is no limit on number of attempts.
   * @lifeomic/attempt库的maxAttempts缺省值为3
   */
  maxAttempts: number,
  /**
   * minDelay is used to set a lower bound of delay when jitter is enabled. This property has no effect if jitter is disabled.
   * @lifeomic/attempt库的minDelay缺省值为0
   */
  minDelay: number,
  /**
   * The maxDelay option is used to set an upper bound for the delay when factor is enabled. A value of 0 can be provided if there should be no upper bound when calculating delay.
   * @lifeomic/attempt库的maxDelay缺省值为0
   */
  maxDelay: number,
  /**
   * If jitter is true then the calculated delay will be a random integer value between minDelay and the calculated delay for the current iteration.
   * jitter用于给delay加上随机值，以防止多个客户端同时重连
   */
  jitter: boolean,
  /**
   * A timeout in milliseconds. If timeout is non-zero then a timer is set using setTimeout. If the timeout is triggered then future attempts will be aborted.
   * @lifeomic/attempt库的timeout缺省值为0, handleTimeout()函数在发生timeout时可以提供fallback功能，不过handleTimeout()函数缺省值为null，
   */
  timeout: number,

  onOpen: (data: onOpenParameters) => void,
  onConnect: () => void,
  onMessage: (data: onMessageParameters) => void,
  onOutgoingMessage: (data: onOutgoingMessageParameters) => void,
  onStatus: (data: onStatusParameters) => void,
  onDisconnect: (data: onDisconnectParameters) => void,
  onClose: (data: onCloseParameters) => void,
  onDestroy: () => void,
  onAwarenessUpdate: (data: onAwarenessUpdateParameters) => void,
  onAwarenessChange: (data: onAwarenessChangeParameters) => void,
  /**
   * Don’t output any warnings.
   */
  quiet: boolean,

  /**
   * Map of attached providers keyed by documentName.
   */

  // 存储的是documentName和HocuspocusProvider对应关系
  // attach()和detach()函数会维护这个Map
  providerMap: Map<string, HocuspocusProvider>,
}

export class HocuspocusProviderWebsocket extends EventEmitter {
  // messageQueue用于在WebSocket的readyState不等于OPEN时，缓存待发送的消息
  private messageQueue: any[] = []

  public configuration: CompleteHocuspocusProviderWebsocketConfiguration = {
    url: '',
    // @ts-ignore
    document: undefined,
    WebSocketPolyfill: undefined,
    parameters: {},
    connect: true,
    broadcast: true,
    forceSyncInterval: false,
    // TODO: this should depend on awareness.outdatedTime
    // 这个为什么缺省值是30s?
    messageReconnectTimeout: 30000,

    // 下面8个字段是调用@lifeomic/attempt库的retry()函数用的
    // 这里相当于提供了自己的retry()函数的一套缺省值
    // 1 second
    delay: 1000,
    // instant
    initialDelay: 0,
    // double the delay each time
    factor: 2,
    // unlimited retries
    maxAttempts: 0,
    // wait at least 1 second
    minDelay: 1000,
    // at least every 30 seconds
    maxDelay: 30000,
    // randomize
    jitter: true,
    // retry forever
    timeout: 0,

    onOpen: () => null,
    onConnect: () => null,
    onMessage: () => null,
    onOutgoingMessage: () => null,
    onStatus: () => null,
    onDisconnect: () => null,
    onClose: () => null,
    onDestroy: () => null,
    onAwarenessUpdate: () => null,
    onAwarenessChange: () => null,
    quiet: false,
    providerMap: new Map(),
  }

  webSocket: HocusPocusWebSocket | null = null

  webSocketHandlers: { [key: string]: any } = {}

  // shouldConnect表示不要再重连了
  shouldConnect = true

  // status初始值为Disconnected
  // 调用createWebSocketConnection()函数创建WebSocket对象后，会将status设置为Connecting
  // 接收到WebSocket对象的message事件会将status设置为Connected，在onMessage()函数中
  // 接收到WebSocket对象的close事件会将status设置为Disconnected，在onClose()函数中
  status = WebSocketStatus.Disconnected

  // 最后1次接收到message事件的时间戳
  lastMessageReceived = 0

  identifier = 0

  // intervals存放着轮询的定时器，也就是setInterval()的返回值
  intervals: any = {
    forceSync: null,
    // 长时间没有接收到message事件时，关闭WebSocket连接
    connectionChecker: null,
  }

  connectionAttempt: {
    resolve: (value?: any) => void;
    reject: (reason?: any) => void;
  } | null = null

  constructor(configuration: HocuspocusProviderWebsocketConfiguration) {
    super()
    this.setConfiguration(configuration)

    // 也就是说，如果没有提供WebSocketPolyfill，那么就使用WebSocket来创建websocket连接
    // 什么时候需要提供WebSocketPolyfill？
    // 比如在nodejs环境下，没有WebSocket，那就需要提供WebSocketPolyfill，例如通过ws库(https://github.com/websockets/ws/blob/master/doc/ws.md#class-websocket)
    this.configuration.WebSocketPolyfill = configuration.WebSocketPolyfill
      ? configuration.WebSocketPolyfill
      : WebSocket

    // WebSocket对象的open事件, 在attachWebSocketListeners()函数中上浮的
    this.on('open', this.configuration.onOpen)
    this.on('open', this.onOpen.bind(this))

    // connect事件等同于status=Connected事件
    this.on('connect', this.configuration.onConnect)
    // WebSocket对象的message事件, 在attachWebSocketListeners()函数中上浮的
    this.on('message', this.configuration.onMessage)

    this.on('outgoingMessage', this.configuration.onOutgoingMessage)

    // status表示WebSocket的连接状态，上浮的是this.status
    this.on('status', this.configuration.onStatus)
    this.on('status', this.onStatus.bind(this))

    // disconnect事件等同于status=Disconnected事件
    this.on('disconnect', this.configuration.onDisconnect)
    // WebSocket对象的close事件, 在attachWebSocketListeners()函数中上浮的
    this.on('close', this.configuration.onClose)

    this.on('destroy', this.configuration.onDestroy)
    this.on('awarenessUpdate', this.configuration.onAwarenessUpdate)
    this.on('awarenessChange', this.configuration.onAwarenessChange)

    // WebSocket对象的close事件, 在attachWebSocketListeners()函数中上浮的
    this.on('close', this.onClose.bind(this))
    // WebSocket对象的message事件, 在attachWebSocketListeners()函数中上浮的
    this.on('message', this.onMessage.bind(this))

    this.intervals.connectionChecker = setInterval(
      this.checkConnection.bind(this),
      // messageReconnectTimeout缺省值是30s，所以这里是每3s轮询一下
      this.configuration.messageReconnectTimeout / 10,
    )

    if (typeof configuration.connect !== 'undefined') {
      this.shouldConnect = configuration.connect
    }

    if (!this.shouldConnect) {
      return
    }

    this.connect()
  }

  // 接收到的WebSocket对象open事件的event payload
  receivedOnOpenPayload?: Event | undefined = undefined

  // this.status的当前值
  receivedOnStatusPayload?: onStatusParameters | undefined = undefined

  async onOpen(event: Event) {
    this.receivedOnOpenPayload = event
  }

  async onStatus(data: onStatusParameters) {
    this.receivedOnStatusPayload = data
  }

  attach(provider: HocuspocusProvider) {
    this.configuration.providerMap.set(provider.configuration.name, provider)

    if (this.status === WebSocketStatus.Disconnected && this.shouldConnect) {
      this.connect()
    }

    if (this.receivedOnOpenPayload) {
      provider.onOpen(this.receivedOnOpenPayload)
    }

    if (this.receivedOnStatusPayload) {
      provider.onStatus(this.receivedOnStatusPayload)
    }
  }

  detach(provider: HocuspocusProvider) {
    this.configuration.providerMap.delete(provider.configuration.name)
  }

  public setConfiguration(
    configuration: Partial<HocuspocusProviderWebsocketConfiguration> = {},
  ): void {
    this.configuration = { ...this.configuration, ...configuration }
  }

  // 是一个函数类型，用于取消websocket重试
  cancelWebsocketRetry?: () => void

  async connect() {
    // 如果websocket当前状态是已连接，则直接返回
    if (this.status === WebSocketStatus.Connected) {
      return
    }

    // Always cancel any previously initiated connection retryer instances
    if (this.cancelWebsocketRetry) {
      this.cancelWebsocketRetry()
      this.cancelWebsocketRetry = undefined
    }

    this.receivedOnOpenPayload = undefined
    this.receivedOnStatusPayload = undefined
    this.shouldConnect = true

    const abortableRetry = () => {
      let cancelAttempt = false

      const retryPromise = retry(this.createWebSocketConnection.bind(this), {
        // 这么一看，CompleteHocuspocusProviderWebsocketConfiguration里面字段虽多，但是以下8个字段都是调用@lifeomic/attempt库用的
        delay: this.configuration.delay,
        initialDelay: this.configuration.initialDelay,
        factor: this.configuration.factor,
        maxAttempts: this.configuration.maxAttempts,
        minDelay: this.configuration.minDelay,
        maxDelay: this.configuration.maxDelay,
        jitter: this.configuration.jitter,
        timeout: this.configuration.timeout,
        beforeAttempt: context => {
          // 每次重试前都会调用beforeAttempt()函数，这里面会调用AttemptContext.abort()函数来取消重试

          // cancelAttempt变量和下面的cancelFunc()函数提供了一种取消重试的机制
          if (!this.shouldConnect || cancelAttempt) {
            context.abort()
          }
        },
      }).catch((error: any) => {
        // If we aborted the connection attempt then don’t throw an error
        // ref: https://github.com/lifeomic/attempt/blob/master/src/index.ts#L136
        if (error && error.code !== 'ATTEMPT_ABORTED') {
          throw error
        }
      })

      return {
        retryPromise,
        cancelFunc: () => {
          cancelAttempt = true
        },
      }
    }

    const { retryPromise, cancelFunc } = abortableRetry()
    this.cancelWebsocketRetry = cancelFunc

    return retryPromise
  }

  attachWebSocketListeners(ws: HocusPocusWebSocket, reject: Function) {
    const { identifier } = ws
    // 这里只直接处理error事件，其他事件都是通过emit()函数进一步上浮的
    const onMessageHandler = (payload: any) => this.emit('message', payload)
    const onCloseHandler = (payload: any) => this.emit('close', { event: payload })
    const onOpenHandler = (payload: any) => this.emit('open', payload)
    const onErrorHandler = (err: any) => {
      reject(err)
    }

    // 将每个WebSocket对象的identifier作为key，将其对应的事件处理函数作为value，存储到this.webSocketHandlers对象中
    this.webSocketHandlers[identifier] = {
      message: onMessageHandler,
      close: onCloseHandler,
      open: onOpenHandler,
      error: onErrorHandler,
    }

    const handlers = this.webSocketHandlers[ws.identifier]

    Object.keys(handlers).forEach(name => {
      // 给WebSocket对象注册open/message/close/error这4个事件监听
      ws.addEventListener(name, handlers[name])
    })
  }

  cleanupWebSocket() {
    if (!this.webSocket) {
      return
    }
    const { identifier } = this.webSocket
    const handlers = this.webSocketHandlers[identifier]

    // 给WebSocket对象注销open/message/close/error这4个事件监听
    Object.keys(handlers).forEach(name => {
      this.webSocket?.removeEventListener(name, handlers[name])
      delete this.webSocketHandlers[identifier]
    })

    // 调用WebSocket.close()，关闭WebSocket连接
    // See https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/close
    this.webSocket.close()
    this.webSocket = null
  }

  createWebSocketConnection() {
    return new Promise((resolve, reject) => {
      // 关闭当前WebSocket连接
      if (this.webSocket) {
        this.messageQueue = []
        this.cleanupWebSocket()
      }

      // Reset the last message received time
      this.lastMessageReceived = 0

      // 自增identifier，确保createWebSocketConnection()函数每次创建的WebSocket对象都是唯一的
      this.identifier += 1

      // Init the WebSocket connection

      // 创建WebSocket对象
      // See https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket
      const ws = new this.configuration.WebSocketPolyfill(this.url)

      // Change binary type from "blob" to "arraybuffer"
      // See https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/binaryType
      ws.binaryType = 'arraybuffer'

      // 给WebSocket对象添加一个identifier属性，用于唯一标识一个WebSocket对象
      ws.identifier = this.identifier

      // 给WebSocket对象注册事件监听
      // WebSocket也就支持open、message、close、error这4个事件
      this.attachWebSocketListeners(ws, reject)

      this.webSocket = ws

      // Reset the status
      this.status = WebSocketStatus.Connecting
      this.emit('status', { status: WebSocketStatus.Connecting })

      // Store resolve/reject for later use
      this.connectionAttempt = {
        resolve,
        reject,
      }
    })
  }

  onMessage(event: MessageEvent) {
    // 接收到的WebSocket对象message事件，表示WebSocket连接已建立
    // 所以要调用this.connectionAttempt.resolve()函数，把createWebSocketConnection()函数返回的promise对象resolve掉
    this.resolveConnectionAttempt()

    // 记录最后一次接收到message事件的时间戳
    this.lastMessageReceived = time.getUnixTime()

    const message = new IncomingMessage(event.data)
    const documentName = message.peekVarString()

    // 将事件上浮给对应HocuspocusProvider对象的onMessage()函数处理
    this.configuration.providerMap.get(documentName)?.onMessage(event)
  }

  resolveConnectionAttempt() {
    if (this.connectionAttempt) {
      this.connectionAttempt.resolve()
      this.connectionAttempt = null

      this.status = WebSocketStatus.Connected
      this.emit('status', { status: WebSocketStatus.Connected })
      this.emit('connect')
      // 将this.messageQueue中缓存的待发送的消息发送出去
      this.messageQueue.forEach(message => this.send(message))
      this.messageQueue = []
    }
  }

  stopConnectionAttempt() {
    this.connectionAttempt = null
  }

  rejectConnectionAttempt() {
    this.connectionAttempt?.reject()
    this.connectionAttempt = null
  }

  closeTries = 0

  checkConnection() {
    // Don’t check the connection when it’s not even established
    if (this.status !== WebSocketStatus.Connected) {
      return
    }

    // Don’t close the connection while waiting for the first message
    if (!this.lastMessageReceived) {
      return
    }

    // Don’t close the connection when a message was received recently
    if (
      this.configuration.messageReconnectTimeout
      >= time.getUnixTime() - this.lastMessageReceived
    ) {
      return
    }

    // checkConnection()每次轮询时，都会维护this.closeTries的值
    // 也就是说前两次会尝试通过this.webSocket?.close()来主动关闭WebSocket连接
    // 超过两次则会调用this.onClose()函数，被动承认WebSocket连接已关闭

    // No message received in a long time, not even your own
    // Awareness updates, which are updated every 15 seconds
    // if awareness is enabled.
    this.closeTries += 1
    // https://bugs.webkit.org/show_bug.cgi?id=247943
    if (this.closeTries > 2) {
      this.onClose({
        event: {
          code: 4408,
          reason: 'forced',
        },
      })
      this.closeTries = 0
    } else {
      this.webSocket?.close()
      this.messageQueue = []
    }
  }

  // Ensure that the URL always ends with /
  get serverUrl() {
    while (this.configuration.url[this.configuration.url.length - 1] === '/') {
      return this.configuration.url.slice(0, this.configuration.url.length - 1)
    }

    return this.configuration.url
  }

  get url() {
    const encodedParams = url.encodeQueryParams(this.configuration.parameters)

    return `${this.serverUrl}${encodedParams.length === 0 ? '' : `?${encodedParams}`}`
  }

  disconnect() {
    this.shouldConnect = false

    if (this.webSocket === null) {
      return
    }

    try {
      this.webSocket.close()
      this.messageQueue = []
    } catch {
      //
    }
  }

  send(message: any) {
    if (this.webSocket?.readyState === WsReadyStates.Open) {
      this.webSocket.send(message)
    } else {
      this.messageQueue.push(message)
    }
  }

  onClose({ event }: onCloseParameters) {
    this.closeTries = 0
    this.cleanupWebSocket()

    if (this.status === WebSocketStatus.Connected) {
      this.status = WebSocketStatus.Disconnected
      this.emit('status', { status: WebSocketStatus.Disconnected })
      this.emit('disconnect', { event })
    }

    // 处理服务端主动关闭WebSocket连接的情况
    // See https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent
    if (event.code === Unauthorized.code) {
      if (event.reason === Unauthorized.reason) {
        console.warn(
          '[HocuspocusProvider] An authentication token is required, but you didn’t send one. Try adding a `token` to your HocuspocusProvider configuration. Won’t try again.',
        )
      } else {
        console.warn(
          `[HocuspocusProvider] Connection closed with status Unauthorized: ${event.reason}`,
        )
      }

      this.shouldConnect = false
    }

    if (event.code === Forbidden.code) {
      /// quiet敢情就只控制了这一行console.warn()??
      if (!this.configuration.quiet) {
        console.warn(
          '[HocuspocusProvider] The provided authentication token isn’t allowed to connect to this server. Will try again.',
        )
        return // TODO REMOVE ME
      }
    }

    if (event.code === MessageTooBig.code) {
      console.warn(
        `[HocuspocusProvider] Connection closed with status MessageTooBig: ${event.reason}`,
      )
      this.shouldConnect = false
    }

    if (this.connectionAttempt) {
      // That connection attempt failed.
      // 把createWebSocketConnection()函数返回的promise对象reject掉
      this.rejectConnectionAttempt()
    } else if (this.shouldConnect) {
      // The connection was closed by the server. Let’s just try again.
      // 尝试重新建立WebSocket连接
      this.connect()
    }

    // If we’ll reconnect, we’re done for now.
    if (this.shouldConnect) {
      return
    }

    // The status is set correctly already.
    if (this.status === WebSocketStatus.Disconnected) {
      return
    }

    // Let’s update the connection status.
    this.status = WebSocketStatus.Disconnected
    this.emit('status', { status: WebSocketStatus.Disconnected })
    this.emit('disconnect', { event })
  }

  destroy() {
    this.emit('destroy')

    if (this.intervals.forceSync) {
      clearInterval(this.intervals.forceSync)
    }

    clearInterval(this.intervals.connectionChecker)

    // If there is still a connection attempt outstanding then we should stop
    // it before calling disconnect, otherwise it will be rejected in the onClose
    // handler and trigger a retry
    this.stopConnectionAttempt()

    this.disconnect()

    this.removeAllListeners()

    this.cleanupWebSocket()
  }
}

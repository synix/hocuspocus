import { awarenessStatesToArray } from '@hocuspocus/common'
import * as bc from 'lib0/broadcastchannel'
import * as mutex from 'lib0/mutex'
import type { CloseEvent, Event, MessageEvent } from 'ws'
import { Awareness, removeAwarenessStates } from 'y-protocols/awareness'
import * as Y from 'yjs'
import EventEmitter from './EventEmitter.js'
import {
  CompleteHocuspocusProviderWebsocketConfiguration,
  HocuspocusProviderWebsocket,
} from './HocuspocusProviderWebsocket.js'
import { IncomingMessage } from './IncomingMessage.js'
import { MessageReceiver } from './MessageReceiver.js'
import { MessageSender } from './MessageSender.js'
import { AuthenticationMessage } from './OutgoingMessages/AuthenticationMessage.js'
import { AwarenessMessage } from './OutgoingMessages/AwarenessMessage.js'
import { CloseMessage } from './OutgoingMessages/CloseMessage.js'
import { QueryAwarenessMessage } from './OutgoingMessages/QueryAwarenessMessage.js'
import { StatelessMessage } from './OutgoingMessages/StatelessMessage.js'
import { SyncStepOneMessage } from './OutgoingMessages/SyncStepOneMessage.js'
import { SyncStepTwoMessage } from './OutgoingMessages/SyncStepTwoMessage.js'
import { UpdateMessage } from './OutgoingMessages/UpdateMessage.js'
import {
  ConstructableOutgoingMessage,
  WebSocketStatus,
  onAuthenticationFailedParameters,
  onAwarenessChangeParameters,
  onAwarenessUpdateParameters,
  onCloseParameters,
  onDisconnectParameters,
  onMessageParameters,
  onOpenParameters,
  onOutgoingMessageParameters, onStatelessParameters,
  onStatusParameters,
  onSyncedParameters,
} from './types.js'

export type HocuspocusProviderConfiguration =
  Required<Pick<CompleteHocuspocusProviderConfiguration, 'name'>>
    & Partial<CompleteHocuspocusProviderConfiguration> & (
  // 也就是说url和websocketProvider两者必须提供其一
  Required<Pick<CompleteHocuspocusProviderWebsocketConfiguration, 'url'>> |
  Required<Pick<CompleteHocuspocusProviderConfiguration, 'websocketProvider'>>
  )

export interface CompleteHocuspocusProviderConfiguration {
  /**
  * The identifier/name of your document
  */
   name: string,
  /**
   * The actual Y.js document
   */
  document: Y.Doc,

  /**
   * Pass false to disable broadcasting between browser tabs.
   */
  broadcast: boolean,
  /**
   * An Awareness instance to keep the presence state of all clients.
   *
   * You can disable sharing awareness information by passing `null`.
   * Note that having no awareness information shared across all connections will break our ping checks
   * and thus trigger reconnects. You should always have at least one Provider with enabled awareness per
   * socket connection, or ensure that the Provider receives messages before running into `HocuspocusProviderWebsocket.messageReconnectTimeout`.
   */
  awareness: Awareness | null,
  /**
   * A token that’s sent to the backend for authentication purposes.
   */
  token: string | (() => string) | (() => Promise<string>) | null,
  /**
   * URL parameters that should be added.
   */
  parameters: { [key: string]: any },
  /**
   * Hocuspocus websocket provider
   */
  websocketProvider: HocuspocusProviderWebsocket,
  /**
   * Force syncing the document in the defined interval.
   */
  forceSyncInterval: false | number,

  onAuthenticated: () => void,
  onAuthenticationFailed: (data: onAuthenticationFailedParameters) => void,
  onOpen: (data: onOpenParameters) => void,
  onConnect: () => void,
  onMessage: (data: onMessageParameters) => void,
  onOutgoingMessage: (data: onOutgoingMessageParameters) => void,
  onStatus: (data: onStatusParameters) => void,
  onSynced: (data: onSyncedParameters) => void,
  onDisconnect: (data: onDisconnectParameters) => void,
  onClose: (data: onCloseParameters) => void,
  onDestroy: () => void,
  onAwarenessUpdate: (data: onAwarenessUpdateParameters) => void,
  onAwarenessChange: (data: onAwarenessChangeParameters) => void,
  onStateless: (data: onStatelessParameters) => void

  /**
   * Don’t output any warnings.
   */
  quiet: boolean,

  /**
   * Pass `false` to start the connection manually.
   */
  connect: boolean,

  /**
   * Pass `false` to close the connection manually.
   */
  preserveConnection: boolean,
}

export class AwarenessError extends Error {
  code = 1001
}

export class HocuspocusProvider extends EventEmitter {
  public configuration: CompleteHocuspocusProviderConfiguration = {
    name: '',
    // @ts-ignore
    document: undefined,
    // @ts-ignore
    awareness: undefined,
    token: null,
    parameters: {},
    // broadcast缺省值是true，也就是，缺省是支持在多个tab之间通过广播同步的
    broadcast: true,
    forceSyncInterval: false,
    onAuthenticated: () => null,
    onAuthenticationFailed: () => null,
    onOpen: () => null,
    onConnect: () => null,
    onMessage: () => null,
    onOutgoingMessage: () => null,
    onStatus: () => null,
    onSynced: () => null,
    onDisconnect: () => null,
    onClose: () => null,
    onDestroy: () => null,
    onAwarenessUpdate: () => null,
    onAwarenessChange: () => null,
    onStateless: () => null,
    quiet: false,
    // 缺省是支持自动连接/断开的，而不是手动连接/断开
    connect: true,
    preserveConnection: true,
  }

  subscribedToBroadcastChannel = false

  isSynced = false

  unsyncedChanges = 0

  // 映射了HocuspocusProviderWebsocket的status字段
  status = WebSocketStatus.Disconnected

  isAuthenticated = false

  // authorizedScope代表authentication，服务端返回的一个scope值，用于标识用户所具备的权限
  authorizedScope: string | undefined = undefined

  mux = mutex.createMutex()

  // intervals存放着轮询的定时器，也就是setInterval()的返回值
  intervals: any = {
    forceSync: null,
  }

  // isConnected和status的区别是什么？
  // isConnected为true时，表示已经接收到WebSocket的open消息; status为Connected时，表示已经接收到WebSocket的message消息
  // isConnected为false时，表示调用了disconnect()函数; status为Disconnected时，表示已经接收到WebSocket的close消息
  isConnected = true

  constructor(configuration: HocuspocusProviderConfiguration) {
    super()
    this.setConfiguration(configuration)

    this.configuration.document = configuration.document ? configuration.document : new Y.Doc()
    this.configuration.awareness = configuration.awareness !== undefined ? configuration.awareness : new Awareness(this.document)

    this.on('open', this.configuration.onOpen)
    // WebSocket接收到message消息后，会触发message事件
    this.on('message', this.configuration.onMessage)
    // 调用send()函数时，会触发outgoingMessage事件
    this.on('outgoingMessage', this.configuration.onOutgoingMessage)
    this.on('synced', this.configuration.onSynced)
    this.on('destroy', this.configuration.onDestroy)
    this.on('awarenessUpdate', this.configuration.onAwarenessUpdate)
    this.on('awarenessChange', this.configuration.onAwarenessChange)
    this.on('stateless', this.configuration.onStateless)

    this.on('authenticated', this.configuration.onAuthenticated)
    this.on('authenticationFailed', this.configuration.onAuthenticationFailed)

    this.configuration.websocketProvider.on('connect', this.configuration.onConnect)
    this.configuration.websocketProvider.on('connect', this.forwardConnect)

    // 表示已经接收到WebSocket的open消息
    this.configuration.websocketProvider.on('open', this.boundOnOpen)
    this.configuration.websocketProvider.on('open', this.forwardOpen)

    this.configuration.websocketProvider.on('close', this.boundOnClose)
    this.configuration.websocketProvider.on('close', this.configuration.onClose)
    this.configuration.websocketProvider.on('close', this.forwardClose)

    this.configuration.websocketProvider.on('status', this.boundOnStatus)

    this.configuration.websocketProvider.on('disconnect', this.configuration.onDisconnect)
    this.configuration.websocketProvider.on('disconnect', this.forwardDisconnect)

    this.configuration.websocketProvider.on('destroy', this.configuration.onDestroy)
    this.configuration.websocketProvider.on('destroy', this.forwardDestroy)

    this.awareness?.on('update', () => {
      this.emit('awarenessUpdate', { states: awarenessStatesToArray(this.awareness!.getStates()) })
    })

    this.awareness?.on('change', () => {
      this.emit('awarenessChange', { states: awarenessStatesToArray(this.awareness!.getStates()) })
    })

    // document发生change时
    this.document.on('update', this.documentUpdateHandler.bind(this))
    this.awareness?.on('update', this.awarenessUpdateHandler.bind(this))
    this.registerEventListeners()

    if (this.configuration.forceSyncInterval) {
      this.intervals.forceSync = setInterval(
        this.forceSync.bind(this),
        this.configuration.forceSyncInterval,
      )
    }

    this.configuration.websocketProvider.attach(this)
  }

  boundBroadcastChannelSubscriber = this.broadcastChannelSubscriber.bind(this)

  boundPageUnload = this.pageUnload.bind(this)

  boundOnOpen = this.onOpen.bind(this)

  boundOnClose = this.onClose.bind(this)

  boundOnStatus = this.onStatus.bind(this)

  forwardConnect = (e: any) => this.emit('connect', e)

  forwardOpen = (e: any) => this.emit('open', e)

  forwardClose = (e: any) => this.emit('close', e)

  forwardDisconnect = (e: any) => this.emit('disconnect', e)

  forwardDestroy = (e: any) => this.emit('destroy', e)

  public onStatus({ status } : onStatusParameters) {
    this.status = status

    this.configuration.onStatus({ status })
    this.emit('status', { status })
  }

  public setConfiguration(configuration: Partial<HocuspocusProviderConfiguration> = {}): void {
    if (!configuration.websocketProvider && (configuration as CompleteHocuspocusProviderWebsocketConfiguration).url) {
      // 如果configuration中未提供websocketProvider，但是提供了url，那么就创建一个websocketProvider
      const websocketProviderConfig = configuration as CompleteHocuspocusProviderWebsocketConfiguration

      this.configuration.websocketProvider = new HocuspocusProviderWebsocket({
        url: websocketProviderConfig.url,
        connect: websocketProviderConfig.connect,
        parameters: websocketProviderConfig.parameters,
      })
    }

    this.configuration = { ...this.configuration, ...configuration }
  }

  get document() {
    return this.configuration.document
  }

  get awareness() {
    return this.configuration.awareness
  }

  get hasUnsyncedChanges(): boolean {
    return this.unsyncedChanges > 0
  }

  incrementUnsyncedChanges() {
    this.unsyncedChanges += 1
    this.emit('unsyncedChanges', this.unsyncedChanges)
  }

  decrementUnsyncedChanges() {
    this.unsyncedChanges -= 1
    if (this.unsyncedChanges === 0) {
      this.synced = true
    }
    this.emit('unsyncedChanges', this.unsyncedChanges)
  }

  forceSync() {
    // forceSync()方法会发送SyncStep1消息
    this.send(SyncStepOneMessage, { document: this.document, documentName: this.configuration.name })
  }

  pageUnload() {
    if (this.awareness) {
      removeAwarenessStates(this.awareness, [this.document.clientID], 'window unload')
    }
  }

  registerEventListeners() {
    if (typeof window === 'undefined') {
      return
    }

    window.addEventListener('unload', this.boundPageUnload)
  }

  sendStateless(payload: string) {
    this.send(StatelessMessage, { documentName: this.configuration.name, payload })
  }

  documentUpdateHandler(update: Uint8Array, origin: any) {
    if (origin === this) {
      return
    }

    this.incrementUnsyncedChanges()
    // document发生变化时, 会发送Update消息给服务端
    // update是什么？ 
    // See https://docs.yjs.dev/api/document-updates
    this.send(UpdateMessage, { update, documentName: this.configuration.name }, true)
  }

  awarenessUpdateHandler({ added, updated, removed }: any, origin: any) {
    const changedClients = added.concat(updated).concat(removed)

    this.send(AwarenessMessage, {
      awareness: this.awareness,
      clients: changedClients,
      documentName: this.configuration.name,
    }, true)
  }

  /**
   * Indicates whether a first handshake with the server has been established
   *
   * Note: this does not mean all updates from the client have been persisted to the backend. For this,
   * use `hasUnsyncedChanges`.
   */
  get synced(): boolean {
    return this.isSynced
  }

  set synced(state) {
    // 接收到服务端的SyncStep2消息后，会设置synced为true
    if (this.isSynced === state) {
      return
    }

    this.isSynced = state
    this.emit('synced', { state })
    this.emit('sync', { state })
  }

  receiveStateless(payload: string) {
    this.emit('stateless', { payload })
  }

  get isAuthenticationRequired(): boolean {
    // 如果token有值，并且isAuthenticated为false，那么就需要进行authentication
    return !!this.configuration.token && !this.isAuthenticated
  }

  // not needed, but provides backward compatibility with e.g. lexicla/yjs
  async connect() {
    if (this.configuration.broadcast) {
      this.subscribeToBroadcastChannel()
    }

    // 创建WebSocket对象，创建WebSocket连接
    // 接收到WebSocket的message事件后，connect()函数会返回
    return this.configuration.websocketProvider.connect()
  }

  disconnect() {
    this.disconnectBroadcastChannel()
    this.configuration.websocketProvider.detach(this)
    this.isConnected = false

    if (!this.configuration.preserveConnection) {
      this.configuration.websocketProvider.disconnect()
    }

  }

  async onOpen(event: Event) {
    // 此时已经接收到WebSocket的open消息
    this.isAuthenticated = false
    this.isConnected = true

    this.emit('open', { event })

    // 这里从configuration中获取token，如果获取token时抛出异常，会调用permissionDeniedHandler()触发authenticationFailed事件
    let token: string | null
    try {
      token = await this.getToken()
    } catch (error) {
      this.permissionDeniedHandler(`Failed to get token: ${error}`)
      return
    }

    if (this.isAuthenticationRequired) {
      this.send(AuthenticationMessage, {
        token,
        documentName: this.configuration.name,
      })
    }

    this.startSync()
  }

  async getToken() {
    if (typeof this.configuration.token === 'function') {
      const token = await this.configuration.token()
      return token
    }

    return this.configuration.token
  }

  startSync() {
    this.incrementUnsyncedChanges()
    // 发送SyncStep1消息
    // 什么时候调用startSync()函数发送SyncStep1消息？
    // 有2个情况:
    //// 情况1，是在接收到WebSocket的open事件时
    //// 情况2，是在接收到服务端返回的authentication响应时
    this.send(SyncStepOneMessage, { document: this.document, documentName: this.configuration.name })

    if (this.awareness && this.awareness.getLocalState() !== null) {
      this.send(AwarenessMessage, {
        awareness: this.awareness,
        clients: [this.document.clientID],
        documentName: this.configuration.name,
      })
    }
  }

  // 发送和接收WebSocket消息，封装进了MessageSender和MessageReceiver
  send(message: ConstructableOutgoingMessage, args: any, broadcast = false) {
    if (!this.isConnected) {
      return
    }

    if (broadcast) {
      this.mux(() => { this.broadcast(message, args) })
    }

    const messageSender = new MessageSender(message, args)

    this.emit('outgoingMessage', { message: messageSender.message })
    messageSender.send(this.configuration.websocketProvider)
  }

  onMessage(event: MessageEvent) {
    const message = new IncomingMessage(event.data)

    const documentName = message.readVarString()

    message.writeVarString(documentName)

    this.emit('message', { event, message: new IncomingMessage(event.data) })

    new MessageReceiver(message).apply(this, true)
  }

  onClose(event: CloseEvent) {
    this.isAuthenticated = false
    this.synced = false

    // update awareness (all users except local left)
    if (this.awareness) {
      removeAwarenessStates(
        this.awareness,
        Array.from(this.awareness.getStates().keys()).filter(client => client !== this.document.clientID),
        this,
      )
    }
  }

  destroy() {
    this.emit('destroy')

    if (this.intervals.forceSync) {
      clearInterval(this.intervals.forceSync)
    }

    if (this.awareness) {
      removeAwarenessStates(this.awareness, [this.document.clientID], 'provider destroy')
    }

    this.awareness?.off('update', this.awarenessUpdateHandler)
    this.document.off('update', this.documentUpdateHandler)

    this.removeAllListeners()

    this.configuration.websocketProvider.off('connect', this.configuration.onConnect)
    this.configuration.websocketProvider.off('connect', this.forwardConnect)
    this.configuration.websocketProvider.off('open', this.boundOnOpen)
    this.configuration.websocketProvider.off('open', this.forwardOpen)
    this.configuration.websocketProvider.off('close', this.boundOnClose)
    this.configuration.websocketProvider.off('close', this.configuration.onClose)
    this.configuration.websocketProvider.off('close', this.forwardClose)
    this.configuration.websocketProvider.off('status', this.boundOnStatus)
    this.configuration.websocketProvider.off('disconnect', this.configuration.onDisconnect)
    this.configuration.websocketProvider.off('disconnect', this.forwardDisconnect)
    this.configuration.websocketProvider.off('destroy', this.configuration.onDestroy)
    this.configuration.websocketProvider.off('destroy', this.forwardDestroy)

    this.send(CloseMessage, { documentName: this.configuration.name })
    this.disconnect()

    if (typeof window === 'undefined') {
      return
    }

    window.removeEventListener('unload', this.boundPageUnload)
  }

  permissionDeniedHandler(reason: string) {
    this.emit('authenticationFailed', { reason })
    this.isAuthenticated = false
    this.disconnect()
    this.status = WebSocketStatus.Disconnected
  }

  authenticatedHandler(scope: string) {
    this.isAuthenticated = true
    this.authorizedScope = scope

    this.emit('authenticated')
    this.startSync()
  }

  get broadcastChannel() {
    return `${this.configuration.name}`
  }

  broadcastChannelSubscriber(data: ArrayBuffer) {
    this.mux(() => {
      const message = new IncomingMessage(data)

      const documentName = message.readVarString()

      message.writeVarString(documentName)

      new MessageReceiver(message)
        .setBroadcasted(true)
        .apply(this, false)
    })
  }

  subscribeToBroadcastChannel() {
    if (!this.subscribedToBroadcastChannel) {
      bc.subscribe(this.broadcastChannel, this.boundBroadcastChannelSubscriber)
      this.subscribedToBroadcastChannel = true
    }

    this.mux(() => {
      this.broadcast(SyncStepOneMessage, { document: this.document, documentName: this.configuration.name })
      this.broadcast(SyncStepTwoMessage, { document: this.document, documentName: this.configuration.name })
      this.broadcast(QueryAwarenessMessage, { document: this.document, documentName: this.configuration.name })
      if (this.awareness) {
        this.broadcast(AwarenessMessage, {
          awareness: this.awareness,
          clients: [this.document.clientID],
          document: this.document,
          documentName: this.configuration.name,
        })
      }
    })
  }

  disconnectBroadcastChannel() {
    // broadcast message with local awareness state set to null (indicating disconnect)
    if (this.awareness) {
      this.send(AwarenessMessage, {
        awareness: this.awareness,
        clients: [this.document.clientID],
        states: new Map(),
        documentName: this.configuration.name,
      }, true)
    }

    if (this.subscribedToBroadcastChannel) {
      bc.unsubscribe(this.broadcastChannel, this.boundBroadcastChannelSubscriber)
      this.subscribedToBroadcastChannel = false
    }
  }

  broadcast(Message: ConstructableOutgoingMessage, args?: any) {
    if (!this.configuration.broadcast) {
      return
    }

    if (!this.subscribedToBroadcastChannel) {
      return
    }

    new MessageSender(Message, args).broadcast(this.broadcastChannel)
  }

  setAwarenessField(key: string, value: any) {
    if (!this.awareness) {
      throw new AwarenessError(`Cannot set awareness field "${key}" to ${JSON.stringify(value)}. You have disabled Awareness for this provider by explicitly passing awareness: null in the provider configuration.`)
    }
    this.awareness.setLocalStateField(key, value)
  }
}

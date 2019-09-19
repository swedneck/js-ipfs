'use strict'

const callbackify = require('callbackify')

module.exports = function pubsub (self) {
  return {
    subscribe: callbackify.variadic((topic, handler, options = {}) => {
      return self.libp2p.pubsub.subscribe(topic, handler, options)
    }),

    unsubscribe: callbackify((topic, handler) => {
      return self.libp2p.pubsub.unsubscribe(topic, handler)
    }),

    publish: callbackify((topic, data) => {
      self.libp2p.pubsub.publish(topic, data)
    }),

    ls: callbackify(() => {
      return self.libp2p.pubsub.ls()
    }),

    peers: callbackify((topic) => {
      return self.libp2p.pubsub.peers(topic)
    }),

    setMaxListeners (n) {
      self.libp2p.pubsub.setMaxListeners(n)
    }
  }
}

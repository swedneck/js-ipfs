'use strict'

// See https://github.com/ipfs/specs/tree/master/keystore

const callbackify = require('callbackify')

module.exports = function key (self) {
  return {
    gen: callbackify.variadic((name, opts = {}) => {
      return self._keychain.createKey(name, opts.type, opts.size)
    }),

    info: callbackify((name) => {
      return self._keychain.findKeyByName(name)
    }),

    list: callbackify(() => {
      return self._keychain.listKeys()
    }),

    rm: callbackify((name) => {
      return self._keychain.removeKey(name)
    }),

    rename: callbackify(async (oldName, newName) => {
      const key = await self._keychain.renameKey(oldName, newName)

      return {
        was: oldName,
        now: key.name,
        id: key.id,
        overwrite: false
      }
    }),

    import: callbackify((name, pem, password) => {
      return self._keychain.importKey(name, pem, password)
    }),

    export: callbackify((name, password) => {
      return self._keychain.exportKey(name, password)
    })
  }
}

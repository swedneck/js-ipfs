'use strict'

const callbackify = require('callbackify')

module.exports = (self) => {
  return callbackify(async () => {
    self.log('stop')

    if (self.state.state() === 'stopped') {
      throw new Error('Already stopped')
    }

    if (self.state.state() !== 'running') {
      throw new Error('Not able to stop from state: ' + self.state.state())
    }

    self.state.stop()
    self._blockService.unsetExchange()
    self._bitswap.stop()
    self._preload.stop()

    const libp2p = self.libp2p
    self.libp2p = null

    try {
      return Promise.all([
        self._ipns.republisher.stop(),
        self._mfsPreload.stop(),
        libp2p.stop()
      ])
    } catch (err) {
      let closeErr
      try {
        await self._repo.close()
      } catch (closeErr2) {
        closeErr = closeErr2
      }
      if (err || closeErr) {
        self.emit('error', err || closeErr)
        throw err || closeErr
      }
      self.emit('error', err)
      self.state.stopped()
      self.emit('stop')
    }
  })
}

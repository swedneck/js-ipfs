'use strict'

const multihashes = require('multihashes')
const CID = require('cids')
const protobuf = require('protons')
const fnv1a = require('fnv1a')
const varint = require('varint')
const { DAGNode, DAGLink } = require('ipld-dag-pb')
const multicodec = require('multicodec')
const Queue = require('p-queue')

const pbSchema = require('./pin.proto')

const emptyKeyHash = 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n'
const emptyKey = multihashes.fromB58String(emptyKeyHash)
const defaultFanout = 256
const maxItems = 8192
const pb = protobuf(pbSchema)

const HAS_DESCENDANT_CONCURRENCY = 100

function toB58String (hash) {
  return new CID(hash).toBaseEncodedString()
}

function readHeader (rootNode) {
  // rootNode.data should be a buffer of the format:
  // < varint(headerLength) | header | itemData... >
  const rootData = rootNode.Data
  const hdrLength = varint.decode(rootData)
  const vBytes = varint.decode.bytes

  if (vBytes <= 0) {
    throw new Error('Invalid Set header length')
  }

  if (vBytes + hdrLength > rootData.length) {
    throw new Error('Impossibly large set header length')
  }

  const hdrSlice = rootData.slice(vBytes, hdrLength + vBytes)
  const header = pb.Set.decode(hdrSlice)

  if (header.version !== 1) {
    throw new Error(`Unsupported Set version: ${header.version}`)
  }

  if (header.fanout > rootNode.Links.length) {
    throw new Error('Impossibly large fanout')
  }

  return {
    header: header,
    data: rootData.slice(hdrLength + vBytes)
  }
}

function hash (seed, key) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(seed, 0)
  const data = Buffer.concat([
    buf, Buffer.from(toB58String(key))
  ])
  return fnv1a(data.toString('binary'))
}

exports = module.exports = function (dag) {
  const pinSet = {
    // should this be part of `object` API?
    hasDescendant: async (root, childhash) => {
      const seen = {}
      let result = false
      const queue = new Queue({
        concurrency: HAS_DESCENDANT_CONCURRENCY
      })

      if (CID.isCID(childhash) || Buffer.isBuffer(childhash)) {
        childhash = toB58String(childhash)
      }

      function searchChildren (node) {
        for (const link in node.Links) {
          const cid = link.Hash
          const bs58Link = toB58String(cid)

          if (bs58Link === childhash) {
            result = true
            queue.clear()
            return
          }

          if (bs58Link in seen) {
            result = false
            queue.clear()
            return
          }

          seen[bs58Link] = true

          queue.add(async () => {
            const res = await dag.get(cid, '', { preload: false })

            queue.add(searchChildren(res.value))
          })
        }
      }

      searchChildren(root)

      await queue.onIdle()

      return result
    },

    storeSet: async (keys) => {
      const pins = keys.map(key => {
        if (typeof key === 'string' || Buffer.isBuffer(key)) {
          key = new CID(key)
        }

        return {
          key: key,
          data: null
        }
      })

      const rootNode = await pinSet.storeItems(pins)
      const cid = await dag.put(rootNode, {
        version: 0,
        format: multicodec.DAG_PB,
        hashAlg: multicodec.SHA2_256,
        preload: false
      })

      return {
        node: rootNode,
        cid
      }
    },

    storeItems: async (items) => { // eslint-disable-line require-await
      return storePins(items, 0)

      async function storePins (pins, depth) {
        const pbHeader = pb.Set.encode({
          version: 1,
          fanout: defaultFanout,
          seed: depth
        })
        const headerBuf = Buffer.concat([
          Buffer.from(varint.encode(pbHeader.length)), pbHeader
        ])
        const fanoutLinks = []

        for (let i = 0; i < defaultFanout; i++) {
          fanoutLinks.push(new DAGLink('', 1, emptyKey))
        }

        if (pins.length <= maxItems) {
          const nodes = pins
            .map(item => {
              return ({
                link: new DAGLink('', 1, item.key),
                data: item.data || Buffer.alloc(0)
              })
            })
            // sorting makes any ordering of `pins` produce the same DAGNode
            .sort((a, b) => Buffer.compare(a.link.Hash.buffer, b.link.Hash.buffer))

          const rootLinks = fanoutLinks.concat(nodes.map(item => item.link))
          const rootData = Buffer.concat(
            [headerBuf].concat(nodes.map(item => item.data))
          )

          return new DAGNode(rootData, rootLinks)
        } else {
          // If the array of pins is > maxItems, we:
          //  - distribute the pins among `defaultFanout` bins
          //    - create a DAGNode for each bin
          //      - add each pin as a DAGLink to that bin
          //  - create a root DAGNode
          //    - add each bin as a DAGLink
          //  - send that root DAGNode via callback
          // (using go-ipfs' "wasteful but simple" approach for consistency)
          // https://github.com/ipfs/go-ipfs/blob/master/pin/set.go#L57

          const bins = pins.reduce((bins, pin) => {
            const n = hash(depth, pin.key) % defaultFanout
            bins[n] = n in bins ? bins[n].concat([pin]) : [pin]
            return bins
          }, {})

          let idx = 0
          for (const bin of bins) {
            const child = await storePins(bin, depth + 1)

            await storeChild(child, idx)

            idx++
          }

          return new DAGNode(headerBuf, fanoutLinks)
        }

        async function storeChild (child, binIdx) {
          const opts = {
            version: 0,
            format: multicodec.DAG_PB,
            hashAlg: multicodec.SHA2_256,
            preload: false
          }

          const cid = await dag.put(child, opts)

          fanoutLinks[binIdx] = new DAGLink('', child.size, cid)
        }
      }
    },

    loadSet: async (rootNode, name) => {
      const link = rootNode.Links.find(l => l.Name === name)

      if (!link) {
        throw new Error('No link found with name ' + name)
      }

      const res = await dag.get(link.Hash, '', { preload: false })
      const keys = []
      const stepPin = link => keys.push(link.Hash)

      await pinSet.walkItems(res.value, { stepPin })

      return keys
    },

    walkItems: async (node, { stepPin = () => {}, stepBin = () => {} }) => {
      const pbh = readHeader(node)
      let idx = 0

      for (const link of node.Links) {
        if (idx < pbh.header.fanout) {
          // the first pbh.header.fanout links are fanout bins
          // if a fanout bin is not 'empty', dig into and walk its DAGLinks
          const linkHash = link.Hash.buffer

          if (!emptyKey.equals(linkHash)) {
            stepBin(link, idx, pbh.data)

            // walk the links of this fanout bin
            const res = await dag.get(linkHash, '', { preload: false })

            await pinSet.walkItems(res.value, { stepPin, stepBin })
          }
        } else {
          // otherwise, the link is a pin
          stepPin(link, idx, pbh.data)
        }

        idx++
      }
    },

    getInternalCids: async (rootNode) => {
      // "Empty block" used by the pinner
      const cids = [new CID(emptyKey)]
      const stepBin = link => cids.push(link.Hash)

      for (const topLevelLink of rootNode.Links) {
        cids.push(topLevelLink.Hash)

        const res = await dag.get(topLevelLink.Hash, '', { preload: false })

        await pinSet.walkItems(res.value, { stepBin })
      }

      return cids
    }
  }

  return pinSet
}

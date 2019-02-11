'use strict'
const net = require('net')
const co = require('co')
const expect = require('expect.js')

const describe = require('mocha').describe
const it = require('mocha').it

const Pool = require('../')

describe('pool error handling', function () {
  it('Should complete these queries without dying', function (done) {
    const pool = new Pool()
    let errors = 0
    let shouldGet = 0
    function runErrorQuery () {
      shouldGet++
      return new Promise(function (resolve, reject) {
        pool.query("SELECT 'asd'+1 ").then(function (res) {
          reject(res) // this should always error
        }).catch(function (err) {
          errors++
          resolve(err)
        })
      })
    }
    const ps = []
    for (let i = 0; i < 5; i++) {
      ps.push(runErrorQuery())
    }
    Promise.all(ps).then(function () {
      expect(shouldGet).to.eql(errors)
      pool.end(done)
    })
  })

  describe('calling release more than once', () => {
    it('should throw each time', co.wrap(function * () {
      const pool = new Pool()
      const client = yield pool.connect()
      client.release()
      expect(() => client.release()).to.throwError()
      expect(() => client.release()).to.throwError()
      return yield pool.end()
    }))
  })

  describe('calling connect after end', () => {
    it('should return an error', function * () {
      const pool = new Pool()
      const res = yield pool.query('SELECT $1::text as name', ['hi'])
      expect(res.rows[0].name).to.equal('hi')
      const wait = pool.end()
      pool.query('select now()')
      yield wait
      expect(() => pool.query('select now()')).to.reject()
    })
  })

  describe('using an ended pool', () => {
    it('rejects all additional promises', (done) => {
      const pool = new Pool()
      const promises = []
      pool.end()
        .then(() => {
          const squash = promise => promise.catch(e => 'okay!')
          promises.push(squash(pool.connect()))
          promises.push(squash(pool.query('SELECT NOW()')))
          promises.push(squash(pool.end()))
          Promise.all(promises).then(res => {
            expect(res).to.eql(['okay!', 'okay!', 'okay!'])
            done()
          })
        })
    })

    it('returns an error on all additional callbacks', (done) => {
      const pool = new Pool()
      pool.end(() => {
        pool.query('SELECT *', (err) => {
          expect(err).to.be.an(Error)
          pool.connect((err) => {
            expect(err).to.be.an(Error)
            pool.end((err) => {
              expect(err).to.be.an(Error)
              done()
            })
          })
        })
      })
    })
  })

  describe('error from idle client', () => {
    it('removes client from pool', co.wrap(function * () {
      const pool = new Pool()
      const client = yield pool.connect()
      expect(pool.totalCount).to.equal(1)
      expect(pool.waitingCount).to.equal(0)
      expect(pool.idleCount).to.equal(0)
      client.release()
      yield new Promise((resolve, reject) => {
        process.nextTick(() => {
          pool.once('error', (err) => {
            expect(err.message).to.equal('expected')
            expect(pool.idleCount).to.equal(0)
            expect(pool.totalCount).to.equal(0)
            pool.end().then(resolve, reject)
          })
          client.emit('error', new Error('expected'))
        })
      })
    }))
  })

  describe('passing a function to pool.query', () => {
    it('calls back with error', (done) => {
      const pool = new Pool()
      console.log('passing fn to query')
      pool.query((err) => {
        expect(err).to.be.an(Error)
        pool.end(done)
      })
    })
  })

  describe('releasing a not queryable client', () => {
    it('removes the client from the pool', (done) => {
      const pool = new Pool({ max: 1 })
      const connectionError = new Error('connection failed')

      pool.once('error', () => {
        // Ignore error on pool
      })

      pool.connect((err, client) => {
        expect(err).to.be(undefined)

        client.once('error', (err) => {
          expect(err).to.eql(connectionError)

          // Releasing the client should remove it from the pool,
          // whether called with an error or not
          client.release()

          // Verify that the pool is still usuable and new client has been
          // created
          pool.query('SELECT $1::text as name', ['brianc'], (err, res) => {
            expect(err).to.be(undefined)
            expect(res.rows).to.eql([{ name: 'brianc' }])

            pool.end(done)
          })
        })

        client.emit('error', connectionError)
      })
    })
  })

  describe('pool with lots of errors', () => {
    it('continues to work and provide new clients', co.wrap(function * () {
      const pool = new Pool({ max: 1 })
      const errors = []
      for (var i = 0; i < 20; i++) {
        try {
          yield pool.query('invalid sql')
        } catch (err) {
          errors.push(err)
        }
      }
      expect(errors).to.have.length(20)
      expect(pool.idleCount).to.equal(0)
      expect(pool.query).to.be.a(Function)
      const res = yield pool.query('SELECT $1::text as name', ['brianc'])
      expect(res.rows).to.have.length(1)
      expect(res.rows[0].name).to.equal('brianc')
      return pool.end()
    }))
  })

  it('should continue with queued items after a connection failure', (done) => {
    const closeServer = net.createServer((socket) => {
      socket.destroy()
    }).unref()

    closeServer.listen(() => {
      const pool = new Pool({ max: 1, port: closeServer.address().port })
      pool.connect((err) => {
        expect(err).to.be.an(Error)
        if (err.errno) {
          expect(err.errno).to.be('ECONNRESET')
        }
      })
      pool.connect((err) => {
        expect(err).to.be.an(Error)
        if (err.errno) {
          expect(err.errno).to.be('ECONNRESET')
        }
        closeServer.close(() => {
          pool.end(done)
        })
      })
    })
  })
})

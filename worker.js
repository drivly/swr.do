export const api = {
  icon: '🚀',
  name: 'templates.do',
  description: 'Cloudflare Worker Template',
  url: 'https://templates.do/api',
  type: 'https://apis.do/templates',
  endpoints: {
    listCategories: 'https://templates.do/api',
    getCategory: 'https://templates.do/:type',
  },
  site: 'https://templates.do',
  login: 'https://templates.do/login',
  signup: 'https://templates.do/signup',
  subscribe: 'https://templates.do/subscribe',
  repo: 'https://github.com/drivly/templates.do',
}

export const gettingStarted = [
  `If you don't already have a JSON Viewer Browser Extension, get that first:`,
  `https://extensions.do`,
]

export const examples = {
  listItems: 'https://templates.do/worker',
}

const parse_timespan = timespan => {
  const units = {
    y: 31536000000,
    M: 2592000000,
    w: 604800000,
    d: 86400000,
    h: 3600000,
    m: 60000,
    s: 1000,
  }

  // Check if theres no letter in the timespan, if so, assume its in seconds
  if (!timespan.match(/[a-zA-Z]/)) {
    return parseInt(timespan) * 1000
  }

  const matches = timespan.match(/(\d+)([yMwdhms])/g)

  let ms = 0

  for (const match of matches) {
    const [ , amount, unit ] = match.match(/(\d+)([yMwdhms])/)
    ms += amount * units[unit]
  }

  console.log(
    timespan,
    ms
  )

  return ms
}

export default {
  fetch: async (req, env, ctx) => {
    const { user, hostname, pathname, rootPath, pathSegments, query } = await env.CTX.fetch(req).then(res => res.json())
    if (rootPath) return json({ api, gettingStarted, examples, user })

    const [ timespan, ...url ] = pathSegments
    let engine = hostname.split('.')[0] || 'cache'

    if (!url.length) {
      return json({ api, data: { success: false, error: 'You must include a timespan for us to store your response. Please use either seconds or abriviated formats (60, or, 1m)' }, user }, { status: 400 })
    }

    const kvCacheEngine = {
      async put(key, resp) {
        // We need to split the resp into two keys, one for the headers, and one for the body.
        // This is because the KV API only allows strings to be stored, and we need to store the headers as an object

        const headers = Object.fromEntries(resp.headers.entries())
        const body = await resp.arrayBuffer()

        // Read the cache control header, and if its set to no-store, dont cache it
        if (headers['cache-control'] && headers['cache-control'].includes('no-store')) {
          return false
        }

        console.log(
          headers['cache-control']
        )

        const ttl = headers['cache-control'] && headers['cache-control'].includes('max-age') ? headers['cache-control'].split('max-age=')[1].split(',')[0] : 0

        await env.STORAGE.put(
          `${key}-headers`,
          JSON.stringify(headers),
          {
            expirationTtl: ttl ? parseInt(ttl) : undefined,
          }
        )

        await env.STORAGE.put(
          `${key}-body`,
          body,
          {
            expirationTtl: ttl ? parseInt(ttl) : undefined,
          }
        )

        return true
      },
      async match(key) {
        const headers = await env.STORAGE.get(`${key}-headers`)
        const body = await env.STORAGE.get(`${key}-body`)

        if (!headers || !body) return false

        return new Response(body, {
          headers: new Headers(JSON.parse(headers)),
        })
      }
    }

    const cache = {
      kv: kvCacheEngine,
      cache: caches.default,
    }[engine]

    const cache_key = `https://${url.join('/')}?ttl=${timespan}`

    if (timespan === 'purge') {
      await cache.delete(cache_key)
      return json({ api, data: { success: true, message: 'Cache purged' }, user })
    }

    let expire_ms
    let stale_ms = 600_000 // 10 minutes

    try {
      if (timespan.includes('-')) {
        // We have both a expiry and a stale time
        const [ expire, stale ] = timespan.split(',')[0].split('-')
        expire_ms = parse_timespan(expire)
        stale_ms = parse_timespan(stale)
      } else {
        expire_ms = parse_timespan(timespan.split(',')[0])
      }
    } catch (e) {
      return json({ api, data: { success: false, error: 'Invalid timespan. Please use either seconds or abriviated formats (60, or, 1m)' }, user }, { status: 400 })
    }


    if (timespan.includes(',')) {
      // We have a custom engine
      engine = timespan.split(',')[1]
    }

    if (!['kv', 'cache'].includes(engine)) {
      return json({ api, data: { success: false, error: `Storage engine "${engine}" is not supported, please use either "kv" or "cache" (default)` }, user }, { status: 400 })
    }

    const cache_start = new Date()
    const cache_resp = await cache.match(cache_key)

    if (!cache_resp) {
      // Our cache is empty, so we need to fetch the data, return to user, and cache it
      const fetch_start = new Date()
      const fetch_resp = await fetch(`https://${url.join('/')}`)
    
      // For some reason, I cant get native async functions to work.
      // So im just gonna use the old style Promise API
      ctx.waitUntil(new Promise(async resolve => {
        const res = fetch_resp.clone()
        
        const r = new Response(res.body, res)

        r.headers.set('X-CACHE-DT', new Date().toISOString())
        r.headers.set('X-CACHE-TTL', expire_ms)
        r.headers.set(
          'Cache-Control',
          `public, max-age=${parseInt(expire_ms / 1000) + parseInt(stale_ms / 1000)}`
        )
        
        // Set-Cookie headers are not allowed in the cache
        r.headers.delete('Set-Cookie')

        await cache.put(cache_key, r.clone())
        await new Promise(resolve => setTimeout(resolve, 2000))
        resolve()
      }))

      const r = new Response(fetch_resp.body, fetch_resp)
      r.headers.set('X-CACHE', 'MISS')
      r.headers.set('X-CACHE-EXPIRES', new Date(new Date().getTime() + expire_ms).toISOString())
      r.headers.set('X-READ-MS', new Date() - fetch_start)

      return r
    }

    // We have a cached response, so we need to check if it's expired
    const cache_dt = new Date(cache_resp.headers.get('X-CACHE-DT'))

    const r = new Response(cache_resp.body, cache_resp)
    r.headers.set('X-CACHE', 'HIT')
    r.headers.set('X-CACHE-EXPIRES', new Date(cache_dt.getTime() + expire_ms).toISOString())

    // Seconds left until eviction
    r.headers.set('X-CACHE-TTL', (cache_dt.getTime() + expire_ms - new Date().getTime()) / 1000)

    r.headers.set('X-READ-MS', new Date() - cache_start)

    if (cache_dt.getTime() + expire_ms < new Date().getTime()) {
      // We need to implement a stale-while-revalidate strategy
      // So we return the cached response, and then fetch the new one

      ctx.waitUntil(new Promise(async resolve => {
        const fetch_resp = await fetch(`https://${url.join('/')}`)
        const res = fetch_resp.clone()
        
        const r = new Response(res.body, res)
        r.headers.set('X-CACHE-DT', new Date().toISOString())
        r.headers.set('X-CACHE-TTL', expire_ms)
        r.headers.set(
          'Cache-Control',
          `public, max-age=${parseInt(expire_ms / 1000) + 60}`
        )
        
        // Set-Cookie headers are not allowed in the cache
        r.headers.delete('Set-Cookie')

        await cache.put(cache_key, r.clone())
        await new Promise(resolve => setTimeout(resolve, 2000))
        resolve()
      }))

      r.headers.set('X-CACHE', 'HIT; STALE')
    }
    
    return r
  }
}

const json = (obj, opt) => new Response(JSON.stringify(obj, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' }, ...opt })

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  // ✅ 使用你的Pages默认地址
  const targetBase = 'https://your-project.pages.dev'

  if (request.headers.get('Upgrade') === 'websocket') {
    return fetch(request)
  }

  const url = new URL(request.url)
  const newUrl = new URL(url.pathname + url.search, targetBase)
  
  const newHeaders = new Headers(request.headers)
  newHeaders.set('Host', newUrl.hostname)
  
  const newRequest = new Request(newUrl, {
    method: request.method,
    headers: newHeaders,
    body: request.body,
    redirect: 'manual'
  })

  const response = await fetch(newRequest)
  
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('Location')
    if (location && location.includes(targetBase)) {
      return Response.redirect(
        location.replace(targetBase, `https://${url.hostname}`),
        response.status
      )
    }
  }
  
  return response
}

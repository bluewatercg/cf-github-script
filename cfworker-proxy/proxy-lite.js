addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  // ✅ 使用你的真实项目地址
  const targetBase = 'https://p3000--moon--n5s5yfbl2y6k.code.run/'
  
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

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
   });

async function handleRequest(request) {
  const url = new URL(request.url);
  const newPath = `/file/此处替换为你的存储桶名称${url.pathname}`;
  const newUrl = new URL(newPath, url.origin);
  return fetch(newUrl, request);
}

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request));
});
const specialCases = {
  "*": {
    Origin: "DELETE",
    Referer: "DELETE",
  },
};
function handleSpecialCases(request) {
  const url = new URL(request.url);
  const rules = specialCases[url.hostname] || specialCases["*"];
  for (const [key, value] of Object.entries(rules)) {
    switch (value) {
      case "KEEP":
        break;
      case "DELETE":
        request.headers.delete(key);
        break;
      default:
        request.headers.set(key, value);
        break;
    }
  }
}
async function handleRequest(request) {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    return new Response(
      `<!DOCTYPE html>
<html lang="zh-CN">

<head>
  <meta charset="UTF-8">
  <title>转发服务使用指南</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 0;
      background: #f4f4f4;
    }

    .container {
      width: 80%;
      margin: auto;
      overflow: hidden;
    }

    header {
      background: #333;
      color: #fff;
      padding: 20px;
      text-align: center;
    }

    section {
      padding: 20px;
      margin-bottom: 20px;
    }

    .example {
      background: #fff;
      padding: 20px;
      border-radius: 4px;
    }

    h2 {
      color: #333;
    }

    code {
      background: #ddd;
      padding: 2px 6px;
      border-radius: 4px;
      display: inline-block;
      margin: 0 5px;
    }
  </style>
</head>

<body>
  <header>
    <h1>转发服务使用指南</h1>
  </header>
  <div class="container">
    <section>
      <h2>简介</h2>
      <p>本服务是一个轻量级的https请求转发代理，可以帮助您绕过某些网络限制，或者在开发过程中模拟https请求。该转发接口基于Cloudflare构建，以提供快速且安全的服务体验。</p>
    </section>
    <section>
      <h2>服务域名</h2>
      <p>我们提供了多个转发服务域名，您可以根据需要选择合适的服务域名：</p>
      <ul>
        <li><strong>通用转发服务：</strong><code>https://lius.me</code></li>
        <li><strong>Gravatar 转发服务：</strong><code>https://gravatar.lius.me</code></li>
        <li><strong>GitHub 转发服务：</strong><code>https://github.lius.me</code></li>
      </ul>
    </section>
    <section>
      <h2>如何使用</h2>
      <p>使用转发服务非常简单，只需遵循以下步骤：</p>
      <ol>
        <li>确定您想要访问的目标URL。</li>
        <li>根据您的需求选择相应的转发服务域名。</li>
        <li>在浏览器地址栏输入我们的转发服务URL，并在其后附加目标URL的完整路径。</li>
        <li>按下回车键，我们的服务将自动将请求转发到目标URL。</li>
      </ol>
    </section>
    <section>
      <h2>特定域名转发接口</h2>
      <p>我们为一些常用的服务提供了专门的转发接口，以优化访问速度和体验。</p>
      <section class="example">
        <h3>Gravatar 转发</h3>
        <p>如果您需要访问Gravatar的头像服务，可以使用以下转发接口：</p>
        <p><strong>转发服务域名：</strong><code>https://gravatar.lius.me</code></p>
        <p><strong>示例：</strong>要获取用户<code>someuser</code>的Gravatar头像，访问以下URL：</p>
        <p><code>https://gravatar.lius.me/avatar/someuser?s=128</code></p>
      </section>
      <section class="example">
        <h3>GitHub 转发</h3>
        <p>如果您需要访问GitHub的API或资源，可以使用以下转发接口：</p>
        <p><strong>转发服务域名：</strong><code>https://github.lius.me</code></p>
        <p><strong>示例：</strong>要访问用户<code>someuser</code>的GitHub仓库<code>repo</code>，请访问：</p>
        <p><code>https://github.lius.me/users/someuser/repos/repo</code></p>
      </section>
    </section>
    <section>
      <h2>通用转发服务</h2>
      <p>对于不提供专门转发接口的网站，您可以继续使用我们的通用转发服务。</p>
      <section class="example">
        <h3>通用转发示例</h3>
        <p><strong>转发服务域名：</strong><code>https://lius.me</code></p>
        <p><strong>示例：</strong>要访问<code>https://example.com/api/data</code>，请使用以下URL：</p>
        <p><code>https://lius.me/https://example.com/api/data</code></p>
      </section>
    </section>
    <section>
      <h2>注意事项</h2>
      <p>在使用转发服务时，请仔细阅读并遵守以下条款：</p>
      <h3>遵守使用条款</h3>
      <p>您必须遵守目标网站的使用条款和条件。本服务仅作为请求转发的中介，并不对目标网站的内容或服务负责。</p>
      <h3>隐私和数据安全</h3>
      <p>保护您的个人隐私和数据安全至关重要。请不要通过本服务发送任何敏感或个人身份信息，除非您已经确认目标网站具有足够的安全措施。</p>
      <h3>版权和知识产权</h3>
      <p>您应确保在使用本服务转发内容时，不侵犯任何第三方的版权或知识产权。对于因违反版权或知识产权法律而导致的任何争议或法律责任，您应自行承担。</p>
      <h3>服务限制</h3>
      <p>本服务有可能会限制请求的数量、频率或大小。请合理使用服务，避免对服务或目标网站造成不必要的负担。</p>
      <h3>免责声明</h3>
      <p>本服务提供“按原样”的转发服务，不提供任何形式的保证。我们不对通过本服务转发的内容的准确性、可靠性或质量负责，也不对因使用本服务而可能遭受的任何损失或损害承担责任。</p>
      <h3>服务变更和中断</h3>
      <p>我们保留随时修改、更新或中断服务的权利，无需事先通知。我们不承担因服务变更或中断而造成的任何责任。</p>
      <h3>用户行为</h3>
      <p>您应确保在使用服务时遵守所有适用的法律和规定，不进行任何非法活动或恶意行为，包括但不限于网络攻击、数据爬取或任何形式的网络欺诈。</p>
    </section>
    <section>
      <h2>免责声明</h2>
      <p><strong>免责声明：</strong></p>
      <p>· 使用本转发服务时，您应自行承担风险。我们不保证服务的及时性、安全性、可用性或准确性。对于因使用或无法使用本服务而造成的任何直接、间接、特殊或后果性损害，我们不承担任何责任。</p>
      <p>· 我们不对通过本服务转发的内容承担责任，包括但不限于版权、商标或其他知识产权问题。您应确保您有权转发目标URL的内容，并且遵守所有适用的法律和规定。</p>
      <p>· 我们保留随时修改或中断服务的权利，无需事先通知。本服务不提供任何形式的保证或条件，无论是明示的还是暗示的。</p>
      <p>· 该服务不收取任何费用，使用开源代码创建，如果本服务侵犯了任何您的权利以及现有条款，我们将立刻关闭该服务。</p>
    </section>
  </div>
</body>

</html>`,
      {
        headers: {
          "content-type": "text/html;charset=UTF-8",
        },
        status: 200, // 确保状态码是200
      }
    );
  }
  const actualUrlStr = url.pathname.replace("/", "") + url.search + url.hash;
  const actualUrl = new URL(actualUrlStr);
  const modifiedRequest = new Request(actualUrl, {
    headers: request.headers,
    method: request.method,
    body: request.body,
    redirect: "follow",
  });
  handleSpecialCases(modifiedRequest);
  const response = await fetch(modifiedRequest);
  const modifiedResponse = new Response(response.body, response);
  modifiedResponse.headers.set("Access-Control-Allow-Origin", "*");
  return modifiedResponse;
}

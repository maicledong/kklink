export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // 1. 触发抓取
  if (path === '/api/save' && request.method === 'POST') {
    try {
      const { url: targetUrl } = await request.json();
      const res = await fetch('https://karakeep.mcck.ccwu.cc/api/v1/bookmarks', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.KARAKEEP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: targetUrl, type: "link" })
      });
      
      if (!res.ok) throw new Error("Karakeep 拒绝请求，请检查 Token");
      const data = await res.json();
      
      return new Response(JSON.stringify({ success: true, bookmarkId: data.id }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 2. 轮询并写入 D1（通杀版）
  if (path === '/api/check-status' && request.method === 'GET') {
    try {
      const bookmarkId = url.searchParams.get('id');
      
      const res = await fetch(`https://karakeep.mcck.ccwu.cc/api/v1/bookmarks/${bookmarkId}`, {
        headers: { 'Authorization': `Bearer ${env.KARAKEEP_TOKEN}` }
      });
      const data = await res.json();

      if (!data.content || data.content.crawlStatus !== 'success') {
        return new Response(JSON.stringify({ status: 'processing' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      let title = data.content.title || "";
      let description = data.content.description || "";
      const originalUrl = data.content.url;
      const imageUrl = data.content.imageUrl || ""; 
      let imgFileId = ""; // ⭐ 改为 imgFileId

      // 微信视频号标题兜底
      if (originalUrl.includes("weixin.qq.com") && (title === "视频号" || title === "")) {
          title = `微信视频号收藏 - ${new Date().toLocaleDateString('zh-CN')}`;
          description = "微信视频号内容暂不支持自动提取文本，请点击查看原文。";
      }

      // 通杀转存 TG
      if (imageUrl) {
        try {
          // 替换为你真实的 Oracle 域名
          const proxyApi = `https://oracle.mcck.ccwu.cc/proxy-image?url=${encodeURIComponent(imageUrl)}`;
          const proxyRes = await fetch(proxyApi);
          
          if (proxyRes.ok) {
            const proxyData = await proxyRes.json();
            if (proxyData.success) {
              imgFileId = proxyData.file_id;
            }
          }
        } catch (e) {
          console.error("转存TG失败，仅使用外链兜底", e);
        }
      }

      // 写入 D1（⭐ 字段名改为 img_file_id）
      await env.DB.prepare(
        `INSERT OR REPLACE INTO bookmarks (url, title, description, image_url, img_file_id) VALUES (?, ?, ?, ?, ?)`
      ).bind(originalUrl, title, description, imageUrl, imgFileId).run();

      // 🔥 阅后即焚
      try {
        await fetch(`https://karakeep.mcck.ccwu.cc/api/v1/bookmarks/${bookmarkId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${env.KARAKEEP_TOKEN}` }
        });
      } catch (e) {
        console.error("删除 Karakeep 失败", e);
      }

      return new Response(JSON.stringify({ status: 'success' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 3. 读取列表
  if (path === '/api/list' && request.method === 'GET') {
    try {
      const { results } = await env.DB.prepare(`SELECT * FROM bookmarks ORDER BY created_at DESC`).all();
      return new Response(JSON.stringify({ success: true, data: results || [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders });
}

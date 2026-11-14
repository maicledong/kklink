export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // 1. 触发抓取
  if (path === '/api/save' && request.method === 'POST') {
    try {
      const { url: targetUrl } = await request.json();
      const res = await fetch('https://karakeep.mcck.ccwu.cc/api/v1/bookmarks', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.KARAKEEP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl, type: "link" })
      });
      if (!res.ok) throw new Error("Karakeep 拒绝请求");
      const data = await res.json();
      return new Response(JSON.stringify({ success: true, bookmarkId: data.id }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 2. 查询状态，并给出【最稳妥的本地图链接】
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
      const externalImageUrl = data.content.imageUrl || ""; 

      // 🎯 核心：取 Karakeep 本地的图片
      let localKarakeepImageUrl = "";
      if (data.content.imageAssetId) {
          localKarakeepImageUrl = `https://karakeep.mcck.ccwu.cc/api/assets/${data.content.imageAssetId}`;
      } else {
          localKarakeepImageUrl = externalImageUrl;
      }

      // 🌟 新增：微信视频号的专属处理逻辑
      if (originalUrl.includes("weixin.qq.com") || originalUrl.includes("channels.weixin.qq.com")) {
          // 1. 如果 Karakeep 成功提取了正文，就拿来当描述
          if (data.content.content && data.content.content.trim().length > 0) {
              description = data.content.content.trim();
          } 
          // 2. 如果正文也没有，再用你之前的兜底
          else if (title === "视频号" || title === "") {
              title = `微信视频号收藏 - ${new Date().toLocaleDateString('zh-CN')}`;
              description = "微信视频号内容暂不支持自动提取文本，请点击查看原文。";
          }
      }

      // 🌟 注意：YouTube 的 yt-dlp 拦截逻辑要放后面，或者用 else if
      else if (originalUrl.includes("youtube.com") || originalUrl.includes("youtu.be")) {
          try {
              const metaRes = await fetch(`https://oracle.mcck.ccwu.cc/yt-dlp-meta?url=${encodeURIComponent(originalUrl)}`);
              if (metaRes.ok) {
                  const meta = await metaRes.json();
                  if (meta.success && meta.description) {
                      description = meta.description; 
                  }
              }
          } catch (e) {
              console.error("yt-dlp 简介获取失败，回退使用 Karakeep 的原简介", e);
          }
      }

      return new Response(JSON.stringify({ 
          status: 'success', 
          data: { 
              url: originalUrl, 
              title, 
              description, // 这里返回的 description 已经是覆盖后的真实简介了
              imageUrl: externalImageUrl,       
              karakeepLocalImage: localKarakeepImageUrl 
          } 
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 3. 存入 D1
  if (path === '/api/store' && request.method === 'POST') {
    try {
      const { url: originalUrl, title, description, imageUrl, imgFileId } = await request.json();
      await env.DB.prepare(
        `INSERT OR REPLACE INTO bookmarks (url, title, description, image_url, img_file_id) VALUES (?, ?, ?, ?, ?)`
      ).bind(originalUrl, title, description, imageUrl, imgFileId).run();
      return new Response(JSON.stringify({ status: 'success' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 4. 读取列表
  if (path === '/api/list' && request.method === 'GET') {
    try {
      const { results } = await env.DB.prepare(`SELECT * FROM bookmarks ORDER BY created_at DESC`).all();
      return new Response(JSON.stringify({ success: true, data: results || [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders });
}

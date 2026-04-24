// ============================================================
// 安全辅助函数 (Fix 7: 提取响应构建辅助函数)
// ============================================================

/**
 * CORS 头构建 (Fix 4: 可配置 CORS 白名单)
 * 部署时将实际域名填入 ALLOWED_ORIGINS，如 'https://your-app.pages.dev'
 * 白名单为空时回退到 '*'（开发阶段）
 */
function getCorsHeaders(request) {
  const ALLOWED_ORIGINS = [
    //'https://your-project.pages.dev','https://your-custom-domain.com'
    // 如有自定义域名，在此添加
  ];
  const origin = request ? request.headers.get('Origin') : null;
  if (ALLOWED_ORIGINS.length > 0) {
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
    }
    return {}; // 不在白名单中，不返回 CORS 头
  }
  // 未配置白名单（开发阶段），回退到 '*'
  return { 'Access-Control-Allow-Origin': '*' };
}

function jsonResponse(data, corsHeaders, status = 200, rateLimitInfo = null) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...corsHeaders
  };
  if (rateLimitInfo) {
    headers['X-RateLimit-Limit'] = String(RATE_LIMIT_MAX_REQUESTS);
    headers['X-RateLimit-Remaining'] = String(rateLimitInfo.remaining);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(original, message, corsHeaders, status = 400) {
  return jsonResponse(
    { original: original || '', longUrl: '', status: 'ERROR', message },
    corsHeaders,
    status
  );
}

/**
 * 域名白名单校验 (Fix 1 & Fix 2)
 * 严格匹配 b23.tv / bilibili.com 及其子域名
 */
function isAllowedBilibiliHost(hostname) {
  const h = hostname.toLowerCase();
  return h === 'bilibili.com' || h.endsWith('.bilibili.com');
}

function isShortLinkHost(hostname) {
  const h = hostname.toLowerCase();
  return h === 'b23.tv' || h === 'www.b23.tv';
}

// ============================================================
// 速率限制 (Fix 11: 基于 IP 的滑动窗口速率限制)
// 使用内存 Map 在同一 isolate 生命周期内限流
// 注意：Cloudflare Workers isolate 可能被回收，此为尽力而为的限流
// 生产环境建议配合 Cloudflare Dashboard Rate Limiting 规则使用
// ============================================================
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 分钟窗口
const RATE_LIMIT_MAX_REQUESTS = 120;     // 每 IP 每分钟最多 120 次（覆盖 50 条批量 + 并发余量）

function checkRateLimit(clientIp) {
  const now = Date.now();
  const record = rateLimitMap.get(clientIp);

  if (!record) {
    rateLimitMap.set(clientIp, { count: 1, windowStart: now });
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
  }

  // 窗口过期，重置
  if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    record.count = 1;
    record.windowStart = now;
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
  }

  record.count++;
  const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - record.count);

  if (record.count > RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((record.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000) };
  }

  return { allowed: true, remaining };
}

// 定期清理过期记录，防止内存泄漏（每 100 次请求清理一次）
let requestCounter = 0;
function cleanupRateLimitMap() {
  requestCounter++;
  if (requestCounter % 100 !== 0) return;
  const now = Date.now();
  for (const [ip, record] of rateLimitMap) {
    if (now - record.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}

// ============================================================
// 主请求处理
// ============================================================

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const inputUrl = url.searchParams.get('url');
  const corsHeaders = getCorsHeaders(request);

  // 处理 CORS 预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  // Fix 9: 限制 HTTP 方法，仅允许 GET
  if (request.method !== 'GET') {
    return errorResponse('', '仅支持 GET 请求', corsHeaders, 405);
  }

  // Fix 11: 速率限制检查
  const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  cleanupRateLimitMap();
  const rateCheck = checkRateLimit(clientIp);

  if (!rateCheck.allowed) {
    return new Response(JSON.stringify({
      original: '', longUrl: '', status: 'ERROR',
      message: '请求过于频繁，请稍后再试'
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Retry-After': String(rateCheck.retryAfter),
        'X-RateLimit-Limit': String(RATE_LIMIT_MAX_REQUESTS),
        'X-RateLimit-Remaining': '0',
        ...corsHeaders
      }
    });
  }

  // Fix 3 (后端): URL 参数为空校验
  if (!inputUrl) {
    return errorResponse('', '缺少 url 参数', corsHeaders);
  }

  // Fix 3 (后端): URL 长度限制
  if (inputUrl.length > 2048) {
    return errorResponse('', 'URL 超出长度限制（最大 2048 字符）', corsHeaders);
  }

  // 验证 URL 格式
  let parsedInput;
  try {
    parsedInput = new URL(inputUrl);
  } catch (e) {
    return errorResponse(inputUrl, '无效的 URL 格式', corsHeaders);
  }

  // Fix 8: 强制 HTTPS 协议
  if (parsedInput.protocol !== 'https:') {
    return errorResponse(inputUrl, '仅支持 HTTPS 链接', corsHeaders);
  }

  // Fix 1: SSRF 防护 — 严格域名白名单
  const hostname = parsedInput.hostname.toLowerCase();
  const isShortLink = isShortLinkHost(hostname);
  const isBilibili = isAllowedBilibiliHost(hostname);

  if (!isShortLink && !isBilibili) {
    return errorResponse(inputUrl, '仅支持 b23.tv 和 bilibili.com 域名', corsHeaders);
  }

  try {
    let longUrl;

    if (isShortLink) {
      // b23.tv 短链：手动逐跳跟随重定向，校验每一跳的目标域名
      const MAX_REDIRECTS = 10;
      let currentUrl = inputUrl;

      for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
        const response = await fetch(currentUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
          },
          redirect: 'manual'
        });

        // 非重定向状态码，说明到达最终目标
        if (response.status < 300 || response.status >= 400) {
          // 最终 URL 就是 currentUrl（已经过校验）
          longUrl = currentUrl;
          break;
        }

        // 3xx 重定向：读取 Location 头
        const location = response.headers.get('Location');
        if (!location) {
          // 没有 Location 头，无法继续跟随
          longUrl = currentUrl;
          break;
        }

        // 解析下一跳 URL
        let nextUrl;
        try {
          nextUrl = new URL(location, currentUrl).href;
        } catch (e) {
          return jsonResponse({
            original: inputUrl,
            longUrl: location,
            status: 'ERROR',
            message: '解析重定向目标失败'
          }, corsHeaders);
        }

        // 校验下一跳域名：必须是 bilibili.com 或 b23.tv
        const nextHost = new URL(nextUrl).hostname.toLowerCase();
        if (!isAllowedBilibiliHost(nextHost) && !isShortLinkHost(nextHost)) {
          return jsonResponse({
            original: inputUrl,
            longUrl: nextUrl,
            status: 'INVALID',
            message: '跳转目标非 B 站域名'
          }, corsHeaders);
        }

        currentUrl = nextUrl;

        // 如果已经到达 bilibili.com 域名，不再继续跟随
        if (isAllowedBilibiliHost(nextHost)) {
          longUrl = currentUrl;
          break;
        }
      }

      // 仍然是短链，说明重定向失败或超过最大跳数
      if (!longUrl) {
        longUrl = currentUrl;
      }
      let longUrlIsShortLink = false;
      try { longUrlIsShortLink = isShortLinkHost(new URL(longUrl).hostname); } catch {}
      if (longUrlIsShortLink) {
        return jsonResponse({
          original: inputUrl,
          longUrl: longUrl,
          status: 'INVALID',
          message: '链接已失效或无法访问'
        }, corsHeaders);
      }

      // 最终校验重定向目标域名
      try {
        const redirectedUrl = new URL(longUrl);
        const rHost = redirectedUrl.hostname.toLowerCase();
        if (!isAllowedBilibiliHost(rHost)) {
          return jsonResponse({
            original: inputUrl,
            longUrl: longUrl,
            status: 'INVALID',
            message: '跳转目标非 B 站域名'
          }, corsHeaders);
        }
      } catch (e) {
        return jsonResponse({
          original: inputUrl,
          longUrl: longUrl,
          status: 'ERROR',
          message: '解析跳转目标失败'
        }, corsHeaders);
      }

      // 检查是否为 404 或被删除的页面
      if (longUrl.includes('/404') || longUrl.includes('/video/deleted')) {
        return jsonResponse({
          original: inputUrl,
          longUrl: longUrl,
          status: 'INVALID',
          message: '视频已被删除或不存在'
        }, corsHeaders);
      }
    } else {
      // 输入本身已经是 bilibili.com 长链，直接清洗
      longUrl = inputUrl;
    }

    // 清洗追踪参数
    const parsedUrl = new URL(longUrl);

    const trackingParams = [
      'spm_id_from', 'vd_source', 'share_source', 'share_medium',
      'share_plat', 'share_session_id', 'share_tag', 'up_id',
      'ts', 'buvid', 'is_story_h5', 'mid', 'plat_id', 'bbid',
      'unique_k', 'share_from', 'sterm', 'invite_code',
      'msource', 'from_source', 'from_spmid', '-Arouter',
      'spmid', 'timestamp'
    ];

    trackingParams.forEach(param => {
      parsedUrl.searchParams.delete(param);
    });

    // 删除空值参数（spread 避免迭代中修改集合）
    for (const [key] of [...parsedUrl.searchParams]) {
      if (!parsedUrl.searchParams.get(key)) {
        parsedUrl.searchParams.delete(key);
      }
    }

    longUrl = parsedUrl.toString();

    // 移除末尾的 ? 如果没有参数
    if (longUrl.endsWith('?')) {
      longUrl = longUrl.slice(0, -1);
    }

    if (isShortLink) {
      return jsonResponse({
        original: inputUrl,
        longUrl: longUrl,
        status: 'SUCCESS',
        message: '转换成功'
      }, corsHeaders);
    } else {
      return jsonResponse({
        original: inputUrl,
        longUrl: longUrl,
        status: 'CLEANED',
        message: '已清洗追踪参数'
      }, corsHeaders);
    }

  } catch (error) {
    // Fix 5: 错误信息脱敏 — 不暴露 error.message
    console.error('Convert error:', error);
    return jsonResponse({
      original: inputUrl,
      longUrl: '',
      status: 'ERROR',
      message: '解析失败，请稍后重试'
    }, corsHeaders);
  }
}
